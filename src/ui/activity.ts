import type { ActiveWorker } from "../agent/supervisor.js";
import type { JobRecord } from "../jobs/manager.js";

/** Activity payload understood by camouflage-tui's inline protocol. */
export interface ActivityItem {
  id: string;
  kind: "job" | "agent";
  title: string;
  status: "running" | "waiting" | "needs_attention" | "done" | "failed" | "stopped";
  stoppable: boolean;
  summary?: string;
  progress?: number;
  started_at_ms?: number;
  updated_at_ms?: number;
  steps?: { title: string; status: "pending" | "running" | "done" | "failed" }[];
}

export function activityFromJob(job: JobRecord): ActivityItem {
  const active = job.status === "starting" || job.status === "running" || job.status === "cancelling";
  const status: ActivityItem["status"] = active
    ? "running"
    : job.status === "completed"
      ? "done"
      : job.status === "cancelled"
        ? "stopped"
        : "failed";
  const summary = job.status === "cancelling"
    ? "Stopping…"
    : job.status === "timed_out"
      ? "Timed out"
      : job.status === "unknown"
        ? "Process state could not be verified"
        : job.exitCode !== null && job.exitCode !== 0
          ? `Exited with code ${job.exitCode}`
          : undefined;
  return {
    id: job.id,
    kind: "job",
    title: job.command,
    status,
    stoppable: job.status === "starting" || job.status === "running",
    ...(summary ? { summary } : {}),
    started_at_ms: job.createdAt,
    ...(job.finishedAt !== null ? { updated_at_ms: job.finishedAt } : {}),
  };
}

export function activityFromWorker(worker: ActiveWorker): ActivityItem {
  const status: ActivityItem["status"] = worker.status === "pending"
    ? "waiting"
    : worker.status === "running"
      ? "running"
      : worker.status === "completed"
        ? "done"
        : worker.status === "budget_exhausted"
          ? "needs_attention"
          : "failed";
  const steps = worker.steps?.map((step) => ({
    title: step.label,
    status: step.status === "active"
      ? "running" as const
      : step.status === "completed"
        ? "done" as const
        : step.status === "failed"
          ? "failed" as const
          : "pending" as const,
  }));
  const doneCount = steps?.filter((step) => step.status === "done" || step.status === "failed").length ?? 0;
  const summary = worker.error
    ?? worker.steps?.find((step) => step.status === "active")?.label
    ?? (worker.status === "budget_exhausted" ? "Budget exhausted; inspect partial results" : undefined);
  return {
    id: `agent:${worker.id}`,
    kind: "agent",
    title: `${worker.mode}: ${worker.task}`,
    status,
    // A single worker cannot currently be cancelled independently; the only
    // available AbortSignal cancels the entire multi-agent batch.
    stoppable: false,
    ...(summary ? { summary } : {}),
    ...(steps && steps.length > 0 ? {
      progress: worker.status === "completed" ? 1 : doneCount / steps.length,
      steps,
    } : {}),
    started_at_ms: worker.startedAt,
  };
}

export type ActivityEvent =
  | { type: "ActivitySnapshot"; payload: { items: ActivityItem[] } }
  | { type: "ActivityUpdate"; payload: ActivityItem }
  | { type: "ActivityRemoved"; payload: { id: string } };

/** Build the renderer events needed to synchronize the full host-owned list. */
export function diffActivityItems(
  previous: ReadonlyMap<string, string>,
  current: readonly ActivityItem[],
  snapshotSent: boolean,
): ActivityEvent[] {
  if (!snapshotSent) return [{ type: "ActivitySnapshot", payload: { items: [...current] } }];

  const next = new Map(current.map((item) => [item.id, item]));
  const events: ActivityEvent[] = [];
  for (const [id, item] of next) {
    if (previous.get(id) !== JSON.stringify(item)) events.push({ type: "ActivityUpdate", payload: item });
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) events.push({ type: "ActivityRemoved", payload: { id } });
  }
  return events;
}

export function isActiveJob(job: JobRecord): boolean {
  return job.status === "starting" || job.status === "running" || job.status === "cancelling";
}
