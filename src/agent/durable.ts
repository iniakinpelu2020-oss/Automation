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

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_updatedAt ON chats(updatedAt DESC);

      CREATE TABLE IF NOT EXISTS offline_keys (
        serviceId TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        salt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN workflowId TEXT`); } catch {}
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN workflowName TEXT`); } catch {}
    try { this.sql.exec(`ALTER TABLE logs ADD COLUMN nodeLogs TEXT`); } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      // --- Logs ---
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

      // --- Workflows ---
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

      // --- Chats (Assistant history) ---
      if (request.method === "GET" && url.pathname === "/chats") {
        const cursor = this.sql.exec(`SELECT id, title, createdAt, updatedAt FROM chats ORDER BY updatedAt DESC LIMIT 50`);
        const chats = [...cursor].map((row) => ({
          id: String(row.id), title: String(row.title), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
        }));
        return Response.json({ chats });
      }

      if (request.method === "POST" && url.pathname === "/chats/save") {
        const body = (await request.json()) as { id?: string; title?: string };
        const id = body.id || crypto.randomUUID();
        const now = new Date().toISOString();
        const existing = [...this.sql.exec(`SELECT id FROM chats WHERE id = ?`, id)][0] as any;
        if (existing) {
          this.sql.exec(`UPDATE chats SET title = ?, updatedAt = ? WHERE id = ?`, body.title || "Chat", now, id);
        } else {
          this.sql.exec(`INSERT INTO chats (id, title, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`, id, body.title || "New Chat", "[]", now, now);
        }
        return Response.json({ ok: true, id });
      }

      if (request.method === "POST" && url.pathname === "/chats/append") {
        const body = (await request.json()) as { chatId: string; title?: string; messages: any[] };
        const id = body.chatId;
        const now = new Date().toISOString();
        const existing = [...this.sql.exec(`SELECT id, messages, title FROM chats WHERE id = ?`, id)][0] as any;
        let msgs: any[] = [];
        if (existing) { try { msgs = JSON.parse(String(existing.messages || "[]")); } catch { msgs = []; } }
        msgs.push(...(body.messages || []));
        const title = body.title || (existing ? String(existing.title) : "New Chat");
        if (existing) {
          this.sql.exec(`UPDATE chats SET title = ?, messages = ?, updatedAt = ? WHERE id = ?`, title, JSON.stringify(msgs), now, id);
        } else {
          this.sql.exec(`INSERT INTO chats (id, title, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`, id, title, JSON.stringify(msgs), now, now);
        }
        return Response.json({ ok: true, id });
      }

      if (request.method === "GET" && url.pathname.startsWith("/chats/")) {
        const id = decodeURIComponent(url.pathname.slice("/chats/".length));
        const row = [...this.sql.exec(`SELECT id, title, messages, createdAt, updatedAt FROM chats WHERE id = ?`, id)][0] as any;
        if (!row) return Response.json({ error: "not found" }, { status: 404 });
        let messages: any[] = []; try { messages = JSON.parse(String(row.messages || "[]")); } catch {}
        return Response.json({ id: String(row.id), title: String(row.title), messages, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) });
      }

      // --- Offline key copies (AES-GCM blobs for runs with no logged-in user) ---
      if (request.method === "POST" && url.pathname === "/offline-keys") {
        const body = (await request.json()) as {
          serviceId?: string; label?: string; ciphertext?: string; iv?: string; salt?: string;
        };
        if (!body.serviceId || !body.ciphertext || !body.iv || !body.salt) {
          return Response.json({ error: "serviceId, ciphertext, iv and salt are required" }, { status: 400 });
        }
        const now = new Date().toISOString();
        this.sql.exec(
          `INSERT INTO offline_keys (serviceId, label, ciphertext, iv, salt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(serviceId) DO UPDATE SET label = ?, ciphertext = ?, iv = ?, salt = ?, updatedAt = ?`,
          body.serviceId,
          body.label ?? "",
          body.ciphertext,
          body.iv,
          body.salt,
          now,
          body.label ?? "",
          body.ciphertext,
          body.iv,
          body.salt,
          now,
        );
        return Response.json({ ok: true, serviceId: body.serviceId });
      }

      if (request.method === "GET" && url.pathname === "/offline-keys") {
        const rows = [...this.sql.exec(`SELECT serviceId, label, updatedAt FROM offline_keys ORDER BY serviceId`)];
        return Response.json({
          keys: rows.map((row) => ({
            serviceId: String(row.serviceId),
            label: String(row.label),
            updatedAt: String(row.updatedAt),
          })),
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/offline-keys/")) {
        const id = decodeURIComponent(url.pathname.slice("/offline-keys/".length));
        const row = [...this.sql.exec(
          `SELECT serviceId, label, ciphertext, iv, salt, updatedAt FROM offline_keys WHERE serviceId = ?`,
          id,
        )][0] as any;
        if (!row) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({
          serviceId: String(row.serviceId),
          label: String(row.label),
          ciphertext: String(row.ciphertext),
          iv: String(row.iv),
          salt: String(row.salt),
          updatedAt: String(row.updatedAt),
        });
      }

      if (request.method === "DELETE" && url.pathname === "/offline-keys") {
        this.sql.exec(`DELETE FROM offline_keys`);
        return Response.json({ ok: true });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/offline-keys/")) {
        const id = decodeURIComponent(url.pathname.slice("/offline-keys/".length));
        this.sql.exec(`DELETE FROM offline_keys WHERE serviceId = ?`, id);
        return Response.json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "DO error";
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
