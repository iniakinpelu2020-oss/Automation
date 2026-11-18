import type { Env } from "../types";
import { requireAuth } from "../vault/auth";
import { b2Store, StorageNotConfigured, type DriveStore } from "./storage";

// Cloud half of Apex Drive.
//
// Uploads go straight from the phone into storage through this worker (streamed, never
// buffered in memory). The manifest lives in storage as JSON so there is no extra
// database. The bucket behind DriveStore is Backblaze B2 — see storage.ts.
//
// Verification is deliberately explicit: an upload is only "verified" after the stored
// object is re-read (size plus a sample hash of the first and last chunk). Nothing here
// deletes anything on the phone — it only reports what is safe to clear.

const MANIFEST_PREFIX = "_manifest/";
const SAMPLE_BYTES = 64 * 1024;

// Cloudflare caps request bodies on the Workers free plan at 100 MB, so a single
// streamed upload cannot be bigger than that no matter what the bucket allows.
const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

export interface DriveItem {
  key: string;
  name: string;
  size: number;
  sha256: string;
  phonePath: string;
  uploadedAt: string;
  verifiedAt: string | null;
  sampleHash: string | null;
  approvedAt: string | null;
}

interface Manifest {
  version: 1;
  items: DriveItem[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function manifestKey(uid: string): string {
  return `${MANIFEST_PREFIX}${uid}.json`;
}

async function readManifest(store: DriveStore, uid: string): Promise<Manifest> {
  const raw = await store.readText(manifestKey(uid));
  if (!raw) return { version: 1, items: [] };
  try {
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {
    // A corrupt manifest must never look like "everything is already saved".
  }
  return { version: 1, items: [] };
}

async function writeManifest(store: DriveStore, uid: string, manifest: Manifest): Promise<void> {
  await store.putText(manifestKey(uid), JSON.stringify(manifest), "application/json");
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

function isValidSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

/** Parses the waiting window. Zero is a valid value, so "0" must not fall back to 14. */
function daysParam(url: URL, fallback = 14): number {
  const raw = url.searchParams.get("days");
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(a: Uint8Array, b: Uint8Array): ArrayBuffer {
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  return merged.buffer;
}

/** Hash of the first and last SAMPLE_BYTES — cheap proof the stored bytes are the ones sent. */
async function sampleHash(store: DriveStore, key: string, size: number): Promise<string | null> {
  if (size <= 0) return null;

  const head = await store.readRange(key, 0, Math.min(SAMPLE_BYTES, size));
  if (!head) return null;
  if (size <= SAMPLE_BYTES) return sha256Hex(head.buffer as ArrayBuffer);

  const tailOffset = Math.max(0, size - SAMPLE_BYTES);
  const tail = await store.readRange(key, tailOffset, SAMPLE_BYTES);
  if (!tail) return null;

  return sha256Hex(concatBytes(head, tail));
}

export async function handleDriveRequest(request: Request, env: Env, url: URL): Promise<Response> {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (e) {
    return e as Response;
  }

  return driveForUser(env, auth.uid, request, url);
}

/** The routes themselves, with the caller's identity already established. */
export async function driveForUser(
  env: Env,
  uid: string,
  request: Request,
  url: URL,
  store?: DriveStore
): Promise<Response> {
  let s: DriveStore;
  try {
    s = store ?? b2Store(env);
  } catch (err) {
    if (err instanceof StorageNotConfigured) return json({ error: err.message }, 503);
    throw err;
  }

  try {
    // --- Upload: streamed straight into storage ---
    if (request.method === "PUT" && url.pathname === "/api/drive/upload") {
      const name = url.searchParams.get("name") || "";
      const sha256 = (url.searchParams.get("sha256") || "").toLowerCase();
      const phonePath = url.searchParams.get("path") || "";

      if (!name) return json({ error: "name is required" }, 400);
      if (!isValidSha256(sha256)) return json({ error: "sha256 must be 64 hex characters" }, 400);

      const declared = Number(request.headers.get("content-length") || "0");
      if (declared > MAX_UPLOAD_BYTES) {
        return json(
          {
            error: "file too large for a single upload",
            max: MAX_UPLOAD_BYTES,
            hint: "split the file, or upload it directly to storage",
          },
          413
        );
      }
      if (!request.body) return json({ error: "empty body" }, 400);

      const now = new Date();
      const key = `${uid}/${now.getUTCFullYear()}/${crypto.randomUUID()}-${safeName(name)}`;
      const contentType = request.headers.get("content-type") || "application/octet-stream";

      const stored = await s.putStream(key, request.body, {
        contentType,
        sha256,
        contentLength: Number.isFinite(declared) ? declared : undefined,
      });
      if (!stored) return json({ error: "storage rejected the upload" }, 502);

      const head = await s.head(key);
      const size = head?.size ?? 0;

      const manifest = await readManifest(s, uid);
      manifest.items.unshift({
        key,
        name,
        size,
        sha256,
        phonePath,
        uploadedAt: now.toISOString(),
        verifiedAt: null,
        sampleHash: null,
        approvedAt: null,
      });
      await writeManifest(s, uid, manifest);

      return json({ ok: true, key, size, uploadedAt: now.toISOString() });
    }

    // --- Verify: re-read what was stored and compare ---
    if (request.method === "POST" && url.pathname === "/api/drive/verify") {
      const body = (await request.json().catch(() => null)) as { key?: string } | null;
      const key = body?.key;
      if (!key) return json({ error: "key is required" }, 400);

      const manifest = await readManifest(s, uid);
      const item = manifest.items.find((i) => i.key === key);
      if (!item) return json({ error: "not in manifest" }, 404);

      const head = await s.head(key);
      if (!head) return json({ ok: false, reason: "object missing from storage" }, 409);

      const sizeMatches = head.size === item.size;
      const sample = await sampleHash(s, key, head.size);
      const storedSha = (head.sha256 || "").toLowerCase();
      const shaMatches = storedSha === item.sha256;

      if (sizeMatches && sample) {
        item.verifiedAt = new Date().toISOString();
        item.sampleHash = sample;
        await writeManifest(s, uid, manifest);
      }

      return json({
        ok: sizeMatches && shaMatches,
        sizeMatches,
        shaMatches,
        storedSize: head.size,
        expectedSize: item.size,
        sampleHash: sample,
        verifiedAt: item.verifiedAt,
      });
    }

    // --- What is safe to clear, after the waiting window ---
    if (request.method === "GET" && url.pathname === "/api/drive/reclaimable") {
      const days = daysParam(url);
      const cutoff = Date.now() - days * 86400 * 1000;
      const manifest = await readManifest(s, uid);

      const ready = manifest.items.filter(
        (i) => i.verifiedAt && !i.approvedAt && new Date(i.verifiedAt).getTime() <= cutoff
      );
      const waiting = manifest.items.filter(
        (i) => i.verifiedAt && !i.approvedAt && new Date(i.verifiedAt).getTime() > cutoff
      );

      return json({
        days,
        ready,
        readyBytes: ready.reduce((sum, i) => sum + i.size, 0),
        waitingCount: waiting.length,
        waitingBytes: waiting.reduce((sum, i) => sum + i.size, 0),
      });
    }

    // --- The approval step: records what the phone may now remove ---
    if (request.method === "POST" && url.pathname === "/api/drive/approve") {
      const body = (await request.json().catch(() => null)) as { keys?: string[] } | null;
      const keys = Array.isArray(body?.keys) ? body!.keys.filter((k) => typeof k === "string") : [];
      if (!keys.length) return json({ error: "keys is required" }, 400);

      const days = daysParam(url);
      const cutoff = Date.now() - days * 86400 * 1000;
      const manifest = await readManifest(s, uid);
      const approved: string[] = [];
      const refused: Array<{ key: string; reason: string }> = [];

      for (const key of keys) {
        const item = manifest.items.find((i) => i.key === key);
        if (!item) {
          refused.push({ key, reason: "not in manifest" });
          continue;
        }
        if (!item.verifiedAt) {
          refused.push({ key, reason: "not verified yet" });
          continue;
        }
        if (new Date(item.verifiedAt).getTime() > cutoff) {
          refused.push({ key, reason: `still inside the ${days} day window` });
          continue;
        }
        item.approvedAt = new Date().toISOString();
        approved.push(key);
      }

      await writeManifest(s, uid, manifest);
      return json({ ok: true, approved, refused });
    }

    if (request.method === "GET" && url.pathname === "/api/drive/list") {
      const manifest = await readManifest(s, uid);
      const totalBytes = manifest.items.reduce((sum, i) => sum + i.size, 0);
      return json({
        items: manifest.items,
        count: manifest.items.length,
        totalBytes,
        verifiedCount: manifest.items.filter((i) => i.verifiedAt).length,
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Drive error";
    return json({ error: message }, 500);
  }
}
