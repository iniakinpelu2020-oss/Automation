import type { AgentRunRequest, Env, LogEntry, WorkflowGraph, WorkflowParams } from "../types";
import { requireAuth } from "../vault/auth";
import { runAI } from "./aiRouter";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getStub(env: Env, uid: string) {
  return env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
}

function isGraphRequest(body: AgentRunRequest): boolean {
  return Array.isArray(body.nodes) && body.nodes.length > 0;
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
      const res = await stub.fetch("https://do/logs" + url.search);
      const data = await res.json();
      return json(data);
    }

    // Workflow persistence
    if (request.method === "GET" && url.pathname === "/api/agent/workflows") {
      const stub = getStub(env, auth.uid);
      const res = await stub.fetch("https://do/workflows");
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === "/api/agent/workflows") {
      const body = await request.json() as { id?: string; name?: string; data?: WorkflowGraph };
      if (!body.name || !body.data) return json({ error: "name and data required" }, 400);
      const stub = getStub(env, auth.uid);
      const res = await stub.fetch("https://do/workflows/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: body.id, name: body.name, data: body.data }),
      });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    // AI Settings (stored in vault as ai_settings)
    if (request.method === "GET" && url.pathname === "/api/agent/settings") {
      const { getVaultCredential } = await import("../vault");
      const s = await getVaultCredential(env, auth.uid, auth.token, "ai_settings");
      return json({ settings: s || {} });
    }
    if (request.method === "POST" && url.pathname === "/api/agent/settings") {
      const body = await request.json() as Record<string, unknown>;
      const { encryptJSON } = await import("../vault/crypto");
      const { setVaultItem } = await import("../vault/firestore");
      const enc = await encryptJSON(env.ENCRYPTION_SECRET, body || {});
      await setVaultItem(auth.uid, auth.token, {
        serviceId: "ai_settings",
        label: "AI Settings",
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        salt: enc.salt,
        updatedAt: new Date().toISOString(),
      });
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/agent/run") {
      const body = (await request.json()) as AgentRunRequest;
      const logId = crypto.randomUUID();
      const now = new Date().toISOString();
      const stub = getStub(env, auth.uid);

      // Graph-based workflow execution
      if (isGraphRequest(body)) {
        const workflow: WorkflowGraph = {
          id: body.workflowId,
          name: body.workflowName || "Untitled Workflow",
          nodes: body.nodes || [],
          edges: body.edges || [],
          triggerType: body.triggerType,
          schedule: body.schedule ? String(body.schedule) : undefined,
        };
        const baseEntry: LogEntry = {
          id: logId,
          uid: auth.uid,
          prompt: workflow.name || "Workflow run",
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: (workflow.triggerType === "cron" || body.mode === "workflow") ? "scheduled" : "running",
          nodeLogs: JSON.stringify([]),
          createdAt: now,
          updatedAt: now,
        };
        await stub.fetch("https://do/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(baseEntry),
        });

        const params: WorkflowParams = {
          uid: auth.uid,
          token: auth.token,
          logId,
          workflow,
        };
        await env.AUTOMATION_WORKFLOW.create({ params });
        return json({ ok: true, logId, status: baseEntry.status });
      }

      // Legacy/simple prompt mode (backward compatible)
      const prompt = (body.prompt || "").trim();
      if (!prompt) return json({ error: "prompt is required" }, 400);
      const services = Array.isArray(body.services) ? body.services.filter(Boolean) : [];

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
        // convert legacy request to a simple graph
        const nodes = [
          { id: "trigger-1", type: "trigger" as const, subtype: "manual", name: "Manual Trigger", config: {} },
          { id: "ai-1", type: "ai" as const, subtype: "workers-ai", name: "AI Agent", config: { prompt } },
        ];
        if (services.length) {
          nodes.push({ id: "action-1", type: "action" as const, subtype: "http", name: "Actions", config: { services } } as any);
        }
        const edges = services.length
          ? [{ id: "e1", source: "trigger-1", target: "ai-1" }, { id: "e2", source: "ai-1", target: "action-1" }]
          : [{ id: "e1", source: "trigger-1", target: "ai-1" }];
        const params: WorkflowParams = {
          uid: auth.uid,
          token: auth.token,
          logId,
          workflow: { name: prompt.slice(0, 60), nodes, edges, triggerType: body.schedule ? "cron" : "manual" },
        };
        await env.AUTOMATION_WORKFLOW.create({ params });
        return json({ ok: true, logId, status: "scheduled" });
      }

      try {
        const aiRes = await runAI(env, auth.uid, auth.token, {
          messages: [
            { role: "system", content: "You are a helpful automation assistant. Return a clear, actionable response." },
            { role: "user", content: prompt },
          ],
          provider: (body as any).provider,
          model: (body as any).model,
        });
        const text = aiRes.text;
        const result = JSON.stringify({ text, provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge }, null, 2);
        await stub.fetch("https://do/log/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: logId, status: "completed", result }),
        });
        return json({ ok: true, logId, status: "completed", result: text, aiMeta: { provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge } });
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
