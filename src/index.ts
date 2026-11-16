import type { Env } from "./types";
import { handleVaultRequest } from "./vault";
import { handleAgentRequest } from "./agent/routes";

export { AgentDurableObject } from "./agent/durable";
export { AutomationWorkflow } from "./agent/workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/vault")) {
      return handleVaultRequest(request, env, url);
    }
    if (url.pathname.startsWith("/api/agent/")) {
      return handleAgentRequest(request, env, url);
    }

    // Fallback all non-/api/* requests to static assets (SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
