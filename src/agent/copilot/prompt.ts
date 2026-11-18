/**
 * Everything the copilot says to a model, and everything it refuses to believe
 * back. Kept apart from the route so the wording and the schema checks can be
 * read without the Worker plumbing.
 *
 * Contract: Apex/COPILOT.md — context is a summary, the model proposes actions,
 * the app disposes of them.
 */

export const MAX_ROUNDS = 3;
export const MAX_ACTION_CALLS = 4;
export const MAX_ACTIONS = 24;
export const MAX_CONTEXT_CHARS = 6000;

export type Risk = "read" | "write" | "destructive";

export interface CopilotActionSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  risk: Risk;
}

export interface CopilotContext {
  screen?: string;
  summary?: string;
  data?: unknown;
}

export interface CopilotActionResult {
  name?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  confirmed?: boolean;
}

export interface CopilotCall {
  name: string;
  args: Record<string, unknown>;
  risk: Risk;
}

export interface ParsedReply {
  message: string;
  calls: CopilotCall[];
  dropped: Array<{ name: string; reason: string }>;
}

export function clampString(value: unknown, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Keeps a context blob under the token budget without silently dropping fields. */
export function trimJSON(value: unknown, max = MAX_CONTEXT_CHARS): string {
  let text = "";
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return "\"(context could not be serialised)\"";
  }
  if (!text) text = "null";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (truncated by the server to stay inside the token budget)`;
}

export function normalizeActions(raw: unknown): CopilotActionSchema[] {
  if (!Array.isArray(raw)) return [];
  const out: CopilotActionSchema[] = [];
  for (const item of raw.slice(0, MAX_ACTIONS)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) continue;
    if (out.some((a) => a.name === name)) continue;
    const riskRaw = typeof rec.risk === "string" ? rec.risk.trim().toLowerCase() : "";
    const risk: Risk = riskRaw === "write" || riskRaw === "destructive" ? riskRaw : "read";
    out.push({
      name,
      description: clampString(rec.description, 400) || undefined,
      parameters:
        rec.parameters && typeof rec.parameters === "object"
          ? (rec.parameters as Record<string, unknown>)
          : { type: "object", properties: {} },
      risk,
    });
  }
  return out;
}

/** Small JSON-Schema check: types, required fields, enums, nested objects/arrays. */
export function checkArgs(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;

  const want = typeof s.type === "string" ? s.type : "";
  const typeOk = (t: string): boolean => {
    switch (t) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return !!value && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  };
  if (want && !typeOk(want)) {
    errors.push(`${path} must be a ${want}`);
    return;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === value)) {
    errors.push(`${path} must be one of: ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((v, i) => checkArgs(v, s.items, `${path}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props =
      s.properties && typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : {};
    for (const required of Array.isArray(s.required) ? s.required : []) {
      if (typeof required === "string" && obj[required] === undefined) {
        errors.push(`${path}.${required} is required`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) checkArgs(v, props[k], `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}.${k} is not allowed`);
    }
  }
}

/** Turns a model reply into calls we are willing to hand back, plus what we threw away. */
export function readReply(
  parsed: Record<string, any> | null,
  actions: CopilotActionSchema[],
  fallbackText: string,
): ParsedReply {
  const message = clampString(parsed?.message ?? parsed?.reply ?? parsed?.text ?? "", 2000);
  const rawCalls = Array.isArray(parsed?.actionCalls)
    ? parsed.actionCalls
    : Array.isArray(parsed?.actions)
      ? parsed.actions
      : [];
  const calls: CopilotCall[] = [];
  const dropped: Array<{ name: string; reason: string }> = [];

  for (const item of rawCalls.slice(0, MAX_ACTION_CALLS * 2)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const registry = actions.find((a) => a.name === name);
    if (!registry) {
      // An unknown action is a bug in the model's reply, not something to improvise around.
      dropped.push({ name: name || "(unnamed)", reason: "not a registered action" });
      continue;
    }
    if (calls.length >= MAX_ACTION_CALLS) {
      dropped.push({ name, reason: `over the ${MAX_ACTION_CALLS}-call limit for one round` });
      continue;
    }
    const argsRaw = rec.args ?? rec.arguments ?? {};
    const args =
      argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : null;
    if (!args) {
      dropped.push({ name, reason: "args must be an object" });
      continue;
    }
    const errors: string[] = [];
    checkArgs(args, registry.parameters, "args", errors);
    if (errors.length) {
      dropped.push({ name, reason: errors.slice(0, 4).join("; ") });
      continue;
    }
    calls.push({ name, args, risk: registry.risk });
  }

  const text = message || clampString(fallbackText, 2000);
  return { message: text, calls, dropped };
}

const REGISTRY_HEADER = "- Only these actions exist (name, risk, description, parameter schema):";

/** What each action means, rebuilt per request so the model cannot invent one. */
export function actionRegistry(actions: CopilotActionSchema[]): string {
  if (!actions.length) return "- (this app registered no actions; answer questions only)";
  return actions
    .map(
      (a) =>
        `- ${a.name} (${a.risk}): ${a.description || "no description"}\n  parameters: ${JSON.stringify(a.parameters)}`,
    )
    .join("\n");
}

export function systemPrompt(app: string, actions: CopilotActionSchema[], round: number): string {
  return [
    `You are Apex Copilot, the assistant built into the "${app}" app of the Apex suite.`,
    "You see only the summary the app hands you, never the raw screen, and you cannot run anything yourself. The app decides.",
    "",
    'Reply with ONE JSON object and nothing else - no markdown fences, no prose around it:',
    '{"message": string, "actionCalls": [{"name": string, "args": object}]}',
    "",
    "Rules:",
    '- "message" is plain text for the person, at most about 120 words. Never paste JSON or the action list into it.',
    REGISTRY_HEADER,
    actionRegistry(actions),
    "- An action's args must satisfy its parameter schema exactly: right types, required fields present, only allowed enum values.",
    `- Propose at most ${MAX_ACTION_CALLS} calls per round, and only when the request needs them. A question needs none: return "actionCalls": [].`,
    "- Never claim an action already happened. You propose; the app runs it and reports back in actionResults.",
    "- Never describe something as done unless actionResults says it succeeded. If a result has an error, say what failed in plain words.",
    "- Never invent ids, amounts, dates, file names or people. If a value is missing, ask for it in \"message\" and propose nothing.",
    "- Money movement, deletion and anything that leaves the account are destructive: propose them normally, but the person must confirm in the app. Never try to pre-approve or batch around that.",
    `- This is round ${round + 1} of at most ${MAX_ROUNDS}. If results from earlier rounds are present, use them and finish. If you are stuck, say so in "message" and return no calls.`,
  ].join("\n");
}

export function userPayload(
  message: string,
  context: CopilotContext,
  actionResults: CopilotActionResult[],
  round: number,
): string {
  return JSON.stringify({
    request: message,
    round: round + 1,
    context: {
      screen: clampString(context.screen, 120),
      summary: clampString(context.summary, 8000),
      data: trimJSON(context.data),
    },
    actionResults: actionResults.slice(0, MAX_ACTION_CALLS).map((r) => ({
      name: clampString(r.name, 64),
      args: r.args ?? null,
      confirmed: r.confirmed === true,
      error: clampString(r.error, 300) || undefined,
      result: trimJSON(r.result, 2500),
    })),
  });
}
