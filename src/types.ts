export interface Env {
  ASSETS: Fetcher;
  AGENT_STATE: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;
  AUTOMATION_WORKFLOW: Workflow;
  ENCRYPTION_SECRET: string;
  AI: Ai;
  DRIVE: R2Bucket;
}

export interface FirebaseTokenPayload {
  aud: string;
  iss: string;
  sub: string;
  user_id?: string;
  exp: number;
  iat: number;
  email?: string;
}

export interface AuthContext {
  uid: string;
  email?: string;
  token: string;
}

export interface VaultItem {
  serviceId: string;
  label: string;
  ciphertext: string;
  iv: string;
  salt: string;
  updatedAt: string;
}

// Workflow graph types
export interface WorkflowNode {
  id: string;
  type: "trigger" | "ai" | "action" | "code" | "condition" | "dialogue" | "script" | "branch" | "switch";
  subtype?: string; // manual, webhook, cron, time, js, twitter, youtube, gmail, drive, sheets, http, telegram, discord, dialogue, script, text, custom
  name: string;
  position?: { x: number; y: number };
  config: Record<string, unknown>;
  credentialId?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string; // e.g. "true" | "false" | "match" | "default" for branching
  label?: string;
  condition?: string;
}

export interface WorkflowGroup {
  id: string;
  label?: string;
  nodeIds: string[];
  color?: string;
}

export interface WorkflowGraph {
  id?: string;
  name?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups?: WorkflowGroup[];
  triggerType?: string;
  schedule?: string;
}

export interface AgentRunRequest {
  // legacy/simple
  prompt?: string;
  services?: string[];
  schedule?: boolean;
  mode?: "immediate" | "workflow";
  // graph
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  triggerType?: string;
  workflowId?: string;
  workflowName?: string;
}

export interface LogEntry {
  id: string;
  uid?: string;
  prompt?: string;
  workflowId?: string;
  workflowName?: string;
  status: "running" | "completed" | "failed" | "scheduled";
  result?: string;
  error?: string;
  nodeLogs?: string; // JSON string
  createdAt: string;
  updatedAt: string;
}

export interface NodeLog {
  nodeId: string;
  name: string;
  type: string;
  status: "idle" | "running" | "success" | "error";
  startedAt?: string;
  finishedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface WorkflowParams {
  uid: string;
  token: string;
  logId: string;
  workflow: WorkflowGraph;
}
