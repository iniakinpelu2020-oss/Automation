import type { LogEntry } from "../types";

export class AgentDurableObject {
  private state: DurableObjectState;
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_createdAt ON logs(createdAt DESC);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/log") {
        const entry = (await request.json()) as LogEntry;
        this.sql.exec(
          `INSERT INTO logs (id, prompt, status, result, error, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          entry.id,
          entry.prompt,
          entry.status,
          entry.result ?? null,
          entry.error ?? null,
          entry.createdAt,
          entry.updatedAt,
        );
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/log/update") {
        const body = (await request.json()) as { id: string; status: string; result?: string; error?: string };
        this.sql.exec(
          `UPDATE logs SET status = ?, result = ?, error = ?, updatedAt = ? WHERE id = ?`,
          body.status,
          body.result ?? null,
          body.error ?? null,
          new Date().toISOString(),
          body.id,
        );
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/logs") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100);
        const cursor = this.sql.exec(
          `SELECT id, prompt, status, result, error, createdAt, updatedAt FROM logs ORDER BY createdAt DESC LIMIT ?`,
          limit,
        );
        const logs = [...cursor].map((row) => ({
          id: String(row.id),
          prompt: String(row.prompt),
          status: String(row.status),
          result: row.result == null ? undefined : String(row.result),
          error: row.error == null ? undefined : String(row.error),
          createdAt: String(row.createdAt),
          updatedAt: String(row.updatedAt),
        }));
        return Response.json({ logs });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "DO error";
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
