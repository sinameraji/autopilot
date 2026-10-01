import { JobManager } from "../jobs/manager.js";
import type { JobStatus } from "../jobs/manager.js";
import { RunStore } from "./store.js";
import type { RunTimer } from "./store.js";

export interface RunWakeEvent {
  runId: string;
  timerId: string;
  condition: "time" | "job";
  jobId?: string;
  jobStatus?: JobStatus | "not_found";
}

export interface RunWakeSchedulerOptions {
  /** Enqueue/resume the run; must be idempotent by timerId and return promptly. */
  onWake: (event: RunWakeEvent) => void | Promise<void>;
  runsDbPath?: string;
  jobsDbPath?: string;
  leaseMs?: number;
  batchSize?: number;
  onError?: (error: Error, timer?: RunTimer) => void;
}

const IDLE_RECHECK_MS = 1_000;
const MAX_NODE_TIMEOUT_MS = 2_147_000_000;
const ACTIVE_JOB_STATUSES = new Set<JobStatus>(["starting", "running", "cancelling"]);

/**
 * Durable timer dispatcher. It holds no timer state in memory: every wake is
 * claimed from SQLite, so a restart recovers scheduled and expired leases.
 * onWake must be idempotent by timerId because delivery is at-least-once.
 */
export class RunWakeScheduler {
  private readonly store: RunStore;
  private readonly options: RunWakeSchedulerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;

  constructor(options: RunWakeSchedulerOptions) {
    this.options = options;
    this.store = new RunStore(options.runsDbPath);
  }

  start(): void {
    if (this.disposed) throw new Error("RunWakeScheduler has been disposed");
    if (this.running) return;
    this.running = true;
    this.store.reconcileInterruptedRuns();
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.store.close();
    this.disposed = true;
  }

  /** Deterministic entry point for tests and hosts that own their scheduler loop. */
  async processDueTimers(now = Date.now()): Promise<number> {
    if (this.disposed) throw new Error("RunWakeScheduler has been disposed");
    const timers = this.store.claimDueTimers(now, this.options.batchSize ?? 50, this.options.leaseMs);
    for (const timer of timers) await this.processTimer(timer, now);
    this.failRunsForFailedTimers();
    return timers.length;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.disposed) return;
    try {
      await this.processDueTimers();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onError?.(err);
    } finally {
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    if (!this.running || this.disposed) return;
    const nextAt = this.store.nextTimerAt();
    const delay = nextAt === null
      ? IDLE_RECHECK_MS
      : Math.max(0, Math.min(MAX_NODE_TIMEOUT_MS, nextAt - Date.now()));
    this.timer = setTimeout(() => { void this.tick(); }, delay);
    this.timer.unref();
  }

  private async processTimer(timer: RunTimer, now: number): Promise<void> {
    if (timer.condition === "approval") return; // handled by a future approval ingress
    const run = this.store.getRun(timer.runId);
    if (!run || run.status !== "waiting") {
      this.store.cancelTimer(timer.id);
      return;
    }
    const runStartedAt = run.startedAt ?? run.createdAt;
    if (now - runStartedAt >= run.maxRuntimeMs) {
      this.store.transition(run.id, "failed", "max_runtime_exceeded");
      this.store.cancelTimer(timer.id);
      return;
    }

    let jobStatus: JobStatus | "not_found" | undefined;
    if (timer.condition === "job") {
      const jobs = new JobManager(this.options.jobsDbPath);
      try {
        const job = timer.jobId ? jobs.get(timer.jobId) : undefined;
        jobStatus = job?.status ?? "not_found";
      } finally {
        jobs.close();
      }
      if (jobStatus !== "not_found" && ACTIVE_JOB_STATUSES.has(jobStatus)) {
        this.store.rescheduleTimer(timer.id, now + timer.intervalMs);
        return;
      }
    }

    // Mark the run as active before notifying its host. If the process dies
    // after this point, startup reconciliation marks it ambiguous rather than
    // automatically replaying the wake or any tool action.
    this.store.transition(run.id, "running", `wake:${timer.id}`);
    try {
      await this.options.onWake({
        runId: run.id,
        timerId: timer.id,
        condition: timer.condition,
        ...(timer.jobId ? { jobId: timer.jobId } : {}),
        ...(jobStatus ? { jobStatus } : {}),
      });
      this.store.completeTimer(timer.id);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const current = this.store.getRun(run.id);
      if (current?.status === "running") {
        this.store.transition(run.id, "waiting", `wake_retry:${timer.id}`);
      }
      const retried = this.store.retryTimer(timer.id, err.message, now);
      if (retried.status === "failed") {
        const waiting = this.store.getRun(run.id);
        if (waiting?.status === "waiting") {
          this.store.transition(run.id, "failed", `timer_wake_failed:${timer.id}`);
        }
      }
      this.options.onError?.(err, timer);
    }
  }

  private failRunsForFailedTimers(): void {
    for (const timer of this.store.listFailedTimers(this.options.batchSize ?? 50)) {
      const run = this.store.getRun(timer.runId);
      if (run?.status === "waiting") {
        this.store.transition(run.id, "failed", `timer_wake_failed:${timer.id}`);
      }
    }
  }
}
