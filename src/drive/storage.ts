import type { Env } from "../types";
import { signRequest } from "./sigv4";

// Storage for Apex Drive.
//
// This talks to Backblaze B2 through its S3-compatible API, because B2 gives 10 GB
// free without a billing method whereas R2 will not switch on without a card.
// The rest of the drive code only knows about the DriveStore interface below, so the
// vendor can be swapped again without touching the routes.
//
// Uploads are streamed, never buffered: the body is signed as "UNSIGNED-PAYLOAD",
// which is what Backblaze's own Cloudflare Worker sample does and the only way to sign
// a body whose length is not known up front.

export class StorageNotConfigured extends Error {}

export interface StoredHead {
  size: number;
  sha256: string | null;
}

export interface DriveStore {
  putStream(
    key: string,
    body: ReadableStream,
    opts: { contentType: string; sha256: string; contentLength?: number }
  ): Promise<boolean>;
  putText(key: string, text: string, contentType: string): Promise<void>;
  head(key: string): Promise<StoredHead | null>;
  readRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  readText(key: string): Promise<string | null>;
}

/**
 * A B2 endpoint host looks like s3.us-west-004.backblazeb2.com, and the signature must
 * name the same region that appears there.
 */
function regionFromEndpoint(endpoint: string): string {
  const host = endpoint.replace(/^https?:\/\//, "").split("/")[0] || "";
  const parts = host.split(".");
  if (parts[0] === "s3" && parts.length > 2) return parts[1];
  return "us-west-004";
}

export function b2Store(env: Env): DriveStore {
  const endpoint = (env.DRIVE_B2_ENDPOINT || "").trim().replace(/\/+$/, "");
  const bucket = (env.DRIVE_B2_BUCKET || "").trim();
  const accessKeyId = (env.DRIVE_B2_KEY_ID || "").trim();
  const secretAccessKey = (env.DRIVE_B2_APP_KEY || "").trim();

  const missing = [
    !endpoint && "DRIVE_B2_ENDPOINT",
    !bucket && "DRIVE_B2_BUCKET",
    !accessKeyId && "DRIVE_B2_KEY_ID",
    !secretAccessKey && "DRIVE_B2_APP_KEY",
  ].filter(Boolean) as string[];

  if (missing.length) {
    throw new StorageNotConfigured(`drive storage is not configured (missing ${missing.join(", ")})`);
  }

  const region = (env.DRIVE_B2_REGION || "").trim() || regionFromEndpoint(endpoint);

  // Object keys keep their slashes; each segment is percent-encoded so names with
  // spaces or unicode survive the round trip.
  const objectUrl = (key: string): string =>
    `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function send(
    method: string,
    url: string,
    headers: Record<string, string>,
    payloadHash: string,
    body?: ReadableStream | string
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers,
      payloadHash,
      accessKeyId,
      secretAccessKey,
      region,
    });
    return fetch(signed.url, {
      method,
      headers: signed.headers,
      body: body as BodyInit | undefined,
    });
  }

  async function fail(res: Response, what: string): Promise<Response> {
    if (!res.ok && res.status !== 404) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`storage ${what} failed: ${res.status} ${detail}`.trim());
    }
    return res;
  }

  return {
    async putStream(key, body, opts) {
      const headers: Record<string, string> = {
        "content-type": opts.contentType,
        "x-amz-meta-sha256": opts.sha256,
      };
      // The length is not part of the signature; it is sent so the connection is framed.
      if (opts.contentLength && opts.contentLength > 0) {
        headers["content-length"] = String(opts.contentLength);
      }
      const res = await send("PUT", objectUrl(key), headers, "UNSIGNED-PAYLOAD", body);
      await fail(res, "upload");
      return res.ok;
    },

    async putText(key, text, contentType) {
      const res = await send(
        "PUT",
        objectUrl(key),
        { "content-type": contentType },
        await sha256Hex(text),
        text
      );
      await fail(res, "write");
    },

    async head(key) {
      const res = await send("HEAD", objectUrl(key), {}, "UNSIGNED-PAYLOAD");
      if (res.status === 404) return null;
      await fail(res, "head");
      const size = Number(res.headers.get("content-length") || "0");
      return {
        size: Number.isFinite(size) ? size : 0,
        sha256: res.headers.get("x-amz-meta-sha256"),
      };
    },

    async readRange(key, offset, length) {
      const res = await send(
        "GET",
        objectUrl(key),
        { range: `bytes=${offset}-${offset + length - 1}` },
        "UNSIGNED-PAYLOAD"
      );
      if (res.status === 404) return null;
      await fail(res, "read");
      if (res.status !== 206 && res.status !== 200) return null;
      return new Uint8Array(await res.arrayBuffer());
    },

    async readText(key) {
      const res = await send("GET", objectUrl(key), {}, "UNSIGNED-PAYLOAD");
      if (res.status === 404) return null;
      await fail(res, "read");
      return await res.text();
    },
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
