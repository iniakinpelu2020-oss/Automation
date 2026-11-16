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
      const body = await request.json() as { message: string; chatId?: string; history?: Array<{role:string;content:string}>; workflow?: any; provider?: string; model?: string };
      const message = (body.message || "").trim();
      if (!message) return json({ error: "message required" }, 400);

      const system = `You are an expert n8n-style workflow automation assistant and code generator.
Return ONLY a single valid JSON object (no markdown fences, no extra text) with this exact shape:
{
  "explanation": "Step-by-step explanation and setup guide in markdown. Include any helpful details.",
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
- Always include workflowGraph with at least a trigger node and relevant nodes/edges; positions should form a clear left-to-right layout.
- Use type 'code' with subtype 'js' for JavaScript/transform nodes; put code in config.code. Code nodes receive $input (previous node output) and $secrets (object of attached decrypted credential).
- Use type 'ai' for AI steps (config.prompt, config.model can be set to user-selected model when relevant).
- Use type 'action' for app/HTTP nodes (subtypes: http, twitter, youtube, gmail, drive, sheets, telegram, discord). Put url/method/body in config and credentialId when a saved vault credential is needed.
- requiredCredentials must list service ids the user needs connected (use google_youtube/google_gmail/google_drive/google_sheets or twitter/openai/webhook/custom as appropriate; include both plain and google_ prefixed forms when relevant, e.g. ['google_youtube','youtube']).
- codeBlocks is optional array of any standalone code snippets to show in chat.
- Be practical and complete.`;
      const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
      const userContent = JSON.stringify({ request: message, currentWorkflow: body.workflow || null });
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
      if (!parsed.workflowGraph) parsed.workflowGraph = { nodes: [], edges: [], groups: [] };
      if (!Array.isArray(parsed.requiredCredentials)) parsed.requiredCredentials = [];

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

