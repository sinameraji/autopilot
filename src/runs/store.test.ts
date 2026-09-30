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
  it("persists run state and tool boundary hashes without raw input/output", async () => withFixture(({ dir, store }) => {
    const run = store.createRun({ task: "Build the feature", cwd: dir, sessionId: "session-1" });
    assert.equal(run.status, "queued");
    store.transition(run.id, "running");
    store.recordToolIntent(run.id, "call-1", "bash", { command: "echo secret-token" });
    store.recordToolResult(run.id, "call-1", "bash", { ok: true, content: "secret-output" });

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
    const run = store.createRun({ task: "Wait for approval", cwd: dir });
    const timer = store.scheduleTimer({ runId: run.id, condition: "approval", wakeAt: 1 });
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
