import type { Env, AuthContext } from "../types";
import { requireAuth } from "./auth";
import { encryptJSON, decryptJSON } from "./crypto";
import { setVaultItem, getVaultItem } from "./firestore";

const BASE_URL = "https://automation.iniakinpelu2020.workers.dev";
const REDIRECT_URI = `${BASE_URL}/api/oauth/google/callback`;

const SCOPES: Record<string, string[]> = {
  youtube: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube"],
  gmail: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.compose"],
  drive: ["https://www.googleapis.com/auth/drive.file"],
  sheets: ["https://www.googleapis.com/auth/spreadsheets"],
};

function b64url(bytes: Uint8Array): string {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signState(secret: string, payload: Record<string, unknown>): Promise<string> {
  const data = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
async function verifyState(secret: string, state: string): Promise<any | null> {
  const [data, sig] = state.split(".");
  if (!data || !sig) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), new TextEncoder().encode(data));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(fromB64url(data))); } catch { return null; }
}

export function googleOAuthConfigured(env: Env): boolean {
  return !!((env as any).GOOGLE_CLIENT_ID && (env as any).GOOGLE_CLIENT_SECRET);
}

export async function handleOAuthStart(request: Request, env: Env, url: URL): Promise<Response> {
  let auth: AuthContext;
  try { auth = await requireAuth(request); } catch (e) { return e as Response; }
  const service = (url.searchParams.get("service") || "").toLowerCase();
  if (!SCOPES[service]) return new Response("Unsupported Google service", { status: 400 });
  const clientId = (env as any).GOOGLE_CLIENT_ID as string | undefined;
  const clientSecret = (env as any).GOOGLE_CLIENT_SECRET as string | undefined;
  if (!clientId || !clientSecret) {
    return Response.json({ error: "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Worker secrets." }, { status: 400 });
  }
  const state = await signState(env.ENCRYPTION_SECRET, { uid: auth.uid, service, token: auth.token, ts: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES[service].join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
}

export async function handleOAuthCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return htmlPage("Google sign-in cancelled", `<p>${escapeHtml(err)}</p>`, false);
  if (!code || !stateParam) return htmlPage("OAuth error", "<p>Missing code or state.</p>", false);
  const st = await verifyState(env.ENCRYPTION_SECRET, stateParam);
  if (!st || !st.uid || !st.service) return htmlPage("OAuth error", "<p>Invalid or expired state.</p>", false);
  const clientId = (env as any).GOOGLE_CLIENT_ID as string | undefined;
  const clientSecret = (env as any).GOOGLE_CLIENT_SECRET as string | undefined;
  if (!clientId || !clientSecret) return htmlPage("OAuth not configured", "<p>Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.</p>", false);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
  });
  const tokenData = await tokenRes.json() as any;
  if (!tokenRes.ok) return htmlPage("Token exchange failed", `<pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre>`, false);

  const serviceId = `google_${st.service}`;
  const secretData = {
    provider: "google",
    service: st.service,
    access_token: tokenData.access_token || "",
    refresh_token: tokenData.refresh_token || "",
    token_type: tokenData.token_type || "Bearer",
    scope: tokenData.scope || "",
    expires_in: tokenData.expires_in || 3600,
    obtained_at: Date.now(),
  };
  // Try to persist server-side to Firestore vault using the user's token from state (if still valid)
  let saved = false;
  try {
    const enc = await encryptJSON(env.ENCRYPTION_SECRET, secretData);
    const item = { serviceId, label: `Google ${st.service.charAt(0).toUpperCase()+st.service.slice(1)}`, ciphertext: enc.ciphertext, iv: enc.iv, salt: enc.salt, updatedAt: new Date().toISOString() };
    if (st.token) {
      await setVaultItem(st.uid, st.token, item);
      saved = true;
    }
  } catch { saved = false; }

  const payload = JSON.stringify({ type: "oauth-success", serviceId, service: st.service, saved, secretData });
  return htmlPage(
    saved ? "Connected!" : "Almost connected",
    `<p>${saved ? `Google ${escapeHtml(st.service)} connected and saved to your vault.` : `Google ${escapeHtml(st.service)} authorized. Finalizing connection...`}</p>
     <p style="color:#9ca3af;font-size:13px">This window will close automatically.</p>
     <script>
       (function(){
         try {
           if (window.opener) { window.opener.postMessage(${payload}, "*"); }
         } catch(e){}
         setTimeout(function(){ window.close(); }, 1200);
       })();
     </script>`,
    true
  );
}

function escapeHtml(s: string) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c)); }
function htmlPage(title: string, body: string, ok: boolean): Response {
  const color = ok ? "#10b981" : "#ef4444";
  return new Response(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title>
  <style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#18181b;color:#e5e7eb;font-family:ui-sans-serif,system-ui}.card{background:#222226;border:1px solid #333;border-radius:16px;padding:28px;max-width:520px;width:92%}h1{margin:0 0 8px;font-size:20px;color:${color}}pre{white-space:pre-wrap;word-break:break-word;background:#111;padding:10px;border-radius:8px}</style></head>
  <body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function getValidGoogleAccessToken(env: Env, uid: string, token: string, service: string): Promise<string | null> {
  const serviceId = service.startsWith("google_") ? service : `google_${service}`;
  const item = await getVaultItem(uid, token, serviceId);
  if (!item) return null;
  const data = await decryptJSON(env.ENCRYPTION_SECRET, { ciphertext: item.ciphertext, iv: item.iv, salt: item.salt }) as any;
  if (!data) return null;
  const obtained = Number(data.obtained_at || 0);
  const expiresIn = Number(data.expires_in || 3600);
  const expired = obtained && (Date.now() > obtained + (expiresIn - 60) * 1000);
  if (data.access_token && !expired) return String(data.access_token);
  // refresh
  const clientId = (env as any).GOOGLE_CLIENT_ID as string | undefined;
  const clientSecret = (env as any).GOOGLE_CLIENT_SECRET as string | undefined;
  if (!clientId || !clientSecret || !data.refresh_token) return data.access_token ? String(data.access_token) : null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: String(data.refresh_token), grant_type: "refresh_token" }),
  });
  const refreshed = await res.json() as any;
  if (!res.ok || !refreshed.access_token) return data.access_token ? String(data.access_token) : null;
  const updated = { ...data, access_token: refreshed.access_token, expires_in: refreshed.expires_in || expiresIn, obtained_at: Date.now() };
  try {
    const enc = await encryptJSON(env.ENCRYPTION_SECRET, updated);
    await setVaultItem(uid, token, { serviceId, label: item.label || `Google ${service}`, ciphertext: enc.ciphertext, iv: enc.iv, salt: enc.salt, updatedAt: new Date().toISOString() });
  } catch {}
  return String(updated.access_token);
}
