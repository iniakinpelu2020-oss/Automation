import type { Env, VaultItem } from "../types";

// Vault items that a scheduled run may need. Everything else stays Firestore-only.
const OFFLINE_SERVICES = new Set([
  "gemini",
  "google_ai",
  "groq",
  "openrouter",
  "ai_settings",
]);

export function isOfflineEligible(serviceId: string): boolean {
  return OFFLINE_SERVICES.has(serviceId);
}

export function offlineEligibleList(): string[] {
  return [...OFFLINE_SERVICES];
}

function stub(env: Env, uid: string) {
  return env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
}

/**
 * Copies a vault entry into the user's Durable Object as a cron-usable copy.
 * The blob is already AES-GCM encrypted with ENCRYPTION_SECRET, so it is copied
 * verbatim: no plaintext ever exists in this path.
 */
export async function mirrorItem(env: Env, uid: string, item: VaultItem): Promise<void> {
  if (!isOfflineEligible(item.serviceId)) return;
  await stub(env, uid).fetch("https://do/offline-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serviceId: item.serviceId,
      label: item.label,
      ciphertext: item.ciphertext,
      iv: item.iv,
      salt: item.salt,
    }),
  });
}

export async function removeMirror(env: Env, uid: string, serviceId: string): Promise<void> {
  if (!isOfflineEligible(serviceId)) return;
  await stub(env, uid).fetch("https://do/offline-keys/" + encodeURIComponent(serviceId), {
    method: "DELETE",
  });
}

export interface OfflineItem {
  serviceId: string;
  label: string;
  ciphertext: string;
  iv: string;
  salt: string;
  updatedAt: string;
}

export async function getOfflineItem(env: Env, uid: string, serviceId: string): Promise<OfflineItem | null> {
  const res = await stub(env, uid).fetch("https://do/offline-keys/" + encodeURIComponent(serviceId));
  if (!res.ok) return null;
  return (await res.json()) as OfflineItem;
}

export async function listOffline(env: Env, uid: string): Promise<Array<{ serviceId: string; label: string; updatedAt: string }>> {
  const res = await stub(env, uid).fetch("https://do/offline-keys");
  if (!res.ok) return [];
  const data = (await res.json()) as { keys?: Array<{ serviceId: string; label: string; updatedAt: string }> };
  return data.keys || [];
}

export async function revokeAllOffline(env: Env, uid: string): Promise<void> {
  await stub(env, uid).fetch("https://do/offline-keys", { method: "DELETE" });
}
