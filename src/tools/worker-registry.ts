/**
 * Process-wide registry of running subagents.
 *
 * Each worker gets its own cancel handle, linked to (but separate from) the
 * turn's abort signal: the user can stop one subagent without interrupting
 * the turn or the other workers, and interrupting a turn is a separate,
 * explicit action. Hosts subscribe to render a live list.
 */

export interface RunningWorker {
  id: string;
  /** Short display number (#1, #2, …); restarts when no workers are running. */
  index: number;
  task: string;
  model: string;
  startedAt: number;
  status: "running" | "cancelling";
}

export interface WorkerHandle {
  id: string;
  index: number;
  /** Aborts when the turn aborts or the user cancels this worker. */
  signal: AbortSignal;
  /** True when the user cancelled this specific worker. */
  readonly cancelledByUser: boolean;
  /** Remove the worker from the registry. Idempotent. */
  finish(): void;
}

interface Entry {
  info: RunningWorker;
  controller: AbortController;
}

export class WorkerRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(workers: RunningWorker[]) => void>();
  private nextIndex = 1;
  private nextId = 1;

  start(task: string, model: string, parent?: AbortSignal): WorkerHandle {
    if (this.entries.size === 0) this.nextIndex = 1;
    const controller = new AbortController();
    const info: RunningWorker = {
      id: `worker-${this.nextId++}`,
      index: this.nextIndex++,
      task,
      model,
      startedAt: Date.now(),
      status: "running",
    };
    this.entries.set(info.id, { info, controller });
    this.emit();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let cancelledByUser = false;
    controller.signal.addEventListener("abort", () => {
      cancelledByUser = true;
    }, { once: true });
    return {
      id: info.id,
      index: info.index,
      signal,
      get cancelledByUser() {
        return cancelledByUser;
      },
      finish: () => {
        if (this.entries.delete(info.id)) this.emit();
      },
    };
  }

  list(): RunningWorker[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }));
  }

  /** Cancel one worker by display number or id. Returns it, or null if not running. */
  cancel(ref: number | string): RunningWorker | null {
    const entry = [...this.entries.values()].find((e) =>
      typeof ref === "number" ? e.info.index === ref : e.info.id === ref || String(e.info.index) === ref.replace(/^#/, ""),
    );
    if (!entry || entry.info.status === "cancelling") return null;
    entry.info.status = "cancelling";
    entry.controller.abort();
    this.emit();
    return { ...entry.info };
  }

  /** Cancel every running worker. Returns how many were cancelled. */
  cancelAll(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.info.status === "cancelling") continue;
      entry.info.status = "cancelling";
      entry.controller.abort();
      n++;
    }
    if (n > 0) this.emit();
    return n;
  }

  subscribe(listener: (workers: RunningWorker[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const workers = this.list();
    for (const listener of this.listeners) {
      try {
        listener(workers);
      } catch {
        // A rendering listener must never break worker lifecycle.
      }
    }
  }
}

export const workerRegistry = new WorkerRegistry();
