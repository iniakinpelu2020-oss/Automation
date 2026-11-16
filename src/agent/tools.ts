import type { Env } from "../types";
import { requireAuth } from "../vault/auth";
import { webSearch } from "./webSearch";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleToolsRequest(request: Request, env: Env, url: URL): Promise<Response> {
  let auth;
  try { auth = await requireAuth(request); } catch (e) { return e as Response; }
  try {
    if (request.method === "POST" && url.pathname === "/api/tools/search") {
      const body = await request.json().catch(() => ({})) as { query?: string };
      const query = (body.query || "").trim();
      if (!query) return json({ error: "query is required" }, 400);
      const result = await webSearch(env, auth.uid, auth.token, query);
      return json({ ok: true, query, ...result });
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Tool error" }, 500);
  }
}
