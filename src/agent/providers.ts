import type { Env } from "../types";
import { getVaultCredential } from "../vault";
import { coerceText } from "./text";

export function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return m[1].trim();
  // sometimes fences appear without full wrap
  return t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

export async function readKey(env: Env, uid: string, token: string, serviceId: string, fields: string[]): Promise<string | null> {
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
// Gemini 2.x is retired on the Developer API as of November 2026 (2.5 Flash is limited
// to projects that used it before and is re-routed from 1 Dec 2026), so the fallbacks
// are current stable flashes only.
export const GEMINI_FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
export const GEMINI_FLASH_DEFAULT = "gemini-3.8-flash";
export const GEMINI_PRO_DEFAULT = "gemini-3.1-pro-preview";

export function geminiBadge(model: string): string {
  const version = model.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || "3";
  if (model.includes("pro")) return `🧠 Gemini ${version} Pro`;
  if (model.includes("flash") && model.includes("lite")) return `⚡ Gemini ${version} Flash-Lite`;
  if (model.includes("flash")) return `⚡ Gemini ${version} Flash`;
  return `✨ Gemini (${model})`;
}

export async function callGemini(apiKey: string, modelId: string, messages: Array<{role:string;content:string}>, jsonMode?: boolean): Promise<{text:string; model:string}> {
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
  // Parts can be text, thought summaries, inline data or function calls; only
  // the text parts are a chat reply.
  const parts = data?.candidates?.[0]?.content?.parts;
  let text = Array.isArray(parts)
    ? parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
    : "";
  if (!text.trim() && parts) text = coerceText(parts);
  return { text: typeof text === "string" ? text : coerceText(text), model: modelId };
}

export async function callGroq(apiKey: string, model: string, messages: Array<{role:string;content:string}>, jsonMode?: boolean): Promise<{text:string; model:string}> {
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
  const text = coerceText(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "");
  return { text, model };
}

export async function callOpenRouter(apiKey: string, model: string, messages: Array<{role:string;content:string}>, jsonMode?: boolean): Promise<{text:string; model:string}> {
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
  const text = coerceText(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "");
  return { text, model };
}

export async function callCloudflare(env: Env, model: string, messages: Array<{role:string;content:string}>): Promise<{text:string; model:string}> {
  const modelId = model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  let res: any;
  try {
    res = await env.AI.run(modelId as any, { messages });
  } catch {
    res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages });
  }
  // Never String() an object here: Workers AI answers with strings,
  // { response: string }, { response: object }, { result: { response } } or an
  // array of chunks, and String({...}) is the literal "[object Object]".
  const text = coerceText(res);
  return { text, model: modelId };
}

export function shouldFailoverGemini(err: any): boolean {
  const s = err?.status; return s === 404 || s === 429 || s === 401 || s === 403 || s === 503;
}
