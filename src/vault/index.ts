import type { Env, VaultItem } from "../types";
import { requireAuth } from "./auth";
import { encryptJSON, decryptJSON } from "./crypto";
import { deleteVaultItem, getVaultItem, listVaultItems, setVaultItem } from "./firestore";
import { getOfflineItem, listOffline, mirrorItem, offlineEligibleList, removeMirror, revokeAllOffline } from "./offline";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function getVaultCredential<T = Record<string, unknown>>(
  env: Env,
  uid: string,
  token: string,
  serviceId: string,
): Promise<T | null> {
  // No user session (a cron/scheduled run): fall back to the encrypted offline copy
  // stored in the user's Durable Object, which is sealed with the same ENCRYPTION_SECRET.
  if (!token) {
    const offline = await getOfflineItem(env, uid, serviceId);
    if (!offline) return null;
    return decryptJSON<T>(env.ENCRYPTION_SECRET, {
      ciphertext: offline.ciphertext,
      iv: offline.iv,
      salt: offline.salt,
    });
  }

  const item = await getVaultItem(uid, token, serviceId);
  if (!item) return null;
  return decryptJSON<T>(env.ENCRYPTION_SECRET, {
    ciphertext: item.ciphertext,
    iv: item.iv,
    salt: item.salt,
  });
}

export async function handleVaultRequest(request: Request, env: Env, url: URL): Promise<Response> {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (e) {
    return e as Response;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/vault") {
      const items = await listVaultItems(auth.uid, auth.token);
      return json(items.map((i) => ({ serviceId: i.serviceId, label: i.label, updatedAt: i.updatedAt })));
    }

    // Which keys are currently available to scheduled runs, and how to revoke them.
    if (request.method === "GET" && url.pathname === "/api/vault/offline") {
      const keys = await listOffline(env, auth.uid);
      return json({ keys, eligible: offlineEligibleList() });
    }

    if (request.method === "DELETE" && url.pathname === "/api/vault/offline") {
      await revokeAllOffline(env, auth.uid);
      return json({ ok: true, revoked: true });
    }

    if (request.method === "POST" && url.pathname === "/api/vault") {
      const body = (await request.json()) as { serviceId?: string; label?: string; secretData?: unknown };
      if (!body.serviceId || !body.label || !body.secretData || typeof body.secretData !== "object") {
        return json({ error: "serviceId, label, and secretData are required" }, 400);
      }
      const enc = await encryptJSON(env.ENCRYPTION_SECRET, body.secretData);
      const item: VaultItem = {
        serviceId: body.serviceId,
        label: body.label,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        salt: enc.salt,
        updatedAt: new Date().toISOString(),
      };
      await setVaultItem(auth.uid, auth.token, item);
      // Keep the cron-usable copy in step with the vault for eligible services.
      try {
        await mirrorItem(env, auth.uid, item);
      } catch (err) {
        console.error("offline mirror failed", err instanceof Error ? err.message : err);
      }
      return json({ ok: true, serviceId: item.serviceId, label: item.label, updatedAt: item.updatedAt });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/vault/")) {
      const serviceId = decodeURIComponent(url.pathname.slice("/api/vault/".length));
      if (!serviceId) return json({ error: "serviceId required" }, 400);
      await deleteVaultItem(auth.uid, auth.token, serviceId);
      try {
        await removeMirror(env, auth.uid, serviceId);
      } catch (err) {
        console.error("offline mirror removal failed", err instanceof Error ? err.message : err);
      }
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vault error";
    return json({ error: message }, 500);
  }
}
