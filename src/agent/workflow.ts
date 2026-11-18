import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, NodeLog, WorkflowNode, WorkflowParams } from "../types";
import { getVaultCredential } from "../vault";
import { getValidGoogleAccessToken } from "../vault/oauth";
import { runAI } from "./aiRouter";
import { coerceText } from "./text";

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

function evaluateConditionNode(resolvedConfig: Record<string, any>, lastInput: any): { matched: boolean; branch: "true" | "false"; reason: string; value: any } {
  const mode = String(resolvedConfig.mode || resolvedConfig.conditionType || resolvedConfig.matchType || "text").toLowerCase();
  const sourcePath = resolvedConfig.sourcePath || resolvedConfig.path || (resolvedConfig.field ? String(resolvedConfig.field) : "");
  const sourceVal = sourcePath ? getByPath(lastInput, String(sourcePath)) : (resolvedConfig.valueFromInput !== false ? ((lastInput && typeof lastInput === 'object' && 'output' in lastInput) ? lastInput.output : lastInput) : resolvedConfig.input);
  const text = toText(sourceVal);

  if (mode === "time" || mode === "time_trigger" || mode === "schedule" || mode === "cron_time") {
    const target = String(resolvedConfig.time || resolvedConfig.matchTime || resolvedConfig.equals || resolvedConfig.value || "");
    const targetMin = parseTimeToMinutes(target);
    const tz = String(resolvedConfig.timezone || resolvedConfig.tz || "UTC");
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
      const parts = fmt.formatToParts(new Date());
      const hh = parts.find(p=>p.type==="hour")?.value || "00";
      const mm = parts.find(p=>p.type==="minute")?.value || "00";
      const curMin = parseInt(hh,10)*60 + parseInt(mm,10);
      const matched = targetMin != null && curMin === targetMin;
      return { matched, branch: matched ? "true" : "false", reason: `time ${curMin} vs ${targetMin}`, value: { currentMinutes: curMin, targetMinutes: targetMin, timezone: tz, source: text } };
    } catch {
      const now = new Date();
      const curMin = now.getUTCHours()*60 + now.getUTCMinutes();
      const matched = targetMin != null && curMin === targetMin;
      return { matched, branch: matched ? "true" : "false", reason: "utc time compare", value: { currentMinutes: curMin, targetMinutes: targetMin, timezone: "UTC" } };
    }
  }

  if (mode === "api_response" || mode === "response" || mode === "http" || mode === "status") {
    const expectStatus = resolvedConfig.status ?? resolvedConfig.httpStatus ?? resolvedConfig.equalsStatus;
    const actualStatus = (lastInput && typeof lastInput === "object") ? (lastInput.httpStatus ?? lastInput.status ?? lastInput.output?.httpStatus ?? lastInput.output?.status) : undefined;
    let matched = false;
    let reason = "api response check";
    if (expectStatus !== undefined && expectStatus !== null && expectStatus !== "") {
      matched = String(actualStatus) === String(expectStatus);
      reason = `status ${actualStatus} == ${expectStatus}`;
    } else {
      const expr = String(resolvedConfig.equals ?? resolvedConfig.contains ?? resolvedConfig.match ?? resolvedConfig.value ?? "");
      if (expr) {
        const op = resolvedConfig.equals != null ? "equals" : (resolvedConfig.match ? "regex" : "contains");
        if (op === "equals") matched = text === expr;
        else if (op === "regex") { try { matched = new RegExp(expr, resolvedConfig.flags || "i").test(text); } catch { matched = false; } }
        else matched = text.toLowerCase().includes(expr.toLowerCase());
        reason = `${op} "${expr}"`;
      } else {
        matched = !!(actualStatus && Number(actualStatus) >= 200 && Number(actualStatus) < 300);
        reason = "2xx status";
      }
    }
    return { matched, branch: matched ? "true" : "false", reason, value: sourceVal };
  }

  const equals = resolvedConfig.equals ?? resolvedConfig.equal ?? resolvedConfig.is;
  const contains = resolvedConfig.contains ?? resolvedConfig.includes;
  const regex = resolvedConfig.regex ?? resolvedConfig.match;
  const notEmpty = resolvedConfig.notEmpty ?? resolvedConfig.exists;
  let matched = false;
  let reason = "text";
  if (equals != null && equals !== "") { matched = text === String(equals); reason = `equals "${equals}"`; }
  else if (contains != null && contains !== "") { matched = text.toLowerCase().includes(String(contains).toLowerCase()); reason = `contains "${contains}"`; }
  else if (regex != null && regex !== "") { try { matched = new RegExp(String(regex), resolvedConfig.flags || "i").test(text); } catch { matched = false; } reason = `regex ${regex}`; }
  else if (notEmpty) { matched = text.trim().length > 0; reason = "notEmpty"; }
  else {
    matched = !!(text && text !== "false" && text !== "0" && text !== "null" && text !== "undefined");
    reason = "truthy";
  }
  return { matched, branch: matched ? "true" : "false", reason, value: sourceVal };
}

/* Switch node: routes to the first matching rule's handle, else the default.
   Handles are matched against an edge's sourceHandle/label by isEdgeActive. */
function evaluateSwitchNode(resolvedConfig: Record<string, any>, lastInput: any): { branch: string; matched: boolean; reason: string; value: any } {
  const raw = (resolvedConfig.value !== undefined && resolvedConfig.value !== "")
    ? resolvedConfig.value
    : (resolvedConfig.sourcePath || resolvedConfig.path
      ? getByPath(lastInput, String(resolvedConfig.sourcePath || resolvedConfig.path))
      : ((lastInput && typeof lastInput === "object" && "output" in lastInput) ? (lastInput as any).output : lastInput));
  const text = toText(raw).trim();
  const rules: any[] = Array.isArray(resolvedConfig.rules)
    ? resolvedConfig.rules
    : (Array.isArray(resolvedConfig.cases) ? resolvedConfig.cases as any[] : []);

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] || {};
    const handle = String(r.handle ?? r.output ?? r.branch ?? r.name ?? `case${i + 1}`);
    const target = r.value ?? r.equals ?? r.contains ?? r.regex ?? "";
    const op = String(r.operator ?? r.op ?? (r.regex != null ? "regex" : r.contains != null ? "contains" : "equals")).toLowerCase();
    let ok = false;
    if (op === "regex") { try { ok = new RegExp(String(target), r.flags || "i").test(text); } catch { ok = false; } }
    else if (op === "contains") ok = text.toLowerCase().includes(String(target).toLowerCase());
    else if (op === "notempty" || op === "exists") ok = text.length > 0;
    else if (op === "empty") ok = text.length === 0;
    else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      const a = Number(text), b = Number(target);
      if (Number.isNaN(a) || Number.isNaN(b)) ok = false;
      else ok = op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    else ok = text === String(target);
    if (ok) return { branch: handle, matched: true, reason: `rule ${i + 1} (${op})`, value: raw };
  }
  const fallback = String(resolvedConfig.defaultHandle ?? resolvedConfig.elseHandle ?? "default");
  return { branch: fallback, matched: false, reason: "no rule matched", value: raw };
}

function toSerializable(v: unknown): any {
  try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return String(v); }
}

async function runUserCode(code: string, input: any, secrets: any): Promise<any> {
  // Execute user-provided JS transform safely-ish in Worker (no DOM/fs); has access to $input/$secrets
  const fn = new Function("$input", "$secrets", "console", `"use strict";\n${code}\n`);
  const logs: string[] = [];
  const consoleShim = { log: (...a: any[]) => logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) };
  let ret = fn(input, secrets || {}, consoleShim);
  if (ret && typeof ret.then === 'function') ret = await ret;
  return { output: ret, logs };
}

export class AutomationWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { uid, token, logId, workflow } = event.payload;
    const nodes = workflow.nodes || [];
    const edges = (workflow.edges || []) as Array<{ id: string; source: string; target: string; sourceHandle?: string; label?: string; condition?: string }>;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const incoming = new Map<string, typeof edges>();
    const outgoing = new Map<string, typeof edges>();
    for (const n of nodes) { incoming.set(n.id, []); outgoing.set(n.id, []); }
    for (const e of edges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      outgoing.get(e.source)!.push(e);
      incoming.get(e.target)!.push(e);
    }

    const outputs: OutputsMap = {};
    const nodeLogs: NodeLog[] = nodes.map((n) => ({ nodeId: n.id, name: n.name, type: n.type, status: "idle" } as any));
    const logById = new Map(nodeLogs.map((l) => [l.nodeId, l]));
    const executed = new Set<string>();
    const skipped = new Set<string>();

    const pushLog = async (overall: "running" | "completed" | "failed" | "scheduled" = "running", finalResult?: string, finalError?: string) => {
      await updateLog(this.env, uid, logId, { status: overall, result: finalResult, error: finalError, nodeLogs: JSON.stringify(nodeLogs) });
    };

    function isEdgeActive(e: { source: string; sourceHandle?: string; label?: string; condition?: string }, outs: OutputsMap): boolean {
      const srcOut: any = outs[e.source];
      if (!srcOut) return false;
      const chosen = srcOut?.branch ?? srcOut?.output?.branch ?? srcOut?.matchedBranch ?? srcOut?.output?.matchedBranch;
      if (chosen === undefined || chosen === null) return true; // non-branching: active
      const wantRaw = String(e.sourceHandle ?? e.label ?? e.condition ?? "").toLowerCase();
      if (!wantRaw) return String(chosen).toLowerCase() === "true"; // unlabeled edge from branch -> treat as true path
      if (wantRaw === "default" || wantRaw === "else" || wantRaw === "fallback" || wantRaw === "false") {
        return String(chosen).toLowerCase() === "false" || String(chosen).toLowerCase() === "default" || String(chosen).toLowerCase() === "else";
      }
      if (wantRaw === "true" || wantRaw === "match" || wantRaw === "yes") return String(chosen).toLowerCase() === "true";
      return String(chosen).toLowerCase() === wantRaw;
    }

    const markSkipped = (id: string) => {
      if (executed.has(id) || skipped.has(id)) return;
      skipped.add(id);
      const nl = logById.get(id) as any; if (nl) { nl.status = "skipped"; nl.skipped = true; nl.output = { skipped: true, reason: "branch not taken or upstream skipped" }; nl.finishedAt = new Date().toISOString(); }
      for (const e of (outgoing.get(id) || [])) {
        const child = e.target;
        if (executed.has(child) || skipped.has(child)) continue;
        const ins = incoming.get(child) || [];
        const allResolved = ins.every(ie => executed.has(ie.source) || skipped.has(ie.source));
        const anyActive = ins.some(ie => executed.has(ie.source) && isEdgeActive(ie, outputs));
        if (allResolved && !anyActive) markSkipped(child);
      }
    };

    // Nodes that cannot be reached from a trigger never receive input, so they
    // are skipped instead of running as stray roots (n8n behaves the same way).
    {
      const triggerRoots = nodes.filter((n) => n.type === "trigger");
      const roots = triggerRoots.length ? triggerRoots : nodes.filter((n) => (incoming.get(n.id) || []).length === 0);
      const reachable = new Set<string>();
      const stack = roots.map((n) => n.id);
      while (stack.length) {
        const id = stack.pop()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        for (const e of outgoing.get(id) || []) stack.push(e.target);
      }
      for (const n of nodes) if (!reachable.has(n.id)) markSkipped(n.id);
    }

    await pushLog("running");

    try {
      let progress = true;
      let guard = 0;
      while (progress && guard < 5000) {
        guard++;
        progress = false;
        let next: WorkflowNode | null = null;
        for (const n of nodes) {
          if (executed.has(n.id) || skipped.has(n.id)) continue;
          const ins = incoming.get(n.id) || [];
          if (ins.length === 0) { next = n; break; }
          const allResolved = ins.every(e => executed.has(e.source) || skipped.has(e.source));
          if (!allResolved) continue;
          const activeIns = ins.filter(e => executed.has(e.source) && isEdgeActive(e, outputs));
          if (activeIns.length === 0) { markSkipped(n.id); progress = true; next = null; break; }
          next = n; break;
        }
        if (!next) {
          const remaining = nodes.filter(n => !executed.has(n.id) && !skipped.has(n.id));
          if (remaining.length && !progress) {
            const ord = topoSort(remaining, edges);
            next = ord[0] || null;
            if (!next) break;
          } else {
            continue;
          }
        }

        const node = next;
        const nlog = logById.get(node.id)! as any;
        const ins = incoming.get(node.id) || [];
        const activeIn = ins.find(e => executed.has(e.source) && isEdgeActive(e, outputs)) || ins.find(e => executed.has(e.source));
        const predecessorId = activeIn ? activeIn.source : null;
        const inputFromPred = predecessorId ? outputs[predecessorId] : (outputs.__last ?? { output: { input: true } });
        nlog.status = "running";
        nlog.startedAt = new Date().toISOString();
        nlog.input = toSerializable(inputFromPred);
        await pushLog("running");

        const execNode = async (): Promise<any> => {
          const triggerNode = nodes.find((n) => n.type === "trigger") || nodes[0];
          const triggerData = (triggerNode && outputs[triggerNode.id]) ? outputs[triggerNode.id] : { output: { input: true, triggeredAt: new Date().toISOString() } };
          const localOutputs = { ...outputs, __last: inputFromPred } as any;
          const resolvedConfig = resolveTemplate(node.config || {}, localOutputs, triggerData) as Record<string, any>;

          if (node.type === "trigger") {
            const cfg = resolvedConfig || {};
            return toSerializable({ output: { type: node.subtype || "manual", triggeredAt: new Date().toISOString(), schedule: cfg.cron || cfg.time || cfg.schedule || null, payload: cfg.payload ?? cfg.data ?? null, config: cfg } });
          }

          // Load attached credential (and refresh Google tokens if applicable)
          let cred: CredFlat | null = null;
          const credId = node.credentialId || (typeof resolvedConfig.credentialId === "string" ? resolvedConfig.credentialId : undefined);
          if (credId) {
            if (String(credId).startsWith("google_") || ["youtube","gmail","drive","sheets"].includes(String(credId))) {
              const svc = String(credId).replace(/^google_/, "");
              const at = await getValidGoogleAccessToken(this.env, uid, token, svc);
              const raw = await getVaultCredential(this.env, uid, token, String(credId).startsWith("google_") ? String(credId) : `google_${svc}`) as any;
              cred = {};
              if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) {
                cred[k] = (v === null || v === undefined) ? null : (typeof v === "string" || typeof v === "number" || typeof v === "boolean") ? v : JSON.stringify(v);
              }
              if (at) cred.access_token = at;
            } else {
              const raw = await getVaultCredential(this.env, uid, token, String(credId));
              if (raw && typeof raw === "object") {
                cred = {};
                for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
                  cred[k] = (v === null || v === undefined) ? null : (typeof v === "string" || typeof v === "number" || typeof v === "boolean") ? v : JSON.stringify(v);
                }
              }
            }
          }

          // Dialogue / scripted nodes
          if (node.type === "dialogue" || node.type === "script" || node.subtype === "dialogue" || node.subtype === "script" || node.subtype === "message") {
            const message = resolvedConfig.message ?? resolvedConfig.text ?? resolvedConfig.script ?? resolvedConfig.prompt ?? resolvedConfig.content ?? inputFromPred;
            const payload = resolvedConfig.payload ?? resolvedConfig.data ?? undefined;
            return toSerializable({ output: message, message, payload, nodeType: node.type });
          }

          // Conditional / branch nodes (text matching, time triggers, API responses)
          if (node.type === "condition" || node.type === "branch" || node.subtype === "condition" || node.subtype === "branch" || node.subtype === "if") {
            const cond = evaluateConditionNode(resolvedConfig, inputFromPred);
            return toSerializable({ output: { ...cond, input: inputFromPred }, branch: cond.branch, matched: cond.matched, reason: cond.reason, value: cond.value });
          }

          // Switch node: first matching rule wins, otherwise the default handle
          if (node.type === "switch" || node.subtype === "switch" || node.subtype === "router") {
            const sw = evaluateSwitchNode(resolvedConfig, inputFromPred);
            return toSerializable({ output: { ...sw, input: inputFromPred }, branch: sw.branch, matched: sw.matched, reason: sw.reason, value: sw.value });
          }

          if (node.type === "ai") {
            const promptTpl = String(resolvedConfig.prompt ?? resolvedConfig.input ?? resolvedConfig.message ?? "");
            const provider = (resolvedConfig.provider || resolvedConfig.aiProvider || undefined) as any;
            const customModel = String(resolvedConfig.customModelId || resolvedConfig.model || "").trim() || undefined;
            const system = String(resolvedConfig.system || "You are a helpful automation agent.");
            let credCtx = "";
            if (cred) credCtx = `\nAttached credential keys: ${Object.keys(cred).join(", ")}`;
            const messages = [
              { role: "system" as const, content: system + credCtx },
              { role: "user" as const, content: promptTpl || toText(inputFromPred) || "Execute this step." },
            ];
            const aiRes = await runAI(this.env, uid, token, { messages, provider, model: customModel, jsonMode: !!resolvedConfig.jsonMode });
            return toSerializable({ output: coerceText(aiRes.text), model: aiRes.model, provider: aiRes.provider, badge: aiRes.badge, failoverReasons: aiRes.failoverReasons || [] });
          }

          if (node.type === "code" || node.subtype === "js" || node.subtype === "code") {
            const code = String(resolvedConfig.code || resolvedConfig.js || "return $input;");
            const prev = (inputFromPred && typeof inputFromPred === 'object' && 'output' in inputFromPred) ? (inputFromPred as any).output : inputFromPred;
            // Vault credentials are only exposed to code the author opted in for.
            // Workflows proposed by the model must not be able to read them.
            const allowSecrets = resolvedConfig.allowSecrets === true;
            const secretsObj = allowSecrets ? (cred || {}) : {};
            const execRes = await runUserCode(code, prev, secretsObj);
            return toSerializable(execRes);
          }

          if (node.type === "action") {
            const subtype = node.subtype || "http";

            if (Array.isArray(resolvedConfig.services)) {
              const services = resolvedConfig.services as string[];
              const batch: Array<{ service: string; status: string; detail?: string }> = [];
              for (const sid of services) {
                const c = await getVaultCredential(this.env, uid, token, sid) as any;
                const url = c?.webhookUrl || c?.url;
                if (url && typeof url === "string" && /^https?:\/\//.test(url)) {
                  try {
                    const r = await fetch(url, { method: c?.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: inputFromPred, outputs, workflow: workflow.name }) });
                    batch.push({ service: sid, status: r.ok ? "ok" : `http_${r.status}` });
                  } catch (e) { batch.push({ service: sid, status: "error", detail: e instanceof Error ? e.message : "failed" }); }
                } else { batch.push({ service: sid, status: "prepared" }); }
              }
              return toSerializable({ output: { subtype, batch } });
            }

            const url = String(resolvedConfig.url || resolvedConfig.webhookUrl || cred?.webhookUrl || cred?.url || "");
            const method = String(resolvedConfig.method || cred?.method || "POST").toUpperCase();
            const bodyTemplate = resolvedConfig.body ?? resolvedConfig.message ?? resolvedConfig.text ?? resolvedConfig.content;
            const payload = bodyTemplate !== undefined ? bodyTemplate : { input: inputFromPred, outputs: Object.fromEntries(Object.entries(outputs).filter(([k])=>k!=="__last")), node: node.name };
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (typeof resolvedConfig.headers === "object" && resolvedConfig.headers) {
              for (const [k, v] of Object.entries(resolvedConfig.headers as Record<string, unknown>)) headers[k] = String(v);
            }
            const authHeader = (resolvedConfig.authorization || cred?.authorization || cred?.bearerToken || cred?.apiKey || cred?.access_token) as string | undefined;
            if (authHeader) {
              const val = String(authHeader);
              headers["Authorization"] = val.startsWith("Bearer ") || (subtype === "http" && String(resolvedConfig.authType) === "raw") ? val : `Bearer ${val}`;
            }

            if (!url || !/^https?:\/\//.test(url)) {
              return toSerializable({ output: { subtype, status: "prepared", payload, credential: credId || null, note: "No HTTP endpoint configured; action prepared." } });
            }

            const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : (typeof payload === "string" ? payload : JSON.stringify(payload)) });
            let respBody: any = null; const ct = r.headers.get("content-type") || "";
            try { respBody = ct.includes("application/json") ? await r.json() : await r.text(); } catch { respBody = null; }
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${typeof respBody === "string" ? respBody.slice(0, 300) : JSON.stringify(respBody ?? "").slice(0, 300)}`);
            return toSerializable({ output: { subtype, status: "success", httpStatus: r.status, response: respBody }, httpStatus: r.status, response: respBody });
          }

          return toSerializable({ output: { skipped: true, reason: "unknown node type" } });
        };

        // Retry policy: per-node, defaulted on for network-bound nodes only.
        const nodeCfg = (node.config || {}) as Record<string, any>;
        const retryDefault = node.type === "action" || node.type === "ai";
        const retryOnFail = nodeCfg.retryOnFail === undefined ? retryDefault : nodeCfg.retryOnFail === true;
        const maxTries = retryOnFail ? Math.min(Math.max(parseInt(String(nodeCfg.maxTries || 3), 10) || 3, 1), 5) : 1;
        const waitMs = Math.min(Math.max(parseInt(String(nodeCfg.waitBetweenTriesMs || 1000), 10) || 1000, 0), 30000);

        let result: any;
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= maxTries; attempt++) {
          try {
            // Distinct step names per attempt so Workflows replays each try independently.
            result = await step.do<any>(attempt === 1 ? `node-${node.id}` : `node-${node.id}-try${attempt}`, execNode);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            nlog.attempts = attempt;
            if (attempt < maxTries) await new Promise((r) => setTimeout(r, waitMs));
          }
        }

        if (lastErr) {
          const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
          const onError = String(nodeCfg.onError || nodeCfg.errorPolicy || "stop").toLowerCase();
          const continueOnError = nodeCfg.continueOnError === true || onError === "continue" || onError === "skip";
          nlog.status = "error";
          nlog.error = message;
          nlog.finishedAt = new Date().toISOString();
          nlog.output = toSerializable({ error: message, failed: true });
          if (!continueOnError) {
            await pushLog("running");
            throw lastErr;
          }
          // Continue on error: the error travels downstream on the normal output,
          // so later nodes still run and can react to it.
          const errOut = toSerializable({ output: { error: message, failed: true }, error: message });
          outputs[node.id] = errOut;
          outputs.__last = errOut;
          executed.add(node.id);
          await pushLog("running");
          progress = true;
          continue;
        }

        outputs[node.id] = result;
        outputs.__last = result;
        nlog.output = result;
        nlog.status = "success";
        nlog.finishedAt = new Date().toISOString();
        executed.add(node.id);
        await pushLog("running");
        progress = true;

        const chosen = (result as any)?.branch ?? (result as any)?.output?.branch ?? (result as any)?.matchedBranch ?? (result as any)?.output?.matchedBranch;
        if (chosen !== undefined && chosen !== null) {
          const outs = outgoing.get(node.id) || [];
          const activeTargets = new Set(outs.filter(e => isEdgeActive(e, outputs)).map(e => e.target));
          for (const e of outs) {
            if (!activeTargets.has(e.target)) {
              const childIns = incoming.get(e.target) || [];
              const otherActivePossible = childIns.some(ie => ie.source !== node.id && !skipped.has(ie.source));
              if (!otherActivePossible) markSkipped(e.target);
            }
          }
        }
      }

      for (const n of nodes) if (!executed.has(n.id) && !skipped.has(n.id)) markSkipped(n.id);
      const finalResult = JSON.stringify({ outputs: Object.fromEntries(Object.entries(outputs).filter(([k]) => k !== "__last")), workflow: { id: workflow.id, name: workflow.name } }, null, 2);
      await pushLog("completed", finalResult, undefined);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Workflow failed";
      for (const n of nodeLogs as any[]) if (n.status === "running") { n.status = "error"; n.error = message; n.finishedAt = new Date().toISOString(); }
      await pushLog("failed", JSON.stringify({ outputs: Object.fromEntries(Object.entries(outputs).filter(([k]) => k !== "__last")) }, null, 2), message);
      throw err;
    }
  }
}
