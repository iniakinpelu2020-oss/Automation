import type { Env } from "./types";
import { handleVaultRequest } from "./vault";
import { handleAgentRequest } from "./agent/routes";
import { handleChatRequest } from "./agent/chat";
import { handleOAuthStart, handleOAuthCallback } from "./vault/oauth";

export { AgentDurableObject } from "./agent/durable";
export { AutomationWorkflow } from "./agent/workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Google OAuth 2.0
    if (url.pathname === "/api/oauth/google/start") return handleOAuthStart(request, env, url);
    if (url.pathname === "/api/oauth/google/callback") return handleOAuthCallback(request, env, url);

    if (url.pathname.startsWith("/api/vault")) {
      return handleVaultRequest(request, env, url);
    }
    if (url.pathname.startsWith("/api/agent/chat")) {
      return handleChatRequest(request, env, url);
    }
    if (url.pathname.startsWith("/api/agent/")) {
      return handleAgentRequest(request, env, url);
    }

    // Fallback all non-/api/* requests to static assets (SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
