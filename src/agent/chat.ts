import type { Env } from "../types";
import { requireAuth } from "../vault/auth";
import { runAI } from "./aiRouter";
import { cleanExplanation, detectExecuteIntent, inferCredentials, normalizeGraph } from "./graphNormalize";
import { parseModelJSON } from "./jsonParse";
import { cleanText, coerceText } from "./text";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function getStub(env: Env, uid: string) {
  return env.AGENT_STATE.get(env.AGENT_STATE.idFromName(uid));
}

const SYSTEM_PROMPT = `You are an expert n8n-style workflow automation assistant and code generator.
Classify intent into action: "build" (create new workflow from scratch), "edit" (modify the provided currentWorkflow/workflowGraph), "execute" (user explicitly wants to run/execute the current workflow now), or "chat" (explanations/questions only, no workflow changes needed).
Return ONLY a single valid JSON object. No markdown fences, no prose before or after it, no comments, no trailing commas.
{
  "action": "build" | "edit" | "execute" | "chat",
  "explanation": "Clear markdown explanation of what you built or changed. Never include raw JSON here.",
  "codeBlocks": [{"language":"javascript","title":"optional title","code":"..."}],
  "workflowGraph": {
    "nodes": [
      {"id":"n1","type":"trigger|ai|code|action|condition|dialogue|script|branch","subtype":"manual|webhook|cron|time|workers-ai|js|http|twitter|youtube|gmail|drive|sheets|telegram|discord|dialogue|message|if","name":"Label","position":{"x":80,"y":140},"config":{},"credentialId":""}
    ],
    "edges": [{"id":"e1","source":"n1","target":"n2","sourceHandle":"true|false (for branches)","label":"true|false"}],
    "groups": [{"id":"g1","label":"Group name","nodeIds":["n1","n2"],"color":"#6366f1"}]
  },
  "requiredCredentials": ["youtube","gmail","drive","sheets","twitter","openai","webhook"]
}
Rules:
- Set action="execute" when the user asks to run/start the workflow now (e.g. "Oya", "Run it", "Execute", "go", "do it"). Keep the complete current workflowGraph and requiredCredentials; the client runs it immediately.
- For action "build": return a complete new workflowGraph (trigger + needed nodes) with left-to-right positions (x grows by ~260 per step, same row y).
- For action "edit": MODIFY the provided currentWorkflow/workflowGraph and return the COMPLETE updated workflowGraph, keeping existing node ids so unchanged nodes stay put.
- For action "chat": return the current workflowGraph unchanged (never an empty graph when a workflow exists). Do not invent a new workflow for greetings or questions.
- Never output raw JSON in explanation. Put code only in codeBlocks.
- Use type 'code' subtype 'js' for transforms; config.code runs with $input,$secrets. Use type 'ai' for LLM steps. Use type 'action' for app/http with url/method/body in config.
- requiredCredentials must list service ids needed (e.g. google_youtube,youtube,gmail,drive,sheets,twitter,openai,webhook). Include google_* variants where applicable.
- Support advanced multi-step flows: conditional/branch nodes (text matching, time triggers like 10:00 AM, API response/status checks) with edges using sourceHandle/label "true"/"false"; dialogue/script nodes for conversational/scripted steps; cron/time triggers. Pass data between steps via {{$json.output}}, {{$input}}, {{nodeId.output}}.
- Keep codeBlocks optional; include when helpful.`;

interface ChatNode {
  type?: string;
  subtype?: string;
}

function normalizeAction(value: unknown): "build" | "edit" | "execute" | "chat" {
  const s = coerceText(value).trim().toLowerCase();
  if (s === "build" || s === "create" || s === "new") return "build";
  if (s === "edit" || s === "update" || s === "modify") return "edit";
  if (s === "execute" || s === "run" || s === "start") return "execute";
  return "chat";
}

function normalizeCodeBlocks(value: unknown): Array<{ language: string; title?: string; code: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ language: string; title?: string; code: string }> = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    // Some models nest the source one level deeper, or return it as a part array.
    const code = cleanText(b.code ?? b.snippet ?? b.source ?? b.content, 20000);
    if (!code.trim()) continue;
    const language = coerceText(b.language).trim();
    const title = coerceText(b.title).trim();
    out.push({
      language: language || "javascript",
      title: title || undefined,
      code,
    });
  }
  return out;
}

function normalizeCredentials(value: unknown, nodes: ChatNode[]): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    const clean = id.trim().toLowerCase();
    if (!clean) return;
    if (!/^[a-z0-9_-]+$/.test(clean)) return;
    if (!out.includes(clean)) out.push(clean);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        add(String(rec.serviceId ?? rec.service ?? rec.id ?? rec.name ?? ""));
      }
    }
  }
  for (const service of inferCredentials(nodes as any)) add(service);
  return out;
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
      const body = await request.json() as { message: string; chatId?: string; history?: Array<{ role: string; content: string }>; workflow?: any; workflowGraph?: any; provider?: string; model?: string };
      const message = (body.message || "").trim();
      if (!message) return json({ error: "message required" }, 400);

      const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
      const currentRaw = body.workflow || body.workflowGraph || null;
      const currentGraph = normalizeGraph(currentRaw);
      const hasCurrent = currentGraph.nodes.length > 0;

      const userContent = JSON.stringify({ request: message, currentWorkflow: currentGraph, workflowGraph: currentGraph });
      const baseMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: userContent }];
      const runOpts = {
        provider: (body.provider as any) || undefined,
        model: body.model || undefined,
        jsonMode: true as const,
      };

      let aiRes;
      try {
        aiRes = await runAI(env, auth.uid, auth.token, { messages: baseMessages, ...runOpts });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "AI failed" }, 500);
      }

      // Workers AI can hand back { response }, { result }, or a chunk array;
      // coerce once here so every later step works on a plain string.
      let aiText = coerceText(aiRes.text);
      let parsed = parseModelJSON(aiText);

      // One corrective retry: models sometimes answer with prose or broken JSON.
      if (!parsed) {
        try {
          const retry = await runAI(env, auth.uid, auth.token, {
            messages: [
              ...baseMessages,
              { role: "assistant", content: aiText.slice(0, 1500) },
              { role: "user", content: "That reply was not valid JSON. Reply again with ONLY the single JSON object described in the system prompt: no markdown fences, no prose, no comments." },
            ],
            ...runOpts,
          });
          const retried = parseModelJSON(coerceText(retry.text));
          if (retried) { parsed = retried; aiRes = retry; aiText = coerceText(retry.text); }
        } catch { /* keep the original reply */ }
      }

      const explanation = cleanText(cleanExplanation(parsed, aiText));
      const codeBlocks = normalizeCodeBlocks(parsed?.codeBlocks);

      let action = normalizeAction(parsed?.action);
      let graph = normalizeGraph(parsed?.workflowGraph);

      // Never hand the canvas back empty when it already had a workflow.
      if (!graph.nodes.length && hasCurrent) graph = currentGraph;

      // Deterministic execute detection ("Oya", "run it", "go").
      if (detectExecuteIntent(message) && graph.nodes.length) action = "execute";

      let text = explanation;
      if (action === "execute") {
        if (!graph.nodes.length) {
          action = "chat";
          text = text || "There's no workflow on the canvas yet. Describe what you want to build and I'll create it.";
        } else {
          text = text || "Running the workflow now.";
        }
      } else if (action === "build" && !graph.nodes.length) {
        action = "chat";
        text = text || "I couldn't turn that reply into a workflow. Try describing the steps you want, or press Send again.";
      } else if (!text) {
        text = action === "edit"
          ? "Updated the workflow on the canvas. Check the nodes, then press Execute Workflow to run it."
          : graph.nodes.length
            ? `Here's the workflow I prepared (${graph.nodes.length} step${graph.nodes.length === 1 ? "" : "s"}). Review it on the canvas, then press Execute Workflow.`
            : "I couldn't read that reply as a workflow. Try rephrasing it, or switch provider in the selector above and send again.";
      }
      // Final guard: the chat bubble and the stored chat both get prose, never a
      // placeholder or a stringified object.
      text = cleanText(text) || "I couldn't read that reply as a workflow. Try rephrasing it, or switch provider in the selector above and send again.";

      const requiredCredentials = normalizeCredentials(parsed?.requiredCredentials, graph.nodes);
      const chatId = body.chatId || crypto.randomUUID();
      const aiMeta = { provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge, failoverReasons: aiRes.failoverReasons || [] };

      await stub.fetch("https://do/chats/append", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId, title: message.slice(0, 60), messages: [
            { role: "user", content: message, ts: new Date().toISOString() },
            {
              role: "assistant",
              content: text,
              data: { action, explanation: text, codeBlocks, workflowGraph: graph, requiredCredentials },
              ts: new Date().toISOString(),
              aiMeta: { provider: aiRes.provider, model: aiRes.model, badge: aiRes.badge },
            },
          ],
        }),
      });

      return json({
        ok: true,
        chatId,
        action,
        explanation: text,
        codeBlocks,
        workflowGraph: graph,
        requiredCredentials,
        aiMeta,
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Chat error" }, 500);
  }
}
