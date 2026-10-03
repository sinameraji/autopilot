import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActiveWorker } from "../agent/supervisor.js";
import type { JobRecord } from "../jobs/manager.js";
import { activityFromJob, activityFromWorker, diffActivityItems, isActiveJob } from "./activity.js";

const job = (status: JobRecord["status"], patch: Partial<JobRecord> = {}): JobRecord => ({
  id: "job-1",
  command: "npm run dev",
  cwd: "/project",
  status,
  pid: 10,
  pgid: 10,
  processStartTime: "start",
  createdAt: 100,
  finishedAt: null,
  exitCode: null,
  stdoutPath: "/tmp/out",
  stderrPath: "/tmp/err",
  idempotencyKey: null,
  ...patch,
});

const worker = (patch: Partial<ActiveWorker> = {}): ActiveWorker => ({
  id: "worker-1",
  mode: "plan",
  task: "inspect sessions",
  status: "running",
  startedAt: 100,
  logs: [],
  ...patch,
});

describe("activity adapters", () => {
  it("sends an authoritative first snapshot, then only changes and removals", () => {
    const initial = activityFromJob(job("running"));
    const snapshot = diffActivityItems(new Map(), [initial], false);
    assert.deepEqual(snapshot, [{ type: "ActivitySnapshot", payload: { items: [initial] } }]);

    const previous = new Map([[initial.id, JSON.stringify(initial)]]);
    assert.deepEqual(diffActivityItems(previous, [initial], true), []);

    const finished = activityFromJob(job("completed", { exitCode: 0, finishedAt: 200 }));
    assert.deepEqual(diffActivityItems(previous, [finished], true), [
      { type: "ActivityUpdate", payload: finished },
    ]);
    assert.deepEqual(diffActivityItems(previous, [], true), [
      { type: "ActivityRemoved", payload: { id: initial.id } },
    ]);
  });

  it("maps managed job lifecycle states and only marks live processes stoppable", () => {
    assert.deepEqual(activityFromJob(job("running")), {
      id: "job-1",
      kind: "job",
      title: "npm run dev",
      status: "running",
      stoppable: true,
      started_at_ms: 100,
    });
    assert.equal(activityFromJob(job("cancelling")).summary, "Stopping…");
    assert.equal(activityFromJob(job("cancelled")).status, "stopped");
    assert.equal(activityFromJob(job("timed_out")).status, "failed");
    assert.equal(activityFromJob(job("completed", { exitCode: 0, finishedAt: 200 })).status, "done");
    assert.equal(activityFromJob(job("running")).stoppable, true);
    assert.equal(activityFromJob(job("completed")).stoppable, false);
  });

  it("recognizes jobs that still need host polling", () => {
    assert.equal(isActiveJob(job("starting")), true);
    assert.equal(isActiveJob(job("running")), true);
    assert.equal(isActiveJob(job("cancelling")), true);
    assert.equal(isActiveJob(job("completed")), false);
  });

  it("maps worker progress and keeps batch-only cancellation unavailable per worker", () => {
    const item = activityFromWorker(worker({
      steps: [
        { label: "Read files", status: "completed" },
        { label: "Check behavior", status: "active" },
        { label: "Report findings", status: "pending" },
      ],
    }));
    assert.equal(item.id, "agent:worker-1");
    assert.equal(item.kind, "agent");
    assert.equal(item.status, "running");
    assert.equal(item.stoppable, false);
    assert.equal(item.summary, "Check behavior");
    assert.equal(item.progress, 1 / 3);
    assert.deepEqual(item.steps?.map((step) => step.status), ["done", "running", "pending"]);
  });

  it("surfaces partial-budget results as needing attention", () => {
    const item = activityFromWorker(worker({ status: "budget_exhausted" }));
    assert.equal(item.status, "needs_attention");
    assert.match(item.summary ?? "", /partial results/);
  });
});
