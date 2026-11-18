import type { VaultItem } from "../types";

const PROJECT_ID = "apexaiautomation";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function toFsValue(v: unknown): unknown {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = toFsValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFsValue(v: any): unknown {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ("mapValue" in v) {
    const out: Record<string, unknown> = {};
    const fields = v.mapValue.fields || {};
    for (const [k, val] of Object.entries(fields)) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

function docToVaultItem(doc: any): VaultItem | null {
  const fields = doc.fields || {};
  const name: string = doc.name || "";
  const id = name.split("/").pop() || (fromFsValue(fields.serviceId) as string);
  if (!id) return null;
  return {
    serviceId: String(fromFsValue(fields.serviceId) || id),
    label: String(fromFsValue(fields.label) || ""),
    ciphertext: String(fromFsValue(fields.ciphertext) || ""),
    iv: String(fromFsValue(fields.iv) || ""),
    salt: String(fromFsValue(fields.salt) || ""),
    updatedAt: String(fromFsValue(fields.updatedAt) || ""),
  };
}

export async function listVaultItems(uid: string, token: string): Promise<VaultItem[]> {
  const url = `${BASE}/users/${encodeURIComponent(uid)}/vault`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Firestore list failed: ${res.status}`);
  const data = (await res.json()) as { documents?: any[] };
  return (data.documents || []).map(docToVaultItem).filter(Boolean) as VaultItem[];
}

export async function getVaultItem(uid: string, token: string, serviceId: string): Promise<VaultItem | null> {
  const url = `${BASE}/users/${encodeURIComponent(uid)}/vault/${encodeURIComponent(serviceId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get failed: ${res.status}`);
  const doc = await res.json();
  return docToVaultItem(doc);
}

export async function setVaultItem(uid: string, token: string, item: VaultItem): Promise<void> {
  const url = `${BASE}/users/${encodeURIComponent(uid)}/vault/${encodeURIComponent(item.serviceId)}`;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) fields[k] = toFsValue(v);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore set failed: ${res.status} ${text}`);
  }
}

/**
 * One copilot action-log record under `users/{uid}/copilotLog`.
 *
 * Firestore (not the Durable Object) because COPILOT.md logs are per-user and
 * need to outlive a single device; each record is tiny. A failure here is
 * logged and swallowed by the caller — a missing audit row must never block
 * the assistant's answer.
 */
export async function appendCopilotLog(
  uid: string,
  token: string,
  record: Record<string, unknown>,
): Promise<void> {
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const url = `${BASE}/users/${encodeURIComponent(uid)}/copilotLog?documentId=${encodeURIComponent(id)}`;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    fields[k] = toFsValue(v);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore copilot log failed: ${res.status} ${text}`);
  }
}

export async function deleteVaultItem(uid: string, token: string, serviceId: string): Promise<void> {
  const url = `${BASE}/users/${encodeURIComponent(uid)}/vault/${encodeURIComponent(serviceId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore delete failed: ${res.status}`);
}
