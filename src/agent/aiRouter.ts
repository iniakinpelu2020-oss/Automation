import type { Env } from "../types";
import { getVaultCredential } from "../vault";

export type AIProvider = "auto" | "gemini-flash" | "gemini-pro" | "groq" | "openrouter" | "cloudflare" | "custom";

export interface AISettings {
  provider?: AIProvider;
  customModelId?: string;
  geminiModel?: string;
}

export interface AIRequestOptions {
  messages: Array<{ role: string; content: string }>;
  provider?: AIProvider;
  model?: string; // custom or explicit model id
  jsonMode?: boolean;
  temperature?: number;
}

export interface AIResult {
  text: string;
  provider: string; // display provider name
  model: string;
  badge: string; // e.g. "⚡ Gemini 3 Flash"
  raw?: unknown;
  failoverReasons?: string[];
}

function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return m[1].trim();
  // sometimes fences appear without full wrap
  return t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

async function readKey(env: Env, uid: string, token: string, serviceId: string, fields: string[]): Promise<string | null> {
  try {
    const cred = await getVaultCredential(env, uid, token, serviceId) as any;
    if (!cred) return null;
    for (const f of fields) {
      const v = cred[f];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {}
  return null;
}

// Google retires/renames preview model ids regularly; retry stable names on 400/404
// instead of silently falling through to the last-resort Llama model.
const GEMINI_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];

function geminiBadge(model: string): string {
  if (model.includes("flash")) return "⚡ Gemini 3 Flash";
  if (model.includes("pro")) return "🧠 Gemini 3.1 Pro";
  return `✨ Gemini (${model})`;
}

async function callGemini(apiKey: string, modelId: string, messages: Array<{role:string;content:string}>, jsonMode?: boolean): Promise<{text:string; model:string}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
  const systemParts = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const contents = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const body: any = { contents };
  if (systemParts) body.systemInstruction = { parts: [{ text: systemParts }] };
  body.generationConfig = { temperature: 0.4 };
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    const err: any = new Error(`Gemini ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
  return { text, model: modelId };
}

async function callGroq(apiKey: string, model: string, messages: Array<{role:string;content:string}>, jsonMode?: boolean): Promise<{text:string; model:string}> {
  const body: any = { model, messages, temperature: 0.4 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    const err: any = new Error(`Groq ${res.status}: ${msg}`); err.status = res.status; throw err;
  }
  const text = data?.choices?.[0]?.message?.content || "";
  return { text, model };
}

async function callOpenRouter(apiKey: string, model: string, messages: Array<{role:string;content:string}>, jsonMode?: boolean): Promise<{text:string; model:string}> {
  const body: any = { model, messages, temperature: 0.4 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 300);
    const err: any = new Error(`OpenRouter ${res.status}: ${msg}`); err.status = res.status; throw err;
  }
  const text = data?.choices?.[0]?.message?.content || "";
  return { text, model };
}

async function callCloudflare(env: Env, model: string, messages: Array<{role:string;content:string}>): Promise<{text:string; model:string}> {
  const modelId = model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  let res: any;
  try {
    res = await env.AI.run(modelId as any, { messages });
  } catch {
    res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages });
  }
  const text = typeof res === "object" && res && "response" in res ? String(res.response) : JSON.stringify(res);
  return { text, model: modelId };
}

function shouldFailoverGemini(err: any): boolean {
  const s = err?.status; return s === 404 || s === 429 || s === 401 || s === 403 || s === 503;
}

export async function runAI(env: Env, uid: string, token: string, opts: AIRequestOptions): Promise<AIResult> {
  const provider = (opts.provider || "auto") as AIProvider;
  const customModel = (opts.model || "").trim();
  const messages = opts.messages;
  const jsonMode = !!opts.jsonMode;
  const reasons: string[] = [];

  // load keys from vault (and settings)
  let settings: AISettings = {};
  try { const s = await getVaultCredential(env, uid, token, "ai_settings") as any; if (s) settings = s as AISettings; } catch {}
  const geminiKey = await readKey(env, uid, token, "gemini", ["apiKey", "key", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) || await readKey(env, uid, token, "google_ai", ["apiKey", "key"]);
  const groqKey = await readKey(env, uid, token, "groq", ["apiKey", "key", "GROQ_API_KEY"]);
  const openrouterKey = await readKey(env, uid, token, "openrouter", ["apiKey", "key", "OPENROUTER_API_KEY"]);

  // An explicit pick in the chat selector wins; otherwise honour the provider
  // saved in Settings (the chat selector itself defaults to "auto").
  const effectiveProvider: AIProvider =
    opts.provider && opts.provider !== "auto"
      ? opts.provider
      : ((settings.provider as AIProvider) || "auto");
  const effectiveCustom = customModel || settings.customModelId || "";

  const tryGemini = async (modelId: string): Promise<AIResult> => {
    if (!geminiKey) throw Object.assign(new Error("Gemini key not configured"), { status: 401, skip: true });
    const chain = [modelId, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== modelId)];
    let lastErr: any = null;
    for (const id of chain) {
      try {
        const r = await callGemini(geminiKey, id, messages, jsonMode);
        return { text: jsonMode ? stripFences(r.text) : r.text, provider: "gemini", model: r.model, badge: geminiBadge(r.model) };
      } catch (e: any) {
        lastErr = e;
        if (e?.status !== 400 && e?.status !== 404) throw e;
      }
    }
    throw lastErr;
  };
  const tryGroq = async (modelId?: string): Promise<AIResult> => {
    if (!groqKey) throw Object.assign(new Error("Groq key not configured"), { status: 401, skip: true });
    const m = modelId || "llama-3.3-70b-versatile";
    const r = await callGroq(groqKey, m, messages, jsonMode);
    return { text: jsonMode ? stripFences(r.text) : r.text, provider: "groq", model: r.model, badge: "🟠 Groq (Llama 3.3 70B)" };
  };
  const tryOpenRouter = async (modelId?: string): Promise<AIResult> => {
    if (!openrouterKey) throw Object.assign(new Error("OpenRouter key not configured"), { status: 401, skip: true });
    const m = modelId || "openai/gpt-4o-mini";
    const r = await callOpenRouter(openrouterKey, m, messages, jsonMode);
    return { text: jsonMode ? stripFences(r.text) : r.text, provider: "openrouter", model: r.model, badge: `🌐 OpenRouter (${r.model})` };
  };
  const tryCF = async (modelId?: string): Promise<AIResult> => {
    const m = modelId || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const r = await callCloudflare(env, m, messages);
    return { text: jsonMode ? stripFences(r.text) : r.text, provider: "cloudflare", model: r.model, badge: "☁️ Workers AI" };
  };

  // explicit provider selections
  if (effectiveProvider === "gemini-flash") {
    try { return await tryGemini(effectiveCustom || "gemini-3-flash-preview"); }
    catch (e:any) { reasons.push(`Gemini: ${e.message}`); console.warn("Gemini failover", e.message); }
  } else if (effectiveProvider === "gemini-pro") {
    try { return await tryGemini(effectiveCustom || "gemini-3.1-pro-preview"); }
    catch (e:any) { reasons.push(`Gemini: ${e.message}`); console.warn("Gemini failover", e.message); }
  } else if (effectiveProvider === "groq") {
    try { return await tryGroq(effectiveCustom || undefined); } catch (e:any) { reasons.push(`Groq: ${e.message}`); }
  } else if (effectiveProvider === "openrouter") {
    try { return await tryOpenRouter(effectiveCustom || undefined); } catch (e:any) { reasons.push(`OpenRouter: ${e.message}`); }
  } else if (effectiveProvider === "cloudflare") {
    return { ...(await tryCF(effectiveCustom || undefined)), failoverReasons: reasons };
  } else if (effectiveProvider === "custom" && effectiveCustom) {
    // heuristic: try gemini if key and model looks like gemini, else openrouter/groq/cf
    if (geminiKey && /gemini/i.test(effectiveCustom)) { try { return await tryGemini(effectiveCustom); } catch(e:any){ reasons.push(`Gemini: ${e.message}`);} }
    if (groqKey) { try { return await tryGroq(effectiveCustom); } catch(e:any){ reasons.push(`Groq: ${e.message}`);} }
    if (openrouterKey) { try { return await tryOpenRouter(effectiveCustom); } catch(e:any){ reasons.push(`OpenRouter: ${e.message}`);} }
    return { ...(await tryCF(effectiveCustom)), failoverReasons: reasons };
  }

  // Auto chain: Gemini (flash) -> Groq -> OpenRouter -> Cloudflare
  // if explicit gemini selected above and failed with failover-worthy error, continue chain
  const geminiModel = effectiveProvider === "gemini-pro" ? (effectiveCustom || "gemini-3.1-pro-preview") : (effectiveCustom && effectiveProvider.startsWith("gemini") ? effectiveCustom : "gemini-3-flash-preview");
  if (effectiveProvider === "auto" || effectiveProvider.startsWith("gemini")) {
    try {
      const r = await tryGemini(geminiModel);
      r.failoverReasons = reasons; return r;
    } catch (e:any) {
      const reason = `Gemini ${e.status || ""}: ${e.message}`;
      reasons.push(reason);
      console.warn("Gemini failover -> next provider. Reason:", reason);
      if (!(effectiveProvider === "auto" || shouldFailoverGemini(e) || e.skip)) {
        // non-auto explicit non-failover shouldn't happen here; but continue
      }
    }
  }
  try { const r = await tryGroq(); r.failoverReasons = reasons; return r; } catch(e:any){ reasons.push(`Groq: ${e.message}`); console.warn("Groq failover", e.message); }
  try { const r = await tryOpenRouter(); r.failoverReasons = reasons; return r; } catch(e:any){ reasons.push(`OpenRouter: ${e.message}`); console.warn("OpenRouter failover", e.message); }
  const cf = await tryCF(); cf.failoverReasons = reasons; return cf;
}
