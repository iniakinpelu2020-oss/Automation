import type { AgentRunRequest, Env, LogEntry, WorkflowParams } from "../types";
import { requireAuth } from "../vault/auth";
import { getVaultCredential } from "../vault";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getStub(env: Env, uid: string) {
  return env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
}

export async function handleAgentRequest(request: Request, env: Env, url: URL): Promise<Response> {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (e) {
    return e as Response;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/agent/logs") {
      const stub = getStub(env, auth.uid);
      const res = await stub.fetch("https://do/logs");
      const data = await res.json();
      return json(data);
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run") {
      const body = (await request.json()) as AgentRunRequest;
      const prompt = (body.prompt || "").trim();
      if (!prompt) return json({ error: "prompt is required" }, 400);
      const services = Array.isArray(body.services) ? body.services.filter(Boolean) : [];
      const logId = crypto.randomUUID();
      const now = new Date().toISOString();
      const stub = getStub(env, auth.uid);

      const baseEntry: LogEntry = {
        id: logId,
        uid: auth.uid,
        prompt,
        status: body.schedule || body.mode === "workflow" ? "scheduled" : "running",
        createdAt: now,
        updatedAt: now,
      };
      await stub.fetch("https://do/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseEntry),
      });

      const useWorkflow = body.schedule || body.mode === "workflow" || services.length > 0;
      if (useWorkflow) {
        const params: WorkflowParams = {
          uid: auth.uid,
          token: auth.token,
          prompt,
          services,
          logId,
        };
        await env.AUTOMATION_WORKFLOW.create({ params });
        return json({ ok: true, logId, status: "scheduled" });
      }

      // Immediate AI-only run
      try {
        const aiRes = await env["Worker AI"].run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [
            { role: "system", content: "You are a helpful automation assistant. Return a clear, actionable response." },
            { role: "user", content: prompt },
          ],
        });
        const text =
          typeof aiRes === "object" && aiRes && "response" in aiRes
            ? String((aiRes as { response: unknown }).response)
            : JSON.stringify(aiRes);
        await stub.fetch("https://do/log/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: logId, status: "completed", result: text }),
        });
        return json({ ok: true, logId, status: "completed", result: text });
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI run failed";
        await stub.fetch("https://do/log/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: logId, status: "failed", error: message }),
        });
        return json({ error: message, logId }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Agent error";
    return json({ error: message }, 500);
  }
}
