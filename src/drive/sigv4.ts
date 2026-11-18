// Minimal AWS Signature Version 4 signer (header-based), for S3-compatible APIs.
//
// Written by hand rather than pulled in as a dependency: it is a few dozen lines of
// HMAC, and the deployed worker only has to talk to one endpoint. Verified against the
// published AWS example (GET /test.txt on examplebucket) in the tests.

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

/** RFC 3986 escaping: encodeURIComponent leaves !'()* unescaped, S3 does not accept that. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export interface SignInput {
  method: string;
  url: string;
  /** Headers to sign. Do not pass host: it is taken from the URL and never sent. */
  headers: Record<string, string>;
  /** Hex sha256 of the body, or "UNSIGNED-PAYLOAD" for a streamed upload. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now?: Date;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export async function signRequest(input: SignInput): Promise<SignedRequest> {
  const url = new URL(input.url);
  const service = input.service || "s3";
  const now = input.now || new Date();
  const amzDate = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const signed: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    signed[name.toLowerCase()] = value.trim();
  }
  // host is part of the signature but is supplied by the runtime, not set by us
  signed["host"] = url.host;
  signed["x-amz-date"] = amzDate;
  signed["x-amz-content-sha256"] = input.payloadHash;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join("");
  const signedHeaders = names.join(";");

  // The path is already percent-encoded when the URL was built, so it is used as-is.
  const canonicalUri = url.pathname || "/";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), dateStamp);
  key = await hmac(key, input.region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  return {
    url: input.url,
    headers: {
      ...input.headers,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": input.payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
