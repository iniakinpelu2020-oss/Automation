import type { Env, VaultItem } from "../types";
import { requireAuth } from "./auth";
import { encryptJSON, decryptJSON } from "./crypto";
import { deleteVaultItem, getVaultItem, listVaultItems, setVaultItem } from "./firestore";

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
      return json({ ok: true, serviceId: item.serviceId, label: item.label, updatedAt: item.updatedAt });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/vault/")) {
      const serviceId = decodeURIComponent(url.pathname.slice("/api/vault/".length));
      if (!serviceId) return json({ error: "serviceId required" }, 400);
      await deleteVaultItem(auth.uid, auth.token, serviceId);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vault error";
    return json({ error: message }, 500);
  }
}
