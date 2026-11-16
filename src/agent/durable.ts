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
        prompt TEXT NOT NULL DEFAULT '',
        workflowId TEXT,
        workflowName TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        nodeLogs TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_createdAt ON logs(createdAt DESC);

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_updatedAt ON workflows(updatedAt DESC);
    `);
    // best-effort migrations for older schema
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN workflowId TEXT`); } catch {}
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN workflowName TEXT`); } catch {}
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN nodeLogs TEXT`); } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/log") {
        const entry = (await request.json()) as LogEntry;
        this.sql.exec(
          `INSERT INTO logs (id, prompt, workflowId, workflowName, status, result, error, nodeLogs, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          entry.id,
          entry.prompt ?? entry.workflowName ?? "",
          entry.workflowId ?? null,
          entry.workflowName ?? null,
          entry.status,
          entry.result ?? null,
          entry.error ?? null,
          entry.nodeLogs ?? null,
          entry.createdAt,
          entry.updatedAt,
        );
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/log/update") {
        const body = (await request.json()) as {
          id: string; status?: string; result?: string; error?: string; nodeLogs?: string; workflowId?: string; workflowName?: string; prompt?: string;
        };
        // read current to allow partial updates
        const cur = [...this.sql.exec(`SELECT * FROM logs WHERE id = ?`, body.id)][0] as any;
        if (!cur) return Response.json({ error: "not found" }, { status: 404 });
        this.sql.exec(
          `UPDATE logs SET status = ?, result = ?, error = ?, nodeLogs = ?, workflowId = ?, workflowName = ?, prompt = ?, updatedAt = ? WHERE id = ?`,
          body.status ?? cur.status,
          body.result !== undefined ? body.result : cur.result,
          body.error !== undefined ? body.error : cur.error,
          body.nodeLogs !== undefined ? body.nodeLogs : cur.nodeLogs,
          body.workflowId !== undefined ? body.workflowId : cur.workflowId,
          body.workflowName !== undefined ? body.workflowName : cur.workflowName,
          body.prompt !== undefined ? body.prompt : cur.prompt,
          new Date().toISOString(),
          body.id,
        );
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/logs") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 100);
        const cursor = this.sql.exec(
          `SELECT id, prompt, workflowId, workflowName, status, result, error, nodeLogs, createdAt, updatedAt FROM logs ORDER BY createdAt DESC LIMIT ?`,
          limit,
        );
        const logs = [...cursor].map((row) => ({
          id: String(row.id),
          prompt: row.prompt == null ? "" : String(row.prompt),
          workflowId: row.workflowId == null ? undefined : String(row.workflowId),
          workflowName: row.workflowName == null ? undefined : String(row.workflowName),
          status: String(row.status),
          result: row.result == null ? undefined : String(row.result),
          error: row.error == null ? undefined : String(row.error),
          nodeLogs: row.nodeLogs == null ? undefined : String(row.nodeLogs),
          createdAt: String(row.createdAt),
          updatedAt: String(row.updatedAt),
        }));
        return Response.json({ logs });
      }

      // Workflows CRUD
      if (request.method === "POST" && url.pathname === "/workflows/save") {
        const body = (await request.json()) as { id?: string; name: string; data: unknown };
        const id = body.id || crypto.randomUUID();
        const now = new Date().toISOString();
        const existing = [...this.sql.exec(`SELECT id, createdAt FROM workflows WHERE id = ?`, id)][0] as any;
        if (existing) {
          this.sql.exec(`UPDATE workflows SET name = ?, data = ?, updatedAt = ? WHERE id = ?`, body.name, JSON.stringify(body.data), now, id);
          return Response.json({ ok: true, id, createdAt: existing.createdAt, updatedAt: now });
        } else {
          this.sql.exec(`INSERT INTO workflows (id, name, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`, id, body.name, JSON.stringify(body.data), now, now);
          return Response.json({ ok: true, id, createdAt: now, updatedAt: now });
        }
      }

      if (request.method === "GET" && url.pathname === "/workflows") {
        const cursor = this.sql.exec(`SELECT id, name, data, createdAt, updatedAt FROM workflows ORDER BY updatedAt DESC LIMIT 50`);
        const workflows = [...cursor].map((row) => ({
          id: String(row.id),
          name: String(row.name),
          data: JSON.parse(String(row.data)),
          createdAt: String(row.createdAt),
          updatedAt: String(row.updatedAt),
        }));
        return Response.json({ workflows });
      }

      if (request.method === "GET" && url.pathname.startsWith("/workflows/")) {
        const id = url.pathname.split("/").pop() || "";
        const row = [...this.sql.exec(`SELECT id, name, data, createdAt, updatedAt FROM workflows WHERE id = ?`, id)][0] as any;
        if (!row) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ id: String(row.id), name: String(row.name), data: JSON.parse(String(row.data)), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "DO error";
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
