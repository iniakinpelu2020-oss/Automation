import type { Env } from "../types";
import { requireAuth } from "../vault/auth";
import { runAI } from "./aiRouter";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function getStub(env: Env, uid: string) {
  return env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
}

export async function handleChatRequest(request: Request, env: Env, url: URL): Promise<Response> {
  let auth;
  try { auth = await requireAuth(request); } catch (e) { return e as Response; }
  const stub = getStub(env, auth.uid);

  try {
    if (request.method === "GET" && url.pathname === "/api/agent/chats") {
      const res = await stub.fetch("https://do/chats");
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === "/api/agent/chats") {
      const body = await request.json() as { id?: string; title?: string };
      const res = await stub.fetch("https://do/chats/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/agent/chats/")) {
      const id = url.pathname.split("/").pop() || "";
      const res = await stub.fetch(`https://do/chats/${encodeURIComponent(id)}`);
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/api/agent/chat") {
      const body = await request.json() as { message: string; chatId?: string; history?: Array<{role:string;content:string}>; workflow?: any; workflowGraph?: any; provider?: string; model?: string };
      const message = (body.message || "").trim();
      if (!message) return json({ error: "message required" }, 400);

      const system = `You are an expert n8n-style workflow automation assistant and code generator.
Classify intent into action: "build" (create new workflow from scratch), "edit" (modify the provided currentWorkflow/workflowGraph), "execute" (user explicitly wants to run/execute the current workflow now), or "chat" (explanations/questions only, no workflow changes needed).
Return ONLY a single valid JSON object (no markdown fences, no extra text) with this exact shape:
{
  "action": "build" | "edit" | "execute" | "chat",
  "explanation": "Clear markdown explanation. Never include raw JSON here.",
  "codeBlocks": [{"language":"javascript","title":"optional title","code":"..."}],
  "workflowGraph": {
    "nodes": [
      {"id":"n1","type":"trigger|ai|code|action|condition","subtype":"manual|webhook|cron|workers-ai|js|http|twitter|youtube|gmail|drive|sheets|telegram|discord","name":"Label","position":{"x":80,"y":140},"config":{},"credentialId":""}
    ],
    "edges": [{"id":"e1","source":"n1","target":"n2"}],
    "groups": [{"id":"g1","label":"Group name","nodeIds":["n1","n2"],"color":"#6366f1"}]
  },
  "requiredCredentials": ["youtube","gmail","drive","sheets","twitter","openai","webhook"]
}
Rules:
- Set action="execute" when the user clearly asks to run/execute/start the workflow now (e.g. "Oya", "Run it", "Execute", "run this now"). If action is "execute", still include the current/updated workflowGraph (complete) and requiredCredentials; the client may auto-run if connections are present.
- For action "build": return a complete new workflowGraph (>= trigger + needed nodes) with left-to-right positions.
- For action "edit": MODIFY the provided currentWorkflow/workflowGraph and return the COMPLETE updated workflowGraph.
- For action "chat": you may return minimal workflowGraph (keep current) or omit major changes; set workflowGraph to current if unsure. Do not invent a full unrelated workflow.
- Never output raw JSON in explanation. Put code only in codeBlocks.
- Use type 'code' subtype 'js' for transforms; config.code runs with $input,$secrets. Use type 'ai' for LLM steps. Use type 'action' for app/http with url/method/body in config.
- requiredCredentials must list service ids needed (e.g. google_youtube,youtube,gmail,drive,sheets,twitter,openai,webhook). Include google_* variants where applicable.
- Keep codeBlocks optional; include when helpful.`;
      const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
      const current = body.workflow || body.workflowGraph || null;
      const userContent = JSON.stringify({ request: message, currentWorkflow: current, workflowGraph: current });
      const messages = [{ role: "system", content: system }, ...history, { role: "user", content: userContent }];

      let aiRes;
      try {
        aiRes = await runAI(env, auth.uid, auth.token, {
          messages,
          provider: (body.provider as any) || undefined,
          model: body.model || undefined,
          jsonMode: true,
        });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "AI failed" }, 500);
      }

      let parsed: any = null;
      try {
        const cleaned = aiRes.text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : JSON.parse(cleaned);
      } catch {
        parsed = { explanation: aiRes.text, codeBlocks: [], workflowGraph: { nodes: [], edges: [], groups: [] }, requiredCredentials: [] };
      }
      if (!parsed || typeof parsed !== 'object') parsed = {};
      if (!parsed.action) parsed.action = 'chat';
      if (!parsed.workflowGraph || typeof parsed.workflowGraph !== 'object') parsed.workflowGraph = { nodes: [], edges: [], groups: [] };
      if (!Array.isArray(parsed.workflowGraph.nodes)) parsed.workflowGraph.nodes = [];
      if (!Array.isArray(parsed.workflowGraph.edges)) parsed.workflowGraph.edges = [];
      if (!Array.isArray(parsed.workflowGraph.groups)) parsed.workflowGraph.groups = [];
      if (!Array.isArray(parsed.requiredCredentials)) parsed.requiredCredentials = [];
      if (!Array.isArray(parsed.codeBlocks)) parsed.codeBlocks = [];

      const chatId = body.chatId || crypto.randomUUID();
      await stub.fetch("https://do/chats/append", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, title: message.slice(0, 60), messages: [
          { role: "user", content: message, ts: new Date().toISOString() },
          { role: "assistant", content: parsed.explanation || "", data: { ...parsed, aiMeta: { provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge } }, ts: new Date().toISOString(), aiMeta: { provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge } }
        ] })
      });

      return json({ ok: true, chatId, ...parsed, aiMeta: { provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge, failoverReasons: aiRes.failoverReasons || [] } });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Chat error" }, 500);
  }
}

