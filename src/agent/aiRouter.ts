import type { Env } from "../types";
import { getVaultCredential } from "../vault";
import {
  GEMINI_FALLBACK_MODELS,
  GEMINI_FLASH_DEFAULT,
  GEMINI_PRO_DEFAULT,
  callCloudflare,
  callGemini,
  callGroq,
  callOpenRouter,
  geminiBadge,
  readKey,
  shouldFailoverGemini,
  stripFences,
} from "./providers";

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

export async function runAI(env: Env, uid: string, token: string, opts: AIRequestOptions): Promise<AIResult> {
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
    try { return await tryGemini(effectiveCustom || GEMINI_FLASH_DEFAULT); }
    catch (e:any) { reasons.push(`Gemini: ${e.message}`); console.warn("Gemini failover", e.message); }
  } else if (effectiveProvider === "gemini-pro") {
    try { return await tryGemini(effectiveCustom || GEMINI_PRO_DEFAULT); }
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
  const geminiModel = effectiveProvider === "gemini-pro" ? (effectiveCustom || GEMINI_PRO_DEFAULT) : (effectiveCustom && effectiveProvider.startsWith("gemini") ? effectiveCustom : GEMINI_FLASH_DEFAULT);
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
