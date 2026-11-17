import type { Env } from "./types";
import { handleVaultRequest } from "./vault";
import { handleAgentRequest } from "./agent/routes";
import { handleChatRequest } from "./agent/chat";
import { handleToolsRequest } from "./agent/tools";
import { handleOAuthStart, handleOAuthCallback } from "./vault/oauth";
import { handleScheduled } from "./agent/scheduler";
import { handleDriveRequest } from "./drive";

export { AgentDurableObject } from "./agent/durable";
export { AutomationWorkflow } from "./agent/workflow";
export { WorkflowScheduler } from "./agent/scheduler";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Google OAuth 2.0
    if (url.pathname === "/api/oauth/google/start") return handleOAuthStart(request, env, url);
    if (url.pathname === "/api/oauth/google/callback") return handleOAuthCallback(request, env, url);

    if (url.pathname.startsWith("/api/drive")) {
      return handleDriveRequest(request, env, url);
    }

    if (url.pathname.startsWith("/api/vault")) {
      return handleVaultRequest(request, env, url);
    }
    if (url.pathname.startsWith("/api/tools/")) {
      return handleToolsRequest(request, env, url);
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

  // Cron entry point: fires saved workflows that have a schedule attached.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
