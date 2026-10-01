import Database from "better-sqlite3";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./store.js";

interface Fixture {
  dir: string;
  dbPath: string;
  readonly store: RunStore;
  reopen(): RunStore;
}

describe("RunStore", () => {
  it("migrates existing run databases with nullable worktree metadata", async () => withFixture(({ dir }) => {
    const dbPath = join(dir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      cwd TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      stop_reason TEXT,
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      max_tool_iterations INTEGER NOT NULL DEFAULT 100,
      max_runtime_ms INTEGER NOT NULL DEFAULT 28800000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    )`);
    legacy.prepare(`INSERT INTO runs (id, cwd, task, status, created_at, updated_at)
      VALUES ('legacy-run', ?, 'Old run', 'completed', 1, 2)`).run(dir);
    legacy.close();

    const migrated = new RunStore(dbPath);
    try {
      const run = migrated.getRun("legacy-run");
      assert.equal(run?.status, "completed");
      assert.equal(run?.sourceCwd, null);
      assert.equal(run?.repositoryRoot, null);
      assert.equal(run?.worktreePath, null);
      assert.equal(run?.branch, null);
      assert.equal(run?.maxTotalTokens, 1_000_000);
      assert.equal(run?.maxCostUsd, 5);
      assert.equal(run?.totalPromptTokens, 0);
    } finally {
      migrated.close();
    }
  }));

  it("persists worktree metadata and the worktree cwd", async () => withFixture(({ dir, store, reopen }) => {
    const worktree = {
      runId: "run-123",
      repositoryRoot: join(dir, "repo"),
      sourceCwd: join(dir, "repo", "packages", "app"),
      worktreePath: join(dir, "worktrees", "run-123"),
      cwd: join(dir, "worktrees", "run-123", "packages", "app"),
      branch: "autopilot/run/run-123",
    };
    const run = store.createRun({ id: worktree.runId, task: "Implement safely", cwd: dir, worktree });
    assert.equal(run.id, worktree.runId);
    assert.equal(run.cwd, worktree.cwd);
    assert.equal(run.sourceCwd, worktree.sourceCwd);
    assert.equal(run.repositoryRoot, worktree.repositoryRoot);
    assert.equal(run.worktreePath, worktree.worktreePath);
    assert.equal(run.branch, worktree.branch);

    const restarted = reopen();
    assert.deepEqual(restarted.getRun(run.id), run);
  }));

  it("aggregates tokens and cost across generations and fails at a ceiling", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Bound usage", cwd: dir, maxTotalTokens: 100, maxCostUsd: 1 });
    store.transition(run.id, "running");
    const first = store.recordUsage(run.id, { promptTokens: 10, completionTokens: 10, costUsd: 0.2 });
    assert.equal(first.budgetExceededReason, null);
    assert.equal(first.run.totalPromptTokens, 10);
    assert.equal(first.run.totalCompletionTokens, 10);
    assert.equal(first.run.totalCostUsd, 0.2);

    const second = store.recordUsage(run.id, { promptTokens: 40, completionTokens: 40, costUsd: 0.5 });
    assert.equal(second.budgetExceededReason, "max_total_tokens_exceeded");
    assert.equal(second.run.status, "failed");
    assert.equal(second.run.stopReason, "max_total_tokens_exceeded");
    assert.equal(second.run.totalCostUsd, 0.7);
    assert.deepEqual(store.listEvents(run.id).map((event) => event.type), ["state", "state", "usage", "usage", "state"]);
  }));

  it("fails when authoritative cumulative cost reaches its ceiling", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Stop at cost cap", cwd: dir, maxTotalTokens: 1000, maxCostUsd: 0.05 });
    store.transition(run.id, "running");
    const result = store.recordUsage(run.id, { promptTokens: 10, completionTokens: 5, costUsd: 0.05 });
    assert.equal(result.budgetExceededReason, "max_cost_usd_exceeded");
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.totalCostUsd, 0.05);
  }));

  it("fails closed when a configured cost ceiling has no authoritative cost", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Require billed cost", cwd: dir, maxCostUsd: 1 });
    store.transition(run.id, "running");
    const result = store.recordUsage(run.id, { promptTokens: 10, completionTokens: 5 });
    assert.equal(result.budgetExceededReason, "cost_unavailable");
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.costUnknownResponses, 1);
  }));

  it("allows usage without cost only when the cost ceiling is explicitly disabled", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Token-only budget", cwd: dir, maxTotalTokens: 100, maxCostUsd: null });
    store.transition(run.id, "running");
    const result = store.recordUsage(run.id, { promptTokens: 10, completionTokens: 5 });
    assert.equal(result.budgetExceededReason, null);
    assert.equal(result.run.status, "running");
    assert.equal(result.run.maxCostUsd, null);
    assert.equal(result.run.costUnknownResponses, 1);
  }));

  it("persists run state and tool boundary hashes without raw input/output", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({
      task: "Build the feature",
      cwd: dir,
      sessionId: "session-1",
      allowedTools: ["bash"],
      maxToolIterations: 12,
      maxRuntimeMs: 30_000,
    });
    assert.equal(run.status, "queued");
    assert.deepEqual(run.allowedTools, ["bash"]);
    assert.equal(run.maxToolIterations, 12);
    assert.equal(run.maxRuntimeMs, 30_000);
    store.transition(run.id, "running");
    store.recordToolIntent(run.id, "call-1", "bash", { command: "echo secret-token" });
    store.recordToolResult(run.id, "call-1", "bash", { ok: true, content: "secret-output" });
    assert.equal(store.countToolIterations(run.id), 1);

    const events = store.listEvents(run.id);
    assert.deepEqual(events.map((event) => event.type), ["state", "state", "tool_intent", "tool_result"]);
    assert.match(String(events[2]!.metadata.argumentSha256), /^[a-f0-9]{64}$/);
    assert.equal(events[3]!.metadata.outputBytes, Buffer.byteLength("secret-output"));
    assert.equal(JSON.stringify(events).includes("secret-token"), false);
    assert.equal(JSON.stringify(events).includes("secret-output"), false);
    assert.equal(store.getRun(run.id)?.startedAt !== null, true);
  }));

  it("marks an intent without a result as interrupted/unknown after restart", async () => withFixture(({ dir, store, reopen }) => {
    const run = store.createRun({ task: "Deploy safely", cwd: dir });
    store.transition(run.id, "running");
    store.recordToolIntent(run.id, "call-ambiguous", "job_start", { command: "train" });
    const restarted = reopen();

    const [interrupted] = restarted.reconcileInterruptedRuns(1234);
    assert.equal(interrupted?.status, "interrupted_unknown");
    assert.match(interrupted?.stopReason ?? "", /ambiguous_tool:job_start:call-ambiguous/);
    assert.equal(restarted.listEvents(run.id).filter((event) => event.type === "tool_intent").length, 1);
    assert.equal(restarted.listEvents(run.id).some((event) => event.type === "tool_result"), false);
    assert.deepEqual(restarted.reconcileInterruptedRuns(2345), []);
  }));

  it("does not label a run with completed tool calls as replayable after restart", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Run checks", cwd: dir });
    store.transition(run.id, "running");
    store.recordToolIntent(run.id, "call-done", "bash", { command: "npm test" });
    store.recordToolResult(run.id, "call-done", "bash", { ok: true, content: "passed" });

    const [interrupted] = store.reconcileInterruptedRuns(3456);
    assert.equal(interrupted?.status, "interrupted_unknown");
    assert.equal(interrupted?.stopReason, "process_restart");
  }));

  it("leases due timers and retries failures with bounded backoff", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Wait on a build", cwd: dir });
    const timer = store.scheduleTimer({ runId: run.id, condition: "job", jobId: "job-1", wakeAt: 100, maxAttempts: 2 });
    assert.equal(store.claimDueTimers(99).length, 0);

    const [firstClaim] = store.claimDueTimers(100, 10, 50);
    assert.equal(firstClaim?.id, timer.id);
    assert.equal(firstClaim?.attempts, 1);
    assert.equal(firstClaim?.status, "claimed");
    const retry = store.retryTimer(timer.id, "temporary supervisor error", 100);
    assert.equal(retry.status, "scheduled");
    assert.equal(retry.wakeAt, 1100);
    assert.equal(store.claimDueTimers(1099).length, 0);

    const [secondClaim] = store.claimDueTimers(1100);
    assert.equal(secondClaim?.attempts, 2);
    const failed = store.retryTimer(timer.id, "retry limit reached", 1100);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "retry limit reached");
  }));

  it("reclaims an expired timer lease and completes it exactly once", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Wait for time", cwd: dir });
    const timer = store.scheduleTimer({ runId: run.id, condition: "time", wakeAt: 1 });
    assert.equal(store.claimDueTimers(1, 1, 10)[0]?.attempts, 1);
    assert.equal(store.claimDueTimers(10).length, 0);
    const reclaimed = store.claimDueTimers(11)[0];
    assert.equal(reclaimed?.id, timer.id);
    assert.equal(reclaimed?.attempts, 2);
    assert.equal(store.completeTimer(timer.id).status, "completed");
    assert.equal(store.claimDueTimers(100).length, 0);
  }));

  it("fails an expired timer lease after its final permitted attempt", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Bound timer crashes", cwd: dir });
    const timer = store.scheduleTimer({ runId: run.id, condition: "time", wakeAt: 10, maxAttempts: 1 });
    assert.equal(store.claimDueTimers(10, 1, 5)[0]?.attempts, 1);
    assert.equal(store.claimDueTimers(15).length, 0);
    const expired = store.getTimer(timer.id);
    assert.equal(expired?.status, "failed");
    assert.match(expired?.lastError ?? "", /maximum attempts/);
  }));

  it("cancels every pending timer for an explicitly cancelled run", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Stop waiting", cwd: dir });
    const scheduled = store.scheduleTimer({ runId: run.id, condition: "time", wakeAt: 1000 });
    const claimed = store.scheduleTimer({ runId: run.id, condition: "time", wakeAt: 100 });
    store.claimDueTimers(100);
    assert.equal(store.cancelTimersForRun(run.id), 2);
    assert.equal(store.getTimer(scheduled.id)?.status, "cancelled");
    assert.equal(store.getTimer(claimed.id)?.status, "cancelled");
  }));

  it("rejects invalid state transitions and job timers without job IDs", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Task", cwd: dir });
    store.transition(run.id, "running");
    store.transition(run.id, "completed");
    assert.throws(() => store.transition(run.id, "running"), /Invalid run transition/);
    assert.throws(() => store.scheduleTimer({ runId: run.id, condition: "job", wakeAt: 100 }), /require jobId/);
  }));
});

async function withFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-runs-"));
  const dbPath = join(dir, "state", "runs.db");
  let store = new RunStore(dbPath);
  const stores = [store];
  const fixture: Fixture = {
    dir,
    dbPath,
    get store() { return store; },
    reopen() {
      store.close();
      store = new RunStore(dbPath);
      stores.push(store);
      return store;
    },
  };
  try {
    await run(fixture);
  } finally {
    for (const opened of stores) {
      try { opened.close(); } catch { /* already closed during restart test */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
