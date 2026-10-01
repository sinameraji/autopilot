import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../jobs/manager.js";
import { RunStore } from "./store.js";
import { RunWakeScheduler } from "./wake-scheduler.js";

interface Fixture {
  dir: string;
  runsDbPath: string;
  jobsDbPath: string;
  store: RunStore;
  addScheduler(scheduler: RunWakeScheduler): RunWakeScheduler;
  addManager(manager: JobManager): JobManager;
}

describe("RunWakeScheduler", () => {
  it("resumes a waiting run when its durable time timer is due", async () => withFixture(async ({ dir, store, runsDbPath, jobsDbPath, addScheduler }) => {
    const run = createWaitingRun(store, dir, "Wait until later");
    const timer = store.scheduleTimer({ runId: run.id, condition: "time", wakeAt: 100 });
    const wakes: string[] = [];
    const scheduler = addScheduler(new RunWakeScheduler({
      onWake: async (event) => {
        wakes.push(event.timerId);
        assert.equal(store.getRun(event.runId)?.status, "running");
      },
      runsDbPath,
      jobsDbPath,
    }));

    assert.equal(await scheduler.processDueTimers(99), 0);
    assert.equal(await scheduler.processDueTimers(100), 1);
    assert.deepEqual(wakes, [timer.id]);
    assert.equal(store.getTimer(timer.id)?.status, "completed");
    assert.equal(store.getRun(run.id)?.status, "running");
  }));

  it("fails the run when a wake callback exhausts its retry limit", async () => withFixture(async ({ dir, store, runsDbPath, jobsDbPath, addScheduler }) => {
    const run = createWaitingRun(store, dir, "Fail wake callback");
    const timer = store.scheduleTimer({ runId: run.id, condition: "time", wakeAt: 10, maxAttempts: 1 });
    const scheduler = addScheduler(new RunWakeScheduler({
      onWake: async () => { throw new Error("wake callback failed"); },
      runsDbPath,
      jobsDbPath,
    }));

    assert.equal(await scheduler.processDueTimers(10), 1);
    assert.equal(store.getTimer(timer.id)?.status, "failed");
    assert.equal(store.getRun(run.id)?.status, "failed");
    assert.match(store.getRun(run.id)?.stopReason ?? "", /timer_wake_failed/);
  }));

  it("leaves approval timers for the inbound approval handler", async () => withFixture(async ({ dir, store, runsDbPath, jobsDbPath, addScheduler }) => {
    const run = createWaitingRun(store, dir, "Wait for a person");
    const timer = store.scheduleTimer({ runId: run.id, condition: "approval", wakeAt: 10 });
    const scheduler = addScheduler(new RunWakeScheduler({ onWake: () => assert.fail("approval timer must not wake automatically"), runsDbPath, jobsDbPath }));

    assert.equal(await scheduler.processDueTimers(10), 0);
    assert.equal(store.getTimer(timer.id)?.status, "scheduled");
    assert.equal(store.nextTimerAt(), null);
  }));

  it("pauses a waiting run when its configured runtime budget expires", async () => withFixture(async ({ dir, store, runsDbPath, jobsDbPath, addScheduler }) => {
    const created = store.createRun({ task: "Respect runtime budget", cwd: dir, maxRuntimeMs: 1000 });
    const running = store.transition(created.id, "running");
    const waiting = store.transition(running.id, "waiting");
    const wakeAt = (waiting.startedAt ?? waiting.createdAt) + 1000;
    const timer = store.scheduleTimer({ runId: waiting.id, condition: "time", wakeAt });
    let wakeCalls = 0;
    const scheduler = addScheduler(new RunWakeScheduler({ onWake: () => { wakeCalls++; }, runsDbPath, jobsDbPath }));

    assert.equal(await scheduler.processDueTimers(wakeAt), 1);
    assert.equal(store.getRun(waiting.id)?.status, "needs_input");
    assert.equal(store.getRun(waiting.id)?.stopReason, "max_runtime_exceeded");
    assert.equal(store.getTimer(timer.id)?.status, "cancelled");
    assert.equal(wakeCalls, 0);
  }));
  it("reschedules active job checks without consuming failed-wake retries", async () => withFixture(async ({ dir, store, runsDbPath, jobsDbPath, addScheduler, addManager }) => {
    const run = createWaitingRun(store, dir, "Wait for build");
    const jobs = addManager(new JobManager(jobsDbPath));
    const job = jobs.start({ command: "sleep 30", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
    const timer = store.scheduleTimer({ runId: run.id, condition: "job", jobId: job.id, wakeAt: 100, intervalMs: 2000 });
    let wakeCalls = 0;
    const scheduler = addScheduler(new RunWakeScheduler({
      onWake: () => { wakeCalls++; },
      runsDbPath,
      jobsDbPath,
    }));

    assert.equal(await scheduler.processDueTimers(100), 1);
    const rescheduled = store.getTimer(timer.id)!;
    assert.equal(rescheduled.status, "scheduled");
    assert.equal(rescheduled.wakeAt, 2100);
    assert.equal(rescheduled.intervalMs, 2000);
    assert.equal(rescheduled.attempts, 0);
    assert.equal(store.getRun(run.id)?.status, "waiting");
    assert.equal(wakeCalls, 0);
  }));
});

function createWaitingRun(store: RunStore, cwd: string, task: string) {
  const run = store.createRun({ task, cwd });
  store.transition(run.id, "running");
  return store.transition(run.id, "waiting");
}

async function withFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-wake-"));
  const runsDbPath = join(dir, "runs.db");
  const jobsDbPath = join(dir, "jobs.db");
  const store = new RunStore(runsDbPath);
  const schedulers: RunWakeScheduler[] = [];
  const managers: JobManager[] = [];
  const fixture: Fixture = {
    dir,
    runsDbPath,
    jobsDbPath,
    store,
    addScheduler: (scheduler) => { schedulers.push(scheduler); return scheduler; },
    addManager: (manager) => { managers.push(manager); return manager; },
  };
  try {
    await run(fixture);
  } finally {
    for (const scheduler of schedulers) scheduler.dispose();
    for (const manager of managers) {
      try {
        for (const job of manager.list()) {
          if (["starting", "running", "cancelling"].includes(job.status)) manager.cancel(job.id);
        }
        manager.close();
      } catch { /* already closed */ }
    }
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
}
