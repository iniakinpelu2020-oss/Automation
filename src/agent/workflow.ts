import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, NodeLog, WorkflowNode, WorkflowParams } from "../types";
import { getVaultCredential } from "../vault";

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
      const m = e.match(/^([a-zA-Z0-9_-]+)(?:\.(.+))?$/);
      if (m) {
        const nodeId = m[1];
        const path = m[2];
        let v: any = outputs[nodeId];
        if (path) {
          for (const p of path.split(".")) v = v?.[p];
        } else {
          v = v?.output ?? v;
        }
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

function toSerializable(v: unknown): any {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}

export class AutomationWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { uid, token, logId, workflow } = event.payload;
    const nodes = workflow.nodes || [];
    const edges = workflow.edges || [];
    const ordered = topoSort(nodes, edges);
    const outputs: OutputsMap = {};
    const nodeLogs: NodeLog[] = ordered.map((n) => ({ nodeId: n.id, name: n.name, type: n.type, status: "idle" }));

    const pushLog = async (overall: "running" | "completed" | "failed" | "scheduled" = "running", finalResult?: string, finalError?: string) => {
      await updateLog(this.env, uid, logId, {
        status: overall,
        result: finalResult,
        error: finalError,
        nodeLogs: JSON.stringify(nodeLogs),
      });
    };

    await pushLog("running");

    try {
      for (let i = 0; i < ordered.length; i++) {
        const node = ordered[i];
        const nlog = nodeLogs[i];
        nlog.status = "running";
        nlog.startedAt = new Date().toISOString();
        await pushLog("running");

        const result = await step.do<any>(`node-${node.id}`, async () => {
          const triggerNode = ordered.find((n) => n.type === "trigger");
          const triggerData = (triggerNode ? outputs[triggerNode.id] : null) || { output: { input: true } };
          const resolvedConfig = resolveTemplate(node.config || {}, outputs, triggerData) as Record<string, any>;

          if (node.type === "trigger") {
            return toSerializable({ output: { type: node.subtype || "manual", triggeredAt: new Date().toISOString(), config: resolvedConfig } });
          }

          if (node.type === "ai") {
            const promptTpl = String(resolvedConfig.prompt ?? resolvedConfig.input ?? "");
            const model = String(resolvedConfig.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
            const system = String(resolvedConfig.system || "You are a helpful automation agent.");
            let credCtx = "";
            if (node.credentialId) {
              const cred = await getVaultCredential(this.env, uid, token, node.credentialId);
              if (cred) credCtx = `\nAttached credential (${node.credentialId}) keys: ${Object.keys(cred as object).join(", ")}`;
            }
            const messages = [
              { role: "system" as const, content: system + credCtx },
              { role: "user" as const, content: promptTpl || "Execute this step." },
            ];
            let res: any;
            try {
              res = await this.env["Worker AI"].run(model as any, { messages });
            } catch {
              res = await this.env["Worker AI"].run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages });
            }
            const text = typeof res === "object" && res && "response" in res ? String(res.response) : JSON.stringify(res);
            return toSerializable({ output: text, model });
          }

          if (node.type === "action") {
            const subtype = node.subtype || "http";
            let cred: CredFlat | null = null;
            const credId = node.credentialId || (typeof resolvedConfig.credentialId === "string" ? resolvedConfig.credentialId : undefined);
            if (credId) {
              const raw = await getVaultCredential(this.env, uid, token, credId);
              if (raw && typeof raw === "object") {
                cred = {};
                for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
                  cred[k] = (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") ? v : JSON.stringify(v);
                }
              }
            }

            if (Array.isArray(resolvedConfig.services)) {
              const services = resolvedConfig.services as string[];
              const batch: Array<{ service: string; status: string; detail?: string }> = [];
              for (const sid of services) {
                const c = await getVaultCredential(this.env, uid, token, sid) as any;
                const url = c?.webhookUrl || c?.url;
                if (url && typeof url === "string" && /^https?:\/\//.test(url)) {
                  try {
                    const r = await fetch(url, { method: c?.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outputs, workflow: workflow.name }) });
                    batch.push({ service: sid, status: r.ok ? "ok" : `http_${r.status}` });
                  } catch (e) { batch.push({ service: sid, status: "error", detail: e instanceof Error ? e.message : "failed" }); }
                } else {
                  batch.push({ service: sid, status: "prepared" });
                }
              }
              return toSerializable({ output: { subtype, batch } });
            }

            const url = String(resolvedConfig.url || resolvedConfig.webhookUrl || cred?.webhookUrl || cred?.url || "");
            const method = String(resolvedConfig.method || cred?.method || "POST").toUpperCase();
            const bodyTemplate = resolvedConfig.body ?? resolvedConfig.message ?? resolvedConfig.text ?? resolvedConfig.content;
            const payload = bodyTemplate !== undefined ? bodyTemplate : { outputs, node: node.name };

            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (typeof resolvedConfig.headers === "object" && resolvedConfig.headers) {
              for (const [k, v] of Object.entries(resolvedConfig.headers as Record<string, unknown>)) headers[k] = String(v);
            }
            const authHeader = (resolvedConfig.authorization || cred?.authorization || cred?.bearerToken || cred?.apiKey) as string | undefined;
            if (authHeader) {
              headers["Authorization"] = String(authHeader).startsWith("Bearer ") || (subtype === "http" && String(resolvedConfig.authType) === "raw")
                ? String(authHeader)
                : `Bearer ${authHeader}`;
            }

            if (!url || !/^https?:\/\//.test(url)) {
              return toSerializable({ output: { subtype, status: "prepared", payload, credential: credId || null, note: "No HTTP endpoint configured; action prepared." } });
            }

            const r = await fetch(url, {
              method,
              headers,
              body: method === "GET" ? undefined : (typeof payload === "string" ? payload : JSON.stringify(payload)),
            });
            let respBody: any = null;
            const ct = r.headers.get("content-type") || "";
            try { respBody = ct.includes("application/json") ? await r.json() : await r.text(); } catch { respBody = null; }
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${typeof respBody === "string" ? respBody.slice(0, 300) : JSON.stringify(respBody ?? "").slice(0, 300)}`);
            return toSerializable({ output: { subtype, status: "success", httpStatus: r.status, response: respBody } });
          }

          return toSerializable({ output: { skipped: true, reason: "unknown node type" } });
        });

        outputs[node.id] = result;
        nlog.output = result;
        nlog.status = "success";
        nlog.finishedAt = new Date().toISOString();
        await pushLog("running");
      }

      const finalResult = JSON.stringify({ outputs, workflow: { id: workflow.id, name: workflow.name } }, null, 2);
      await pushLog("completed", finalResult, undefined);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Workflow failed";
      for (const n of nodeLogs) if (n.status === "running") { n.status = "error"; n.error = message; n.finishedAt = new Date().toISOString(); }
      await pushLog("failed", JSON.stringify({ outputs }, null, 2), message);
      throw err;
    }
  }
}
