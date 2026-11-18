/**
 * Text extraction and safe serialisation for model/provider payloads.
 *
 * Workers AI does not have one reply shape: a model can answer with a string,
 * `{ response: "..." }`, `{ response: {...} }`, `{ result: { response } }`, an
 * array of streaming chunks, or an OpenAI-shaped `{ choices: [...] }`. Calling
 * `String()` on any of those objects is what used to put literal
 * "[object Object]" in the chat bubble, so every provider reply goes through
 * `coerceText` instead.
 */

const TEXT_KEYS = [
  "response",
  "text",
  "output_text",
  "content",
  "message",
  "output",
  "result",
  "data",
  "choices",
  "candidates",
  "delta",
  "value",
];

const PLACEHOLDERS = new Set([
  "[object Object]",
  "object Object",
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "-Infinity",
]);

export function isPlaceholder(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const s = String(value).trim();
  return !s || PLACEHOLDERS.has(s);
}

function serialise(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? "" : s;
  } catch {
    return "";
  }
}

/**
 * Best-effort readable text from any provider payload. Never returns
 * "[object Object]": objects without a text field are serialised as JSON.
 */
export function coerceText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 4) return serialise(value);

  if (Array.isArray(value)) {
    // Streaming chunks join with no separator; message arrays join line by line.
    const parts = value.map((item) => coerceText(item, depth + 1)).filter((part) => part.trim().length > 0);
    if (!parts.length) return "";
    const joined = parts.join("");
    return joined.trim().length ? joined : parts.join("\n");
  }

  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of TEXT_KEYS) {
      if (!(key in rec)) continue;
      const text = coerceText(rec[key], depth + 1);
      if (text.trim()) return text;
    }
    return serialise(value);
  }

  return "";
}

/** Text safe to drop into a chat bubble: no placeholders, no runaway whitespace. */
export function cleanText(value: unknown, max = 8000): string {
  const text = coerceText(value)
    .replace(/\[object Object\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** JSON for logs/inspection, never the string "[object Object]". */
export function safeStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return coerceText(value);
  }
}
