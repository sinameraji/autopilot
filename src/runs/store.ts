import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunStatus = "queued" | "running" | "waiting" | "needs_input" | "completed" | "failed" | "cancelled" | "interrupted_unknown";
export type RunEventType = "state" | "tool_intent" | "tool_result";
export type TimerCondition = "time" | "job" | "approval";
export type TimerStatus = "scheduled" | "claimed" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  sessionId: string | null;
  cwd: string;
  task: string;
  status: RunStatus;
  stopReason: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type: RunEventType;
  toolCallId: string | null;
  toolName: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface RunTimer {
  id: string;
  runId: string;
  condition: TimerCondition;
  jobId: string | null;
  wakeAt: number;
  intervalMs: number;
  status: TimerStatus;
  attempts: number;
  maxAttempts: number;
  leaseUntil: number | null;
  lastError: string | null;
  createdAt: number;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  session_id: string | null;
  cwd: string;
  task: string;
  status: RunStatus;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface TimerRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  condition_type: TimerCondition;
  job_id: string | null;
  wake_at: number;
  interval_ms: number;
  status: TimerStatus;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
}

const ALLOWED_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["waiting", "needs_input", "completed", "failed", "cancelled", "interrupted_unknown"]),
  waiting: new Set(["running", "needs_input", "failed", "cancelled"]),
  needs_input: new Set(["queued", "running", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted_unknown: new Set(),
};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/**
 * SQLite persistence for unattended runs, tool-boundary checkpoints, and
 * durable wake timers. Constructing a store only opens/migrates the schema;
 * call reconcileInterruptedRuns explicitly once at supervisor startup.
 */
export class RunStore {
  private readonly db: Database.Database;

  constructor(dbPath = defaultRunsDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        cwd TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        stop_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, tool_call_id, event_type)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence ON run_events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS run_timers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        condition_type TEXT NOT NULL,
        job_id TEXT,
        wake_at INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL DEFAULT 10000,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_timers_due ON run_timers(status, wake_at);
      CREATE INDEX IF NOT EXISTS idx_run_timers_run ON run_timers(run_id, status);
    `);
    const timerColumns = this.db.prepare("PRAGMA table_info(run_timers)").all() as Array<{ name: string }>;
    if (!timerColumns.some((column) => column.name === "interval_ms")) {
      this.db.exec("ALTER TABLE run_timers ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 10000");
    }
    try { chmodSync(dbPath, 0o600); } catch { /* existing/read-only database permissions are managed by the caller */ }
  }

  close(): void {
    this.db.close();
  }

  createRun(input: { task: string; cwd: string; sessionId?: string }): RunRecord {
    const task = input.task.trim();
    if (!task) throw new Error("task must not be empty");
    if (!input.cwd) throw new Error("cwd must not be empty");
    const id = randomUUID();
    const now = Date.now();
    const create = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO runs
        (id, session_id, cwd, task, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
        .run(id, input.sessionId ?? null, input.cwd, task, now, now);
      this.appendEvent(id, "state", null, null, { status: "queued" }, now);
    });
    create.immediate();
    return this.getRun(id)!;
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(options: { status?: RunStatus; limit?: number } = {}): RunRecord[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 50)));
    const rows = options.status
      ? this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(options.status, limit) as RunRow[]
      : this.db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map(rowToRun);
  }

  transition(id: string, status: RunStatus, reason?: string): RunRecord {
    const update = this.db.transaction(() => {
      const current = this.getRun(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      if (current.status !== status && !ALLOWED_TRANSITIONS[current.status].has(status)) {
        throw new Error(`Invalid run transition: ${current.status} -> ${status}`);
      }
      const now = Date.now();
      const startedAt = status === "running" ? current.startedAt ?? now : current.startedAt;
      const finishedAt = ["completed", "failed", "cancelled", "interrupted_unknown"].includes(status) ? now : null;
      this.db.prepare(`UPDATE runs SET status = ?, stop_reason = ?, updated_at = ?, started_at = ?, finished_at = ? WHERE id = ?`)
        .run(status, reason ?? null, now, startedAt, finishedAt, id);
      this.appendEvent(id, "state", null, null, { status, reason: reason ?? null }, now);
      return this.getRun(id)!;
    });
    return update.immediate();
  }

  /** Persist a tool intent before execution. Only hashes are retained, never raw arguments. */
  recordToolIntent(runId: string, toolCallId: string, toolName: string, args: unknown): void {
    this.assertRunActive(runId);
    this.appendEvent(runId, "tool_intent", toolCallId, toolName, {
      argumentSha256: sha256(stableJson(args)),
    });
  }

  /** Persist completion metadata after execution without storing tool output text. */
  recordToolResult(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: { ok: boolean; content: string; errorCode?: string },
  ): void {
    this.assertRunActive(runId);
    this.appendEvent(runId, "tool_result", toolCallId, toolName, {
      ok: result.ok,
      outputSha256: sha256(result.content),
      outputBytes: Buffer.byteLength(result.content, "utf8"),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sequence: row.sequence as number,
      runId: row.run_id as string,
      type: row.event_type as RunEventType,
      toolCallId: (row.tool_call_id as string | null) ?? null,
      toolName: (row.tool_name as string | null) ?? null,
      metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * On daemon startup, mark every still-running run interrupted. An unmatched
   * intent is the explicit ambiguous-action case; no tool is ever replayed.
   */
  reconcileInterruptedRuns(now = Date.now()): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as RunRow[];
    const reconcile = this.db.transaction((running: RunRow[]) => {
      const interrupted: RunRecord[] = [];
      for (const row of running) {
        const pending = this.db.prepare(`SELECT i.tool_call_id, i.tool_name FROM run_events i
          LEFT JOIN run_events r ON r.run_id = i.run_id AND r.tool_call_id = i.tool_call_id AND r.event_type = 'tool_result'
          WHERE i.run_id = ? AND i.event_type = 'tool_intent' AND r.sequence IS NULL
          ORDER BY i.sequence LIMIT 1`).get(row.id) as { tool_call_id: string; tool_name: string } | undefined;
        const reason = pending
          ? `ambiguous_tool:${pending.tool_name}:${pending.tool_call_id}`
          : "process_restart";
        this.db.prepare("UPDATE runs SET status = 'interrupted_unknown', stop_reason = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'")
          .run(reason, now, now, row.id);
        this.appendEvent(row.id, "state", null, null, { status: "interrupted_unknown", reason }, now);
        const updated = this.getRun(row.id);
        if (updated) interrupted.push(updated);
      }
      return interrupted;
    });
    return reconcile.immediate(rows);
  }

  scheduleTimer(input: {
    runId: string;
    condition: TimerCondition;
    wakeAt: number;
    intervalMs?: number;
    jobId?: string;
    maxAttempts?: number;
  }): RunTimer {
    if (!Number.isFinite(input.wakeAt)) throw new Error("wakeAt must be a finite timestamp");
    if (input.condition === "job" && !input.jobId) throw new Error("job timers require jobId");
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("maxAttempts must be an integer from 1 through 100");
    }
    const intervalMs = input.intervalMs ?? 10_000;
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("intervalMs must be an integer from 1000 through 604800000");
    }
    this.assertRunExists(input.runId);
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO run_timers
      (id, run_id, condition_type, job_id, wake_at, interval_ms, status, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`)
      .run(id, input.runId, input.condition, input.jobId ?? null, Math.trunc(input.wakeAt), intervalMs, maxAttempts, now);
    return this.getTimer(id)!;
  }

  getTimer(id: string): RunTimer | undefined {
    const row = this.db.prepare("SELECT * FROM run_timers WHERE id = ?").get(id) as TimerRow | undefined;
    return row ? rowToTimer(row) : undefined;
  }

  nextTimerAt(): number | null {
    const row = this.db.prepare(`SELECT MIN(CASE WHEN status = 'scheduled' THEN wake_at ELSE lease_until END) AS next_at
      FROM run_timers WHERE status IN ('scheduled', 'claimed') AND condition_type IN ('time', 'job')`).get() as { next_at: number | null };
    return row.next_at;
  }

  listFailedTimers(limit = 100): RunTimer[] {
    const rows = this.db.prepare(`SELECT t.* FROM run_timers t
      JOIN runs r ON r.id = t.run_id
      WHERE t.status = 'failed' AND r.status = 'waiting'
      ORDER BY t.wake_at LIMIT ?`)
      .all(Math.max(1, Math.min(500, Math.trunc(limit)))) as TimerRow[];
    return rows.map(rowToTimer);
  }

  /** Reschedule a successful job-status check without consuming failure retries. */
  rescheduleTimer(id: string, wakeAt: number): RunTimer {
    const transaction = this.db.transaction(() => {
      const timer = this.getTimer(id);
      if (!timer) throw new Error(`Timer not found: ${id}`);
      if (timer.status !== "claimed" || timer.condition !== "job") {
        throw new Error(`Timer ${id} is not a claimed job timer`);
      }
      this.db.prepare(`UPDATE run_timers SET status = 'scheduled', wake_at = ?, attempts = 0,
        lease_until = NULL, last_error = NULL WHERE id = ?`).run(Math.trunc(wakeAt), id);
      return this.getTimer(id)!;
    });
    return transaction.immediate();
  }

  /** Atomically lease timers due now; expired claims are safely retried. */
  claimDueTimers(now = Date.now(), limit = 50, leaseMs = DEFAULT_LEASE_MS): RunTimer[] {
    const cappedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const claim = this.db.transaction(() => {
      this.db.prepare(`UPDATE run_timers SET status = 'failed', lease_until = NULL,
        last_error = COALESCE(last_error, 'lease expired after maximum attempts')
        WHERE status = 'claimed' AND lease_until <= ? AND attempts >= max_attempts`).run(now);
      const rows = this.db.prepare(`SELECT * FROM run_timers
        WHERE ((status = 'scheduled' AND wake_at <= ?)
           OR (status = 'claimed' AND lease_until <= ?))
          AND condition_type IN ('time', 'job')
          AND attempts < max_attempts
        ORDER BY wake_at LIMIT ?`).all(now, now, cappedLimit) as TimerRow[];
      const update = this.db.prepare(`UPDATE run_timers SET status = 'claimed', attempts = attempts + 1, lease_until = ?
        WHERE id = ? AND attempts < max_attempts
          AND ((status = 'scheduled' AND wake_at <= ?) OR (status = 'claimed' AND lease_until <= ?))`);
      const claimed: RunTimer[] = [];
      for (const row of rows) {
        const result = update.run(now + leaseMs, row.id, now, now);
        if (result.changes === 1) {
          const updated = this.getTimer(row.id);
          if (updated) claimed.push(updated);
        }
      }
      return claimed;
    });
    return claim.immediate();
  }

  completeTimer(id: string): RunTimer {
    return this.updateTimer(id, (timer) => {
      if (timer.status !== "claimed") throw new Error(`Timer ${id} is not claimed`);
      this.db.prepare("UPDATE run_timers SET status = 'completed', lease_until = NULL, last_error = NULL WHERE id = ?").run(id);
    });
  }

  retryTimer(id: string, error: string, now = Date.now()): RunTimer {
    return this.updateTimer(id, (timer) => {
      if (timer.status !== "claimed") throw new Error(`Timer ${id} is not claimed`);
      if (timer.attempts >= timer.maxAttempts) {
        this.db.prepare("UPDATE run_timers SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?").run(error.slice(0, 1000), id);
      } else {
        const delay = Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * 2 ** Math.max(0, timer.attempts - 1));
        this.db.prepare("UPDATE run_timers SET status = 'scheduled', wake_at = ?, lease_until = NULL, last_error = ? WHERE id = ?")
          .run(now + delay, error.slice(0, 1000), id);
      }
    });
  }

  cancelTimer(id: string): RunTimer {
    return this.updateTimer(id, (timer) => {
      if (timer.status === "completed" || timer.status === "failed") return;
      this.db.prepare("UPDATE run_timers SET status = 'cancelled', lease_until = NULL WHERE id = ?").run(id);
    });
  }

  private updateTimer(id: string, update: (timer: RunTimer) => void): RunTimer {
    const transaction = this.db.transaction(() => {
      const timer = this.getTimer(id);
      if (!timer) throw new Error(`Timer not found: ${id}`);
      update(timer);
      return this.getTimer(id)!;
    });
    return transaction.immediate();
  }

  private appendEvent(runId: string, type: RunEventType, toolCallId: string | null, toolName: string | null, metadata: Record<string, unknown>, createdAt = Date.now()): void {
    this.db.prepare(`INSERT OR IGNORE INTO run_events
      (run_id, event_type, tool_call_id, tool_name, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, type, toolCallId, toolName, JSON.stringify(metadata), createdAt);
  }

  private assertRunExists(runId: string): void {
    if (!this.getRun(runId)) throw new Error(`Run not found: ${runId}`);
  }

  private assertRunActive(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "running") throw new Error(`Run ${runId} is not running (status: ${run.status})`);
  }
}

function defaultRunsDbPath(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return process.env.AUTOPILOT_RUNS_DB || join(root, "autopilot", "runs.db");
}

function stableJson(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    cwd: row.cwd,
    task: row.task,
    status: row.status,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToTimer(row: TimerRow): RunTimer {
  return {
    id: row.id,
    runId: row.run_id,
    condition: row.condition_type,
    jobId: row.job_id,
    wakeAt: row.wake_at,
    intervalMs: row.interval_ms,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}
