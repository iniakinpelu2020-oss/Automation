/**
 * Tolerant parsing for LLM JSON replies.
 *
 * Models (Workers AI / Llama especially) often wrap the JSON in markdown
 * fences, add a sentence before or after it, leave a trailing comma, embed a
 * raw newline inside a string, or get cut off mid-object. Every one of those
 * makes JSON.parse throw -- which is what used to send raw model text to the
 * chat bubble and leave the canvas empty.
 */

function fencedBlocks(input: string): string[] {
  const out: string[] = [];
  const re = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const body = (m[1] || "").trim();
    if (body) out.push(body);
  }
  return out;
}

/** Pick the fenced block that most looks like our structured reply. */
export function stripFences(input: string): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  const blocks = fencedBlocks(s);
  if (blocks.length) {
    const best =
      blocks.find((b) => b.includes('"workflowGraph"')) ||
      blocks.find((b) => b.includes("{")) ||
      blocks[0];
    if (best) return best.trim();
  }
  return s
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
}

/** Extract the first balanced JSON object, ignoring braces inside strings. */
export function extractBalancedJSON(input: string): string | null {
  const s = String(input ?? "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Remove comments, normalise smart quotes and escape raw control characters
 * that appear inside string literals.
 */
export function sanitizeJSON(input: string): string {
  const s = String(input ?? "");
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      if (ch === "\u201c" || ch === "\u201d") { out += '\\"'; continue; }
      out += ch;
      continue;
    }
    if (ch === "\u201c" || ch === "\u201d") { inString = true; out += '"'; continue; }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Close a JSON object that the model cut off mid-flight. */
export function balanceTruncatedJSON(input: string): string | null {
  const s = String(input ?? "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let out = s.slice(start);
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) out += '"';
  // drop a dangling ", "key": or "," left behind by the cut
  out = out.replace(/,\s*$/, "");
  out = out.replace(/"([^"\\]|\\.)*"\s*:\s*$/, "");
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop();
  return out;
}

function fixTrailingCommas(input: string): string {
  return String(input ?? "").replace(/,\s*([}\]])/g, "$1");
}

/**
 * Parse a model reply into an object. Returns null only when every strategy
 * fails (i.e. the reply contains no usable JSON at all).
 */
export function parseModelJSON(text: string): Record<string, any> | null {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;

  const candidates: string[] = [];
  const push = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };

  const fenced = stripFences(raw);
  push(raw);
  push(fenced);
  push(extractBalancedJSON(fenced));
  push(extractBalancedJSON(raw));

  const base = candidates.slice();
  for (const c of base) {
    const clean = sanitizeJSON(c);
    push(clean);
    push(fixTrailingCommas(clean));
  }
  push(balanceTruncatedJSON(sanitizeJSON(fenced || raw)));
  push(fixTrailingCommas(balanceTruncatedJSON(sanitizeJSON(raw)) || ""));

  for (const c of candidates) {
    try {
      let value: any = JSON.parse(c);
      // Some models double-encode: the object arrives as a JSON string.
      if (typeof value === "string" && value.trim().startsWith("{")) {
        try { value = JSON.parse(value); } catch { /* keep string */ }
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, any>;
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Best-effort human-readable text when the reply is not usable JSON, so the
 * chat never shows a wall of braces.
 */
export function extractProse(input: string): string {
  const s = String(input ?? "").trim();
  if (!s) return "";
  let rest = s;
  const balanced = extractBalancedJSON(s);
  if (balanced) rest = s.split(balanced).join(" ");
  const truncated = balanceTruncatedJSON(sanitizeJSON(s));
  if (truncated && truncated.length > 40) rest = rest.split(truncated).join(" ");
  rest = rest.replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, (whole, body) =>
    String(body).includes("{") ? " " : whole,
  );
  rest = rest.replace(/^\s*[\{\}\[\],]+\s*$/gm, " ");
  return rest.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
