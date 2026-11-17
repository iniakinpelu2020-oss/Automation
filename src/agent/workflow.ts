import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, NodeLog, WorkflowNode, WorkflowParams } from "../types";
import { getVaultCredential } from "../vault";
import { getValidGoogleAccessToken } from "../vault/oauth";
import { runAI } from "./aiRouter";

type CredFlat = { [k: string]: string | number | boolean | null };
type OutputsMap = Record<string, any>;

async function updateLog(env: Env, uid: string, id: string, patch: { status?: string; result?: string; error?: string; nodeLogs?: string }) {
  const stub = env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
  await stub.fetch("https://do/log/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
}

function resolveTemplate(value: unknown, outputs: OutputsMap, trigger: unknown): any {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr: string) => {
      const e = expr.trim();
      if (e === "$json" || e === "$json.output" || e.startsWith("$json")) {
        const v = e === "$json.output" ? (trigger as any)?.output ?? (trigger as any) : trigger;
        return typeof v === "string" ? v : JSON.stringify(v ?? "");
      }
      if (e === "$input" || e.startsWith("$input.")) {
        const last = outputs.__last ?? trigger;
        let v: any = last;
        if (e.startsWith("$input.")) { for (const p of e.slice(7).split(".")) v = v?.[p]; }
        else v = v?.output ?? v;
        return v === undefined || v === null ? "" : (typeof v === "string" ? v : JSON.stringify(v));
      }
      const m = e.match(/^([a-zA-Z0-9_-]+)(?:\.(.+))?$/);
      if (m) {
        const nodeId = m[1];
        const path = m[2];
        let v: any = outputs[nodeId];
        if (path) { for (const p of path.split(".")) v = v?.[p]; }
        else { v = v?.output ?? v; }
        if (v === undefined || v === null) return "";
        return typeof v === "string" ? v : JSON.stringify(v);
      }
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, outputs, trigger));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveTemplate(v, outputs, trigger);
    return out;
  }
  return value;
}

function topoSort(nodes: WorkflowNode[], edges: { source: string; target: string }[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) { indeg.set(n.id, 0); adj.set(n.id, []); }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
  }
  const q: string[] = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  q.sort((a, b) => (byId.get(a)?.type === "trigger" ? -1 : 1));
  const out: WorkflowNode[] = [];
  while (q.length) {
    const id = q.shift()!;
    const n = byId.get(id);
    if (n) out.push(n);
    for (const nb of adj.get(id) || []) {
      indeg.set(nb, (indeg.get(nb) || 0) - 1);
      if (indeg.get(nb) === 0) q.push(nb);
    }
  }
  for (const n of nodes) if (!out.find((x) => x.id === n.id)) out.push(n);
  return out;
}

function getByPath(obj: any, path?: string): any {
  if (!path) return obj;
  let cur = obj;
  for (const p of String(path).split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[p as any];
  }
  return cur;
}

function toText(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function parseTimeToMinutes(t: string): number | null {
  if (!t) return null;
  const s = String(t).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || "0", 10);
  const ap = m[3];
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
