import type { Env } from "../../types";
import { requireAuth } from "../../vault/auth";
import { runAI, type AIProvider, type AIResult } from "../aiRouter";
import { parseModelJSON } from "../jsonParse";
import { appendCopilotLog } from "../../vault/firestore";
import {
  MAX_ACTION_CALLS,
  MAX_ROUNDS,
  clampString,
  normalizeActions,
  readReply,
  systemPrompt,
  trimJSON,
  userPayload,
  type CopilotActionSchema,
  type CopilotActionResult,
  type CopilotContext,
} from "./prompt";

/**
 * POST /api/copilot - the one route behind `<ApexCopilot />` in every Apex app.
 *
 * The contract (Apex/COPILOT.md) is deliberately small:
 *
 *   1. Context is a summary, never the screen. The app writes `getContext()`
 *      and keeps it under ~2,000 tokens; this route trims anything bigger.
 *   2. The model proposes, the app disposes. This route only ever *returns*
 *      action intents. It never runs one, never writes the app's data and
 *      never approves a destructive action.
 *   3. Risk decides what happens. Every returned call carries the risk level
 *      the app registered, and `destructive` calls must be confirmed by a
 *      person in the app.
 *
 * Tool-calling rounds are capped at three. The client sends `round` (0 for the
 * first turn) and gets `round + 1` back with the calls it should run; the
 * fourth request is refused with an apology and no model call, because a model
 * still looping after three rounds is stuck and the bill should stop there.
 */

interface CopilotBody {
  app?: string;
  context?: CopilotContext;
  messages?: Array<{ role?: string; content?: string }>;
  actions?: CopilotActionSchema[];
  actionResults?: CopilotActionResult[];
  round?: number;
  provider?: string;
  model?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Chain order from COPILOT.md: Workers AI on this account (no key, no card) ->
 * the secondary provider saved in Settings/vault -> an honest error.
 */
async function runCopilotModel(
  env: Env,
  uid: string,
  token: string,
  opts: { messages: Array<{ role: string; content: string }>; provider?: string; model?: string },
): Promise<{ result: AIResult; reasons: string[] }> {
  const reasons: string[] = [];
  const requested = (opts.provider || "").trim() as AIProvider | "";

  try {
    return {
      result: await runAI(env, uid, token, {
        messages: opts.messages,
        provider: "cloudflare",
        model: requested === "cloudflare" ? opts.model : undefined,
        jsonMode: true,
      }),
      reasons,
    };
  } catch (err) {
    reasons.push(`Workers AI: ${err instanceof Error ? err.message : "failed"}`);
  }

  const secondary: AIProvider = requested && requested !== "cloudflare" ? requested : "auto";
  const result = await runAI(env, uid, token, {
    messages: opts.messages,
    provider: secondary,
    model: opts.model,
    jsonMode: true,
  });
  return { result, reasons };
}

export async function handleCopilotRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST" || url.pathname !== "/api/copilot") {
    return json({ error: "Not found" }, 404);
  }

  let auth;
  try {
    auth = await requireAuth(request);
  } catch (e) {
    return e as Response;
  }

  let body: CopilotBody;
  try {
    body = (await request.json()) as CopilotBody;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const app = clampString(body.app, 40);
  if (!app) return json({ error: "app is required" }, 400);

  const context: CopilotContext =
    body.context && typeof body.context === "object" ? body.context : {};
  const summary = clampString(context.summary, 8000);
  if (!summary) {
    return json(
      { error: "context.summary is required - the copilot reads a summary, never the screen" },
      400,
    );
  }

  const actions = normalizeActions(body.actions);
  const actionResults = Array.isArray(body.actionResults) ? body.actionResults : [];
  const history = Array.isArray(body.messages)
    ? body.messages
        .filter((m) => m && typeof m.content === "string" && m.content.trim())
        .slice(-12)
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: clampString(m.content, 4000),
        }))
    : [];

  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content || "";
  const roundRaw = typeof body.round === "number" && Number.isFinite(body.round) ? body.round : 0;
  const round = Math.max(0, Math.floor(roundRaw));

  // A model still proposing after three rounds is stuck. Apologise, spend nothing.
  if (round >= MAX_ROUNDS) {
    return json({
      ok: true,
      app,
      stopped: "round_limit",
      message:
        "I've gone round this three times without a clean answer, so I'm stopping here rather than guessing. " +
        "Try saying it in one sentence, or do that step by hand and ask me again.",
      actionCalls: [],
      round,
      hasMore: false,
      requiresConfirmation: false,
    });
  }

  const messages = [
    { role: "system", content: systemPrompt(app, actions, round) },
    ...history,
    { role: "user", content: userPayload(lastUser, context, actionResults, round) },
  ];

  let used: AIResult;
  let reasons: string[] = [];
  try {
    const first = await runCopilotModel(env, auth.uid, auth.token, {
      messages,
      provider: body.provider,
      model: clampString(body.model, 120) || undefined,
    });
    used = first.result;
    reasons = first.reasons;
  } catch (err) {
    const detail = reasons.length ? ` (${reasons.join(" | ")})` : "";
    return json(
      {
        ok: false,
        error:
          "The assistant is unavailable right now - no model answered" +
          `${detail}. Your data was not touched; try again in a minute.`,
        detail: err instanceof Error ? err.message : "model chain failed",
        failoverReasons: reasons,
        actionCalls: [],
      },
      503,
    );
  }

  let parsed = parseModelJSON(used.text);
  if (!parsed) {
    // One corrective retry, same as the in-app chat: models drift into prose.
    try {
      const retry = await runCopilotModel(env, auth.uid, auth.token, {
        messages: [
          ...messages,
          { role: "assistant", content: clampString(used.text, 1500) },
          {
            role: "user",
            content:
              "That was not valid JSON. Reply again with ONLY the single JSON object described in the system prompt: " +
              '{"message": string, "actionCalls": [{"name": string, "args": object}]}. No fences, no prose.',
          },
        ],
        provider: body.provider,
        model: clampString(body.model, 120) || undefined,
      });
      const retried = parseModelJSON(retry.result.text);
      if (retried) {
        parsed = retried;
        used = retry.result;
        reasons = reasons.concat(retry.reasons);
      }
    } catch {
      /* keep the first reply */
    }
  }

  const reply = readReply(parsed, actions, used.text);
  const message =
    reply.message ||
    "I couldn't turn that into an answer. Try rephrasing it, or ask me something smaller.";

  const nextRound = round + 1;
  const response = {
    ok: true,
    app,
    message,
    actionCalls: reply.calls,
    droppedCalls: reply.dropped,
    round: nextRound,
    hasMore: reply.calls.length > 0 && nextRound < MAX_ROUNDS,
    requiresConfirmation: reply.calls.some((c) => c.risk === "destructive"),
    usedModel: { provider: used.provider, model: used.model, badge: used.badge },
    failoverReasons: reasons,
  };

  // Per-user log in Firestore: the only way to answer "why did it change that?" later.
  try {
    const at = new Date().toISOString();
    const entries: Array<Record<string, unknown>> = [
      ...reply.calls.map((c) => ({
        app,
        action: c.name,
        risk: c.risk,
        args: JSON.stringify(c.args),
        confirmed: false,
        status: "proposed",
        round: nextRound,
        at,
      })),
      ...reply.dropped.map((d) => ({
        app,
        action: d.name,
        risk: "unknown",
        args: "",
        confirmed: false,
        status: "rejected",
        reason: d.reason,
        round: nextRound,
        at,
      })),
      ...actionResults.slice(0, MAX_ACTION_CALLS).map((r) => ({
        app,
        action: clampString(r.name, 64),
        risk: actions.find((a) => a.name === r.name)?.risk ?? "unknown",
        args: JSON.stringify(r.args ?? null).slice(0, 4000),
        confirmed: r.confirmed === true,
        status: r.error ? "failed" : "ran",
        result: trimJSON(r.result, 2000),
        error: clampString(r.error, 500) || undefined,
        round: nextRound,
        at,
      })),
    ];
    await Promise.all(entries.map((entry) => appendCopilotLog(auth.uid, auth.token, entry)));
  } catch (err) {
    console.error("copilot action log failed", err instanceof Error ? err.message : err);
  }

  return json(response);
}
