import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "./manager.js";

const WAIT = new Int32Array(new SharedArrayBuffer(4));

type Fixture = { dir: string; dbPath: string; jobs: JobManager };

describe("JobManager", { concurrency: 1 }, () => {
  it("captures output and recovers completion from the wrapper exit file", async () => withFixture(async ({ dir, jobs }) => {
    const job = start(jobs, dir, "printf 'hello\\n'; printf 'problem\\n' >&2");
    assert.ok(job.pid);
    assert.equal(job.pgid, job.pid);
    const completed = await waitForStatus(jobs, job.id, "completed");
    assert.equal(completed.exitCode, 0);
    assert.match(jobs.logs(job.id, "stdout").content, /hello/);
    assert.match(jobs.logs(job.id, "stderr").content, /problem/);
    assert.equal(jobs.logs(job.id, "stdout", { offset: 0 }).offset, 6);
  }));

  it("marks non-zero commands failed", async () => withFixture(async ({ dir, jobs }) => {
    const job = start(jobs, dir, "printf 'bad\\n' >&2; exit 7");
    const result = await waitForStatus(jobs, job.id, "failed");
    assert.equal(result.exitCode, 7);
  }));

  it("enforces a durable timeout", async () => withFixture(async ({ dir, jobs }) => {
    const job = start(jobs, dir, "sleep 10", { timeoutMs: 1000 });
    const result = await waitForStatus(jobs, job.id, "timed_out", 6000);
    assert.equal(result.exitCode, 124);
  }));

  it("cancels the process group", async () => withFixture(({ dir, jobs }) => {
    const job = start(jobs, dir, "sleep 30 & wait");
    const result = jobs.cancel(job.id);
    assert.equal(result.status, "cancelled");
    assert.ok(result.finishedAt);
  }));

  it("escalates cancellation when a command ignores SIGTERM", async () => withFixture(({ dir, jobs }) => {
    const job = start(jobs, dir, "trap '' TERM; sleep 30");
    const result = jobs.cancel(job.id);
    assert.equal(result.status, "cancelled");
    assert.ok(job.pgid);
    const rows = execFileSync("ps", ["-axo", "pgid=,state="], { encoding: "utf8" });
    const states = rows.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      return match?.[1] === String(job.pgid) ? [match[2]!] : [];
    });
    assert.ok(states.every((state) => state.startsWith("Z")), `live processes remain in PGID ${job.pgid}: ${states.join(",")}`);
  }));

  it("reconciles a running process and its logs after reopening the database", async () => withFixture(async ({ dir, dbPath, jobs }) => {
    const job = start(jobs, dir, "echo ready; sleep 1; echo done");
    jobs.close();
    const restarted = new JobManager(dbPath);
    try {
      assert.equal(restarted.get(job.id)?.status, "running");
      const result = await waitForStatus(restarted, job.id, "completed");
      assert.match(restarted.logs(job.id, "stdout").content, /ready/);
      assert.match(restarted.logs(job.id, "stdout").content, /done/);
      assert.equal(result.status, "completed");
    } finally {
      restarted.close();
    }
  }));

  it("returns the existing record for a duplicate idempotency key", async () => withFixture(async ({ dir, jobs }) => {
    const first = start(jobs, dir, "echo once; sleep 1", { idempotencyKey: "stable-call" });
    const duplicate = start(jobs, dir, "echo should-not-run", { idempotencyKey: "stable-call" });
    assert.equal(duplicate.id, first.id);
    assert.equal(jobs.list({ cwd: dir }).length, 1);
    await waitForStatus(jobs, first.id, "completed");
  }));

  it("rejects invalid timeouts", async () => withFixture(({ dir, jobs }) => {
    assert.throws(() => start(jobs, dir, "true", { timeoutMs: 1 }), /timeout_ms/);
  }));
});

function start(
  jobs: JobManager,
  dir: string,
  command: string,
  extra: Partial<Parameters<JobManager["start"]>[0]> = {},
) {
  return jobs.start({ command, cwd: dir, shell: "bash", shellArgs: ["-lc"], ...extra });
}

async function withFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-jobs-"));
  const dbPath = join(dir, "state", "jobs.db");
  const jobs = new JobManager(dbPath);
  try {
    await run({ dir, dbPath, jobs });
  } finally {
    try { jobs.close(); } catch { /* already closed during restart test */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForStatus(
  jobs: JobManager,
  id: string,
  expected: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = jobs.get(id);
    if (result?.status === expected) return result;
    Atomics.wait(WAIT, 0, 0, 30);
  }
  assert.fail(`Job ${id} did not reach ${expected}; current status is ${jobs.get(id)?.status}`);
}
