import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, WorkflowParams } from "../types";
import { getVaultCredential } from "../vault";

type CredsMap = { [serviceId: string]: { [k: string]: string | number | boolean | null } };

async function updateLog(env: Env, uid: string, id: string, status: string, result?: string, error?: string) {
  const stub = env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
  await stub.fetch("https://do/log/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status, result, error }),
  });
}

export class AutomationWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { uid, token, prompt, services, logId } = event.payload;
    try {
      const credentials = await step.do<CredsMap>("decrypt-credentials", async () => {
        const out: CredsMap = {};
        for (const serviceId of services || []) {
          const cred = await getVaultCredential(this.env, uid, token, serviceId);
          if (cred && typeof cred === "object") {
            const flat: { [k: string]: string | number | boolean | null } = {};
            for (const [k, v] of Object.entries(cred as Record<string, unknown>)) {
              if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                flat[k] = v;
              } else {
                flat[k] = JSON.stringify(v);
              }
            }
            out[serviceId] = flat;
          }
        }
        return out;
      });

      const aiResult = await step.do("run-ai", async () => {
        const system = `You are an automation agent. You receive a user prompt and available service names. Produce a concise JSON object with keys: plan (array of step strings), output (string), actions (array). Do not include secrets in output.`;
        const userMsg = JSON.stringify({ prompt, availableServices: Object.keys(credentials) });
        const res = await this.env["Worker AI"].run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
        });
        const text =
          typeof res === "object" && res && "response" in res
            ? String((res as { response: unknown }).response)
            : JSON.stringify(res);
        return text;
      });

      const actionsResult = await step.do("execute-actions", async () => {
        const results: Array<{ service: string; status: string; detail?: string }> = [];
        for (const [serviceId, cred] of Object.entries(credentials)) {
          const urlVal = cred.webhookUrl ?? cred.url;
          const url = typeof urlVal === "string" ? urlVal : undefined;
          if (url && /^https?:\/\//.test(url)) {
            try {
              const method = typeof cred.method === "string" ? cred.method : "POST";
              const r = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  prompt,
                  ai: aiResult,
                  service: serviceId,
                  timestamp: new Date().toISOString(),
                }),
              });
              results.push({ service: serviceId, status: r.ok ? "ok" : `http_${r.status}` });
            } catch (e) {
              results.push({ service: serviceId, status: "error", detail: e instanceof Error ? e.message : "failed" });
            }
          } else {
            results.push({ service: serviceId, status: "prepared" });
          }
        }
        return results;
      });

      const finalResult = JSON.stringify({ ai: aiResult, actions: actionsResult }, null, 2);
      await step.do("log-result", async () => {
        await updateLog(this.env, uid, logId, "completed", finalResult);
        return "logged";
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Workflow failed";
      await updateLog(this.env, uid, logId, "failed", undefined, message);
      throw err;
    }
  }
}
