import type { AuthContext, FirebaseTokenPayload } from "../types";

const PROJECT_ID = "apexaiautomation";
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

let jwksCache: { keys: JsonWebKey[]; expiresAt: number } | null = null;

function base64UrlDecode(input: string): Uint8Array {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodePart<T>(part: string): T {
  const bytes = base64UrlDecode(part);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function getJwks(): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error("Failed to fetch JWKS");
  const data = (await res.json()) as { keys: JsonWebKey[] };
  const cacheControl = res.headers.get("cache-control") || "";
  const match = cacheControl.match(/max-age=(\d+)/);
  const maxAge = match ? parseInt(match[1], 10) * 1000 : 3600 * 1000;
  jwksCache = { keys: data.keys, expiresAt: now + maxAge };
  return data.keys;
}

export async function verifyFirebaseToken(token: string): Promise<FirebaseTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  const header = decodePart<{ alg: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token header");
  const payload = decodePart<FirebaseTokenPayload>(parts[1]);
  if (payload.aud !== PROJECT_ID) throw new Error("Invalid audience");
  if (payload.iss !== ISSUER) throw new Error("Invalid issuer");
  const now = Math.floor(Date.now() / 1000);
  if (!payload.sub) throw new Error("Missing subject");
  if (payload.exp && payload.exp < now) throw new Error("Token expired");
  if (payload.iat && payload.iat > now + 300) throw new Error("Token issued in future");

  const keys = await getJwks();
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new Error("Matching JWK not found");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = base64UrlDecode(parts[2]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!ok) throw new Error("Invalid token signature");
  return payload;
}

export async function requireAuth(request: Request): Promise<AuthContext> {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Response("Unauthorized", { status: 401 });
  const token = auth.slice("Bearer ".length).trim();
  try {
    const payload = await verifyFirebaseToken(token);
    const uid = payload.sub || payload.user_id;
    if (!uid) throw new Error("Missing uid");
    return { uid, email: payload.email, token };
  } catch {
    throw new Response("Unauthorized", { status: 401 });
  }
}
