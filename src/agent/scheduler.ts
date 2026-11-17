import type { Env, WorkflowGraph, WorkflowParams } from "../types";
import { cronMatches, minuteKey, parseCron } from "./cron";

// Keeps the cron -> workflow index in one Durable Object so the scheduled()
// handler can find due work without knowing which users exist.
const SCHEDULER_NAME = "cron-index";

interface DueItem {
  uid: string;
  workflowId: string;
  name: string;
  cron: string;
}

/** Pulls the cron expression out of a saved graph, or null when it isn't scheduled. */
export function extractCron(graph: WorkflowGraph | undefined): string | null {
  if (!graph) return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  for (const node of nodes) {
    if (node && node.type === "trigger" && node.subtype === "cron") {
      const cron = (node.config as Record<string, unknown> | undefined)?.cron;
      if (typeof cron === "string" && parseCron(cron)) return cron.trim();
      return null;
    }
  }
  const fallback = (graph as { schedule?: unknown }).schedule;
  if (typeof fallback === "string" && parseCron(fallback)) return fallback.trim();
  return null;
}

function schedulerStub(env: Env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName(SCHEDULER_NAME));
}

/** Called whenever a workflow is saved: arms it if it has a cron trigger, disarms it otherwise. */
export async function syncSchedule(
  env: Env,
  uid: string,
  workflowId: string,
  name: string,
  graph: WorkflowGraph | undefined
): Promise<void> {
  const cron = extractCron(graph);
  const stub = schedulerStub(env);
  if (!cron) {
    await stub.fetch("https://do/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, workflowId }),
    });
    return;
  }
  await stub.fetch("https://do/upsert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, workflowId, name, cron }),
  });
}

export class WorkflowScheduler {
  private sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        uid TEXT NOT NULL,
        workflowId TEXT NOT NULL,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        lastRunMinute TEXT,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (uid, workflowId)
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/upsert") {
        const body = (await request.json()) as { uid: string; workflowId: string; name?: string; cron: string };
        if (!body.uid || !body.workflowId || !parseCron(body.cron)) {
          return Response.json({ error: "uid, workflowId and a valid cron are required" }, { status: 400 });
        }
        const now = new Date().toISOString();
        this.sql.exec(
          `INSERT INTO schedules (uid, workflowId, name, cron, updatedAt) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(uid, workflowId) DO UPDATE SET name = ?, cron = ?, updatedAt = ?`,
          body.uid,
          body.workflowId,
          body.name || "Untitled workflow",
          body.cron.trim(),
          now,
          body.name || "Untitled workflow",
          body.cron.trim(),
          now
        );
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/remove") {
        const body = (await request.json()) as { uid: string; workflowId: string };
        this.sql.exec(`DELETE FROM schedules WHERE uid = ? AND workflowId = ?`, body.uid, body.workflowId);
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/list") {
        const rows = [...this.sql.exec(`SELECT uid, workflowId, name, cron, lastRunMinute FROM schedules`)];
        return Response.json({
          schedules: rows.map((r) => ({
            uid: String(r.uid),
            workflowId: String(r.workflowId),
            name: String(r.name),
            cron: String(r.cron),
            lastRunMinute: r.lastRunMinute == null ? null : String(r.lastRunMinute),
          })),
        });
      }

      // Returns the schedules that should fire for the given instant, and claims them
      // by writing lastRunMinute first so two overlapping cron ticks can't double-run.
      if (request.method === "GET" && url.pathname === "/due") {
        const atRaw = url.searchParams.get("at");
        const at = atRaw ? new Date(atRaw) : new Date();
        if (Number.isNaN(at.getTime())) return Response.json({ error: "invalid at" }, { status: 400 });
        const key = minuteKey(at);

        const due: DueItem[] = [];
        const rows = [...this.sql.exec(`SELECT uid, workflowId, name, cron, lastRunMinute FROM schedules`)];
        for (const row of rows) {
          const cron = String(row.cron);
          if (!cronMatches(cron, at)) continue;
          if (row.lastRunMinute != null && String(row.lastRunMinute) === key) continue;

          const already = [
            ...this.sql.exec(
              `SELECT lastRunMinute FROM schedules WHERE uid = ? AND workflowId = ?`,
              String(row.uid),
              String(row.workflowId)
            ),
          ][0];
          if (already && already.lastRunMinute != null && String(already.lastRunMinute) === key) continue;

          this.sql.exec(
            `UPDATE schedules SET lastRunMinute = ? WHERE uid = ? AND workflowId = ?`,
            key,
            String(row.uid),
            String(row.workflowId)
          );
          due.push({
            uid: String(row.uid),
            workflowId: String(row.workflowId),
            name: String(row.name),
            cron,
          });
        }
        return Response.json({ due, at: at.toISOString() });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "scheduler error";
      return Response.json({ error: message }, { status: 500 });
    }
  }
}

/**
 * Runs on every cron tick. Finds due workflows, then starts each one through the
 * existing workflow engine and records a log entry the UI already knows how to show.
 */
export async function handleScheduled(env: Env, scheduledTime: number): Promise<void> {
  const at = new Date(scheduledTime || Date.now());
  const stub = schedulerStub(env);

  const dueRes = await stub.fetch(`https://do/due?at=${encodeURIComponent(at.toISOString())}`);
  if (!dueRes.ok) return;
  const { due } = (await dueRes.json()) as { due: DueItem[] };
  if (!Array.isArray(due) || !due.length) return;

  for (const item of due) {
    const userStub = env.AGENT_STATE.get(env.AGENT_STATE.idFromName(item.uid));
    try {
      const listRes = await userStub.fetch("https://do/workflows");
      const list = (await listRes.json()) as { workflows?: Array<{ id: string; name: string; data: WorkflowGraph }> };
      const found = (list.workflows || []).find((w) => w.id === item.workflowId);

      if (!found) {
        // Workflow was deleted: stop scheduling it rather than failing every tick.
        await stub.fetch("https://do/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: item.uid, workflowId: item.workflowId }),
        });
        continue;
      }

      const logId = crypto.randomUUID();
      const now = new Date().toISOString();
      await userStub.fetch("https://do/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: logId,
          uid: item.uid,
          prompt: found.name || item.name,
          workflowId: item.workflowId,
          workflowName: found.name || item.name,
          status: "scheduled",
          nodeLogs: JSON.stringify([]),
          createdAt: now,
          updatedAt: now,
        }),
      });

      const params: WorkflowParams = {
        uid: item.uid,
        // No user session exists on a cron tick. Vault-backed providers are skipped
        // and the workflow runs on the Workers AI binding, which needs no token.
        token: "",
        logId,
        workflow: found.data,
      };
      await env.AUTOMATION_WORKFLOW.create({ params });
    } catch (err) {
      await userStub
        .fetch("https://do/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            uid: item.uid,
            prompt: item.name,
            workflowId: item.workflowId,
            workflowName: item.name,
            status: "failed",
            error: err instanceof Error ? err.message : "scheduled run failed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        })
        .catch(() => undefined);
    }
  }
}
