import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunningWorker } from "../tools/worker-registry.js";
import type { JobRecord } from "../jobs/manager.js";
import { activityFromJob, activityFromSubagent, diffActivityItems, isActiveJob } from "./activity.js";

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

const worker = (patch: Partial<RunningWorker> = {}): RunningWorker => ({
  id: "worker-1",
  index: 1,
  task: "inspect sessions",
  model: "m",
  status: "running",
  startedAt: 100,
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

  it("maps running subagents as individually stoppable agent rows", () => {
    assert.deepEqual(activityFromSubagent(worker()), {
      id: "agent:worker-1",
      kind: "agent",
      title: "subagent #1: inspect sessions",
      status: "running",
      stoppable: true,
      started_at_ms: 100,
    });
    const stopping = activityFromSubagent(worker({ status: "cancelling" }));
    assert.equal(stopping.stoppable, false);
    assert.equal(stopping.summary, "Stopping…");
  });
});
