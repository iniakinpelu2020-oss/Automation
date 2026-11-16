export interface Env {
  ASSETS: Fetcher;
  AGENT_STATE: DurableObjectNamespace;
  AUTOMATION_WORKFLOW: Workflow;
  ENCRYPTION_SECRET: string;
  ["Worker AI"]: Ai;
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

export interface AgentRunRequest {
  prompt: string;
  services?: string[];
  schedule?: boolean;
  mode?: "immediate" | "workflow";
}

export interface LogEntry {
  id: string;
  uid: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "scheduled";
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowParams {
  uid: string;
  token: string;
  prompt: string;
  services: string[];
  logId: string;
}
