import type { WorkflowEdge, WorkflowGroup, WorkflowNode } from "../types";
import { extractProse } from "./jsonParse";
import { cleanText, coerceText, isPlaceholder } from "./text";

const NODE_TYPES = new Set([
  "trigger",
  "ai",
  "action",
  "code",
  "condition",
  "dialogue",
  "script",
  "branch",
  "switch",
]);

// Kept as plain strings so the file compiles against older node-type unions.
const TYPE_ALIASES: Record<string, string> = {
  start: "trigger",
  manual: "trigger",
  webhook: "trigger",
  cron: "trigger",
  schedule: "trigger",
  scheduled: "trigger",
  time: "trigger",
  timer: "trigger",
  llm: "ai",
  agent: "ai",
  model: "ai",
  javascript: "code",
  js: "code",
  transform: "code",
  function: "code",
  if: "condition",
  branch: "condition",
  router: "switch",
  http: "action",
  request: "action",
  message: "dialogue",
  say: "dialogue",
};

// Only app integrations are inferred; a plain HTTP call needs no vault entry.
const SUBTYPE_CREDENTIALS: Record<string, string[]> = {
  youtube: ["google_youtube", "youtube"],
  gmail: ["google_gmail", "gmail"],
  drive: ["google_drive", "drive"],
  sheets: ["google_sheets", "sheets"],
  twitter: ["twitter"],
  telegram: ["telegram"],
  discord: ["discord"],
  openai: ["openai"],
  github: ["github"],
};

export interface NormalizedGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: WorkflowGroup[];
}

function str(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  // String({}) is "[object Object]"; models do return objects for name,
  // subtype and explanation fields, so unwrap those before trimming.
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : coerceText(value);
  const s = raw.trim();
  return s || fallback;
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function normalizeGraph(raw: unknown, limit = 80): NormalizedGraph {
  const src = record(raw);
  const rawNodes = Array.isArray(src.nodes) ? src.nodes.slice(0, limit) : [];
  const nodes: WorkflowNode[] = [];
  const used = new Set<string>();
  const byIndex = new Map<number, string>();

  rawNodes.forEach((item, i) => {
    const n = record(item);
    let id = str(n.id ?? n.key ?? n.nodeId, `n${i + 1}`);
    if (used.has(id)) id = `${id}_${i + 1}`;
    used.add(id);
    byIndex.set(i, id);

    const typeRaw = str(n.type ?? n.kind).toLowerCase();
    const subtype = str(n.subtype ?? n.subType ?? n.sub_type).toLowerCase();
    let type: WorkflowNode["type"];
    if (NODE_TYPES.has(typeRaw)) type = typeRaw as WorkflowNode["type"];
    else if (TYPE_ALIASES[typeRaw]) type = TYPE_ALIASES[typeRaw] as WorkflowNode["type"];
    else if (NODE_TYPES.has(subtype)) type = subtype as WorkflowNode["type"];
    else if (typeRaw.includes("trigger")) type = "trigger";
    else type = "action";

    const pos = record(n.position);
    const px = Number(pos.x);
    const py = Number(pos.y);
    const position =
      Number.isFinite(px) && Number.isFinite(py)
        ? { x: px, y: py }
        : { x: 80 + (i % 4) * 260, y: 120 + Math.floor(i / 4) * 180 };

    const config = n.config !== undefined ? record(n.config) : record(n.params ?? n.settings);

    nodes.push({
      id,
      type,
      subtype: subtype || undefined,
      name: str(n.name ?? n.label ?? n.title, subtype || type),
      position,
      config,
      credentialId: str(n.credentialId ?? n.credential ?? n.credentialService),
    });
  });

  const ids = new Set(nodes.map((n) => n.id));
  const resolve = (ref: unknown): string | null => {
    if (typeof ref === "number") return byIndex.get(ref) ?? null;
    const s = str(ref);
    if (!s) return null;
    if (ids.has(s)) return s;
    const asNum = Number(s);
    if (Number.isInteger(asNum)) return byIndex.get(asNum) ?? null;
    return null;
  };

  const rawEdges = Array.isArray(src.edges) ? src.edges.slice(0, limit * 4) : [];
  const edges: WorkflowEdge[] = [];
  const edgeKeys = new Set<string>();
  rawEdges.forEach((item, i) => {
    const e = record(item);
    const source = resolve(e.source ?? e.from ?? e.sourceId);
    const target = resolve(e.target ?? e.to ?? e.targetId);
    if (!source || !target || source === target) return;
    const handle = str(e.sourceHandle ?? e.handle ?? e.label ?? e.branch).toLowerCase();
    const key = `${source}->${target}:${handle}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const edge: WorkflowEdge = { id: str(e.id, `e${i + 1}`), source, target };
    // Branch metadata lives outside the older WorkflowEdge shape, so attach it
    // defensively rather than relying on the deployed type version.
    const meta = edge as WorkflowEdge & { sourceHandle?: string; label?: string; condition?: string };
    meta.sourceHandle = handle || undefined;
    meta.label = str(e.label) || undefined;
    meta.condition = str(e.condition) || undefined;
    edges.push(edge);
  });

  const rawGroups = Array.isArray(src.groups) ? src.groups.slice(0, 25) : [];
  const groups: WorkflowGroup[] = [];
  rawGroups.forEach((item, i) => {
    const g = record(item);
    const nodeIds = (Array.isArray(g.nodeIds) ? g.nodeIds : []).map((id) => str(id)).filter((id) => ids.has(id));
    if (!nodeIds.length) return;
    groups.push({
      id: str(g.id, `g${i + 1}`),
      label: str(g.label, "Group"),
      nodeIds,
      color: str(g.color) || undefined,
    });
  });

  return { nodes, edges, groups };
}

export function inferCredentials(nodes: WorkflowNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const subtype = (n.subtype || "").toLowerCase();
    for (const service of SUBTYPE_CREDENTIALS[subtype] || []) {
      if (!out.includes(service)) out.push(service);
    }
  }
  return out;
}

const EXECUTE_PATTERNS = [
  /^(?:oya|oke|ok)\b[\s!.?]*$/i,
  /^(?:run|execute|start)\s*(?:it|this|the\s+workflow|workflow)?(?:\s+(?:now|please))?[\s!.?]*$/i,
  /^(?:run|execute|start)\s+now[\s!.?]*$/i,
  /^(?:go|fire|ship\s+it|do\s+it|proceed|carry\s+on)[\s!.?]*$/i,
  /^(?:let'?s|lets)\s+(?:go|run|execute)[\s!.?]*$/i,
  /^(?:yes|yep|yeah)[, ]+(?:run|go|execute)\s*(?:it|this)?[\s!.?]*$/i,
];

/** True when the message is almost certainly "run the workflow now". */
export function detectExecuteIntent(message: string): boolean {
  const s = String(message ?? "").trim();
  if (!s || s.length > 32) return false;
  return EXECUTE_PATTERNS.some((re) => re.test(s));
}

function looksLikeJSON(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  return t.includes('"') || t.includes("workflowGraph") || t.includes(":");
}

/**
 * Guarantee the chat text is prose: prefer the model's explanation field,
 * otherwise salvage readable text, otherwise say something useful.
 */
export function cleanExplanation(parsed: Record<string, any> | null, rawText: string): string {
  const field = cleanText(parsed?.explanation ?? parsed?.message ?? parsed?.summary, 6000);
  if (field && !looksLikeJSON(field) && !isPlaceholder(field)) return field;

  const prose = cleanText(extractProse(rawText), 6000);
  if (prose && !looksLikeJSON(prose) && !isPlaceholder(prose)) return prose;

  if (field && !looksLikeJSON(field) && !isPlaceholder(field)) return field;
  return "";
}
