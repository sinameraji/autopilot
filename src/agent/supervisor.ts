/**
 * TurnSupervisor — fire-and-forget wrapper around runAgentTurn.
 *
 * Decouples turn execution from UI control flow so that:
 * 1. The UI never blocks waiting for a turn to complete
 * 2. A watchdog can enforce maximum turn duration
 * 3. Preemption can kill a running turn and start a new one
 */

import { runAgentTurn } from "./loop.js";
import type { AgentTurnOpts } from "./loop.js";
import { logger } from "../util/logger.js";
import * as client from "./client.js";
import { hasLlmAuth, llmAuthFromConfig, type LlmAuth } from "./llm-auth.js";
import type { WorkerResultMessage, ChatMessage } from "./messages.js";
import { detectRepoInfo, type RepoInfo } from "../util/repo-info.js";
import { loadConfig, resolveWorkerBudgetUsd, type KimiConfig, DEFAULT_MODEL, DEFAULT_PLUMBING_MODEL } from "../config.js";
import type { MemoryManager } from "../memory/manager.js";
import type { LspManager } from "../lsp/manager.js";
import type { McpManager } from "../mcp/manager.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { openMemoryDb, getTopRelatedFiles } from "../memory/db.js";

export type TurnPhase = "idle" | "preparing" | "streaming" | "executing" | "compacting" | "error";

export interface SupervisorCallbacks {
  onDone?: () => void;
  onError?: (error: Error) => void;
}

/** Options for spawning a standalone worker. */
export interface SpawnWorkerOpts {
  mode: "plan" | "execute";
  task: string;
  context?: string;
  budgetUsd?: number;
  model?: string;
  branchName?: string;
  baseBranch?: string;
  prTitle?: string;
  prBody?: string;
  /** Pre-computed memory context from coordinator's MemoryManager */
  memoryContext?: string;
  /** Pre-computed LSP context (workspace symbols, diagnostics) */
  lspContext?: string;
  /** Pre-computed MCP context (available tools, servers) */
  mcpContext?: string;
}

export interface WorkerStep {
  label: string;
  status: "pending" | "active" | "completed" | "failed";
}

/** Active worker tracking for UI status. */
export interface ActiveWorker {
  id: string;
  /** Remote DO workerId returned by the Commute worker (needed for /cancel). */
  remoteWorkerId?: string;
  mode: "plan" | "execute";
  task: string;
  status: "pending" | "running" | "completed" | "failed" | "budget_exhausted";
  startedAt: number;
  result?: WorkerResultMessage;
  error?: string;
  /** Raw stdout from the remote agent (available once the worker finishes). */
  rawOutput?: string;
  /** Worker reasoning summary (available once the worker finishes). */
  reasoning?: string;
  /** Structured steps reported by the remote worker (stepIndex/totalSteps/completedSteps). */
  steps?: WorkerStep[];
  /** Coordinator-side log of what happened during this worker's lifecycle. */
  logs: string[];
  /** Files pre-read by the coordinator and injected into this worker's context. */
  preReadFiles?: string[];
  /** Total characters of pre-read content injected. */
  preReadChars?: number;
}

const DEFAULT_PRE_READ_MAX_CHARS = 50_000;

/** Pre-read files from the local filesystem and format them for worker context.
 *  Respects maxChars, skips missing files, and returns a formatted block. */
export async function preReadFilesForWorkers(
  files: string[],
  repoRoot: string,
  maxChars = DEFAULT_PRE_READ_MAX_CHARS,
): Promise<{ text: string; filesRead: string[]; chars: number }> {
  const results: string[] = [];
  const filesRead: string[] = [];
  let chars = 0;

  for (const file of files) {
    if (chars >= maxChars) break;
    const path = resolve(repoRoot, file);
    try {
      const s = await stat(path);
      if (!s.isFile()) continue;
      const raw = await readFile(path, "utf8");
      const remaining = maxChars - chars;
      const content = raw.length > remaining ? raw.slice(0, remaining) + "\n… (truncated)" : raw;
      results.push(`--- ${file} ---\n${content}`);
      filesRead.push(file);
      chars += content.length;
    } catch {
      // Skip missing or unreadable files silently
    }
  }

  if (results.length === 0) {
    return { text: "", filesRead: [], chars: 0 };
  }

  return {
    text: `The following files were pre-read by the coordinator and are available for reference.\nCheck here before using the read tool to avoid redundant file reads.\n\n${results.join("\n\n")}`,
    filesRead,
    chars,
  };
}

/** Derive a pre-read file list from the memory database.
 *  Returns the top frequently-referenced files for the current repo,
 *  or an empty array if memory is disabled or the DB is empty. */
export function getPreReadFilesFromMemory(
  cfg: { memoryEnabled?: boolean; memoryDbPath?: string },
  repoRoot: string,
  limit = 10,
): string[] {
  if (!cfg.memoryEnabled) return [];
  const dbPath = cfg.memoryDbPath ?? join(repoRoot, ".kimiflare", "memory.db");
  try {
    const db = openMemoryDb(dbPath);
    const files = getTopRelatedFiles(db, repoRoot, limit);
    return files;
  } catch {
    // Memory DB may not exist or be unreadable — fall back gracefully
    return [];
  }
}

export class TurnSupervisor {
  private currentTurn: Promise<void> | null = null;
  private _phase: TurnPhase = "idle";
  private _killRequested = false;
  private _activeWorkers: Map<string, ActiveWorker> = new Map();
  /** Injectable LLM client for synthesis (overridable in tests). */
  private _runKimi = client.runKimi;

  /** Coordinator-side MemoryManager for proxying memories to workers */
  memoryManager: MemoryManager | null = null;
  /** Coordinator-side LspManager for proxying LSP context to workers */
  lspManager: LspManager | null = null;
  /** Coordinator-side McpManager for proxying MCP context to workers */
  mcpManager: McpManager | null = null;

  get phase(): TurnPhase {
    return this._phase;
  }

  get isRunning(): boolean {
    return this._phase !== "idle";
  }

  get killRequested(): boolean {
    return this._killRequested;
  }

  get activeWorkers(): ActiveWorker[] {
    return [...this._activeWorkers.values()];
  }

  startTurn(opts: AgentTurnOpts, callbacks?: SupervisorCallbacks): void {
    if (this.isRunning) {
      logger.warn("supervisor:start_rejected", { reason: "turn_already_running", phase: this._phase });
      // Graceful no-op instead of throwing — prevents unhandled crashes when
      // queued messages or rapid submissions race into processMessage().
      return;
    }
    this._phase = "preparing";
    this._killRequested = false;
    logger.debug("supervisor:turn_start", { sessionId: opts.sessionId });

    this.currentTurn = runAgentTurn(opts)
      .then(async () => {
        this._phase = "idle";
        if (this._killRequested) {
          logger.debug("supervisor:turn_killed", { sessionId: opts.sessionId });
        } else {
          logger.debug("supervisor:turn_done", { sessionId: opts.sessionId });
        }
        await callbacks?.onDone?.();
      })
      .catch(async (error) => {
        this._phase = "idle";
        const err = error as Error;
        logger.warn("supervisor:turn_error", {
          sessionId: opts.sessionId,
          error: err.message ?? String(err),
          name: err.name,
        });
        await callbacks?.onError?.(err);
      })
      .finally(() => {
        this.currentTurn = null;
        this._killRequested = false;
      });
  }

  /** Request that the current turn be killed. This does NOT directly abort
   *  the turn — the caller must abort the AbortScope that was passed to
   *  `startTurn`. This method only records the intent so the supervisor
   *  knows the turn was intentionally killed rather than failing. */
  killTurn(): void {
    if (!this.isRunning) return;
    this._killRequested = true;
    logger.debug("supervisor:kill_requested", { phase: this._phase });
  }

  /** Spawn multiple research/executor workers in parallel and return their results.
   *
   * Workers are batched according to KIMIFLARE_WORKER_MAX_PARALLEL (default 3).
   * Each worker POSTs to `${endpoint}/worker` with the mission brief.
   *
   * NOTE: This is currently only invoked programmatically (not wired to auto-triage).
   * Future: the coordinator will call this automatically when intent classification
   * signals a "heavy" task (see docs/plans/multi-agent-standalone-workers-plan.md).
   */
  async spawnWorkers(
    workers: SpawnWorkerOpts[],
    onUpdate?: (workers: ActiveWorker[]) => void,
    signal?: AbortSignal,
  ): Promise<WorkerResultMessage[]> {
    // Read config first; env vars override individual fields for back-compat.
    // We also fall back to the /remote setup endpoint when the dedicated
    // multi-agent fields aren't set — same Commute worker hosts both, so most
    // users who already ran /remote setup get /multi-agent for free.
    const cfg = await loadConfig().catch(() => null);
    const endpoint =
      process.env.KIMIFLARE_WORKER_ENDPOINT
      ?? cfg?.workerEndpoint
      ?? cfg?.remoteWorkerUrl;
    if (!endpoint) {
      throw new Error(
        "Multi-agent endpoint not configured. Open /multi-agent and pick Set up to deploy one.",
      );
    }

    const apiKey =
      process.env.KIMIFLARE_WORKER_API_KEY
      ?? cfg?.workerApiKey
      ?? cfg?.remoteAuthSecret;
    // KIMIFLARE_CLI_REF stays as a dev/CI env override only — there's no
    // config field or UI for it. End users always get the latest published
    // kimiflare via the server's `npm install -g kimiflare@latest` step.
    const cliRef = process.env.KIMIFLARE_CLI_REF;
    const maxParallel = Math.min(
      workers.length,
      parseInt(process.env.KIMIFLARE_WORKER_MAX_PARALLEL ?? "3", 10),
    );

    // Sandbox-driven workers need a repo to clone — detect once.
    const repoInfo = detectRepoInfo();
    if ("error" in repoInfo) {
      throw new Error(`cannot spawn workers: ${repoInfo.error}`);
    }
    const repo: RepoInfo = repoInfo;

    if (!cfg?.openrouterApiKey) {
      throw new Error(
        "No OpenRouter API key configured — workers bill model calls to your own key. Run /key set <key> or set OPENROUTER_API_KEY.",
      );
    }
    // Workers run kimiflare in the Commute sandbox; their model calls bill to
    // the user's own OpenRouter key. The Cloudflare creds are still forwarded
    // when present for Commute servers that predate the OpenRouter switch.
    const userOpenRouterKey = cfg.openrouterApiKey;
    const userAccountId = cfg.accountId;
    const userApiToken = cfg.apiToken;

    // Configurable proxy flags for worker capabilities
    const proxyMemory = cfg?.workerProxyMemory ?? true;
    const proxyLsp = cfg?.workerProxyLsp ?? false;
    const proxyMcp = cfg?.workerProxyMcp ?? false;

    // Capture coordinator managers for context gathering
    const memoryManager = this.memoryManager;
    const lspManager = this.lspManager;
    const mcpManager = this.mcpManager;

    // ── Coordinator-side file cache: pre-read commonly accessed files ──
    let preReadCfg = cfg.workerPreReadFiles;
    // If no explicit list, try to derive from memory (frequently referenced files)
    if (!preReadCfg || preReadCfg.length === 0) {
      const memoryFiles = getPreReadFilesFromMemory(cfg, process.cwd(), 10);
      if (memoryFiles.length > 0) {
        preReadCfg = memoryFiles;
        logger.info("spawnWorkers:pre_read_from_memory", { files: memoryFiles });
      }
    }
    const preReadMax = cfg.workerPreReadMaxChars ?? DEFAULT_PRE_READ_MAX_CHARS;
    const preRead = preReadCfg && preReadCfg.length > 0
      ? await preReadFilesForWorkers(preReadCfg, process.cwd(), preReadMax)
      : { text: "", filesRead: [] as string[], chars: 0 };
    if (preRead.filesRead.length > 0) {
      logger.info("spawnWorkers:pre_read", {
        files: preRead.filesRead,
        chars: preRead.chars,
        source: cfg.workerPreReadFiles ? "config" : "memory",
      });
    }

    // Register all workers as pending
    for (const w of workers) {
      const id = `worker-${crypto.randomUUID().slice(0, 8)}`;
      this._activeWorkers.set(id, {
        id,
        mode: w.mode,
        task: w.task,
        status: "pending",
        startedAt: Date.now(),
        logs: [],
        preReadFiles: preRead.filesRead,
        preReadChars: preRead.chars,
      });
    }
    onUpdate?.(this.activeWorkers);

    const results: WorkerResultMessage[] = [];
    const queue = [...workers];
    // Capture the instance Map so the inner runBatch (a regular function with
    // its own `this`) can reach it. Earlier this used `TurnSupervisor.prototype._activeWorkers`,
    // which is undefined because _activeWorkers is an instance field, not on
    // the prototype — that caused "Cannot read properties of undefined (reading 'entries')".
    const activeWorkers = this._activeWorkers;

    async function runBatch(batch: SpawnWorkerOpts[], batchId: string): Promise<void> {
      const shallowClone = cfg?.workerShallowClone ?? true;
      const repoCache = cfg?.workerRepoCache ?? true;
      await Promise.all(
        batch.map(async (w) => {
          const workerId = [...activeWorkers.entries()].find(
            ([, aw]) => aw.task === w.task && aw.status === "pending",
          )?.[0];
          if (!workerId) return;

          const worker = activeWorkers.get(workerId)!;
          worker.status = "running";
          worker.logs.push(`[coordinator] Starting worker → POST ${endpoint}/worker`);
          if (worker.preReadFiles && worker.preReadFiles.length > 0) {
            worker.logs.push(
              `[coordinator] Shared cache: ${worker.preReadFiles.length} file(s) pre-read (~${worker.preReadChars?.toLocaleString() ?? "?"} chars)`,
            );
          }
          onUpdate?.([...activeWorkers.values()]);

          try {
            const maxCostUsd = resolveWorkerBudgetUsd(cfg);
            if (maxCostUsd !== (w.budgetUsd ?? 1.0)) {
              worker.logs.push(
                `[coordinator] Budget capped to ${maxCostUsd.toFixed(2)} (was ${(w.budgetUsd ?? 1.0).toFixed(2)})`,
              );
            }

            // Gather coordinator-side context for the worker
            let memoryContext = w.memoryContext ?? "";
            let lspContext = w.lspContext ?? "";
            let mcpContext = w.mcpContext ?? "";

            if (proxyMemory && memoryManager && !memoryContext) {
              try {
                const memories = await memoryManager.recall({ text: w.task, limit: 10 });
                const { formatRecalledMemories } = await import("../memory/retrieval.js");
                memoryContext = formatRecalledMemories(memories);
              } catch (err) {
                logger.warn("supervisor:memory_recall_failed", { task: w.task, error: (err as Error).message });
              }
            }

            if (proxyLsp && lspManager && !lspContext) {
              try {
                lspContext = await lspManager.exportContext(process.cwd());
              } catch (err) {
                logger.warn("supervisor:lsp_export_failed", { error: (err as Error).message });
              }
            }

            if (proxyMcp && mcpManager && !mcpContext) {
              try {
                mcpContext = mcpManager.exportContext();
              } catch (err) {
                logger.warn("supervisor:mcp_export_failed", { error: (err as Error).message });
              }
            }
            const defaultWorkerModel = cfg?.model ?? DEFAULT_MODEL;
            const payload = {
              mode: w.mode,
              task: w.task,
              context: preRead.text
                ? `${preRead.text}\n\n${w.context ?? ""}`
                : (w.context ?? ""),
              budget: { maxCostUsd },
              outputFormat: "structured" as const,
              tools: w.mode === "plan" ? ("read-only" as const) : ("all" as const),
              model: w.model ?? defaultWorkerModel,
              // Sandbox-driven worker needs the repo to clone:
              githubToken: repo.token,
              owner: repo.owner,
              repo: repo.repo,
              baseBranch: w.baseBranch ?? repo.baseBranch,
              // Bill worker LLM calls to the USER's OpenRouter key, not the
              // Commute operator's.
              userOpenRouterKey,
              ...(userAccountId && userApiToken ? { userAccountId, userApiToken } : {}),
              // Batch-level hints so the Commute worker can share a cloned
              // repo across workers in the same batch and skip full clones.
              batchId,
              shallowClone,
              repoCache,
              // Coordinator-side context proxying
              ...(memoryContext ? { memoryContext } : {}),
              ...(lspContext ? { lspContext } : {}),
              ...(mcpContext ? { mcpContext } : {}),
              // Optionally override the in-sandbox kimiflare install so the
              // worker runs pre-release / branch code instead of the image-
              // baked version. e.g. `kimiflare@latest`, `kimiflare@1.2.3`,
              // `github:sinameraji/kimiflare#feat/foo`.
              ...(cliRef ? { kimiflareInstall: cliRef } : {}),
              ...(w.mode === "execute"
                ? {
                    branchName: w.branchName,
                    prTitle: w.prTitle,
                    prBody: w.prBody,
                  }
                : {}),
            };

            const timeoutMs = cfg?.workerTimeoutMs
              ?? parseInt(process.env.KIMIFLARE_WORKER_TIMEOUT_MS ?? "900000", 10);

            worker.logs.push(`[coordinator] Sending payload (${JSON.stringify(payload).length} bytes)`);
            worker.logs.push(`[coordinator] Worker will clone ${repo.owner}/${repo.repo} and run kimiflare inside Cloudflare Sandbox`);
            const optHints: string[] = [];
            if (shallowClone) optHints.push("shallow clone");
            if (repoCache) optHints.push("repo cache");
            if (optHints.length > 0) {
              worker.logs.push(`[coordinator] Optimizations enabled: ${optHints.join(", ")}`);
            }
            worker.logs.push(`[coordinator] Typical runtime: 1–4 min. Timeout: ${Math.round(timeoutMs / 1000)}s`);
            onUpdate?.([...activeWorkers.values()]);

            // ── Start the worker via DO (returns immediately with workerId) ──
            const startRes = await fetch(`${endpoint}/worker`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "X-Worker-Api-Key": apiKey } : {}),
              },
              body: JSON.stringify(payload),
            });
            if (!startRes.ok) {
              const text = await startRes.text().catch(() => "");
              throw new Error(`Worker start failed: ${startRes.status} ${text.slice(0, 200)}`);
            }
            const { workerId: remoteWorkerId } = (await startRes.json()) as { workerId: string };
            worker.remoteWorkerId = remoteWorkerId;
            worker.logs.push(`[coordinator] Worker started (id: ${remoteWorkerId}) — polling for progress…`);
            onUpdate?.([...activeWorkers.values()]);

            // ── Poll progress every 3s until done or timeout ──
            const pollInterval = 3000;
            let lastProgressAt = Date.now();
            let lastLogCount = 0;
            let lastStep = "";
            let data: WorkerResultMessage | undefined;

            while (Date.now() - lastProgressAt < timeoutMs) {
              if (signal?.aborted) {
                worker.logs.push(`[coordinator] Cancelling worker (id: ${remoteWorkerId})…`);
                onUpdate?.([...activeWorkers.values()]);
                try {
                  await fetch(`${endpoint}/worker/${remoteWorkerId}/cancel`, {
                    method: "POST",
                    headers: apiKey ? { "X-Worker-Api-Key": apiKey } : {},
                  });
                } catch {
                  // Best-effort cancel — ignore network errors
                }
                throw new Error("Cancelled by user");
              }
              await new Promise((r) => setTimeout(r, pollInterval));

              let progressRes: Response | undefined;
              let lastPollErr: string | undefined;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  progressRes = await fetch(`${endpoint}/worker/${remoteWorkerId}/progress`, {
                    headers: apiKey ? { "X-Worker-Api-Key": apiKey } : {},
                  });
                  break;
                } catch (err) {
                  lastPollErr = err instanceof Error ? err.message : String(err);
                  if (attempt < 3) {
                    await new Promise((r) => setTimeout(r, pollInterval * attempt));
                  }
                }
              }
              if (!progressRes) {
                worker.logs.push(`[coordinator] Progress poll failed (3 retries): ${lastPollErr}`);
                onUpdate?.([...activeWorkers.values()]);
                continue;
              }
              if (!progressRes.ok) {
                worker.logs.push(`[coordinator] Progress poll HTTP error: ${progressRes.status}`);
                onUpdate?.([...activeWorkers.values()]);
                continue;
              }

              const progress = (await progressRes.json()) as {
                status: "pending" | "running" | "completed" | "failed" | "budget_exhausted";
                step: string;
                stepIndex: number;
                totalSteps: number;
                message: string;
                logs: string[];
                completedSteps: string[];
                error?: string;
                result?: WorkerResultMessage;
              };

              // Build structured steps from progress data
              const allSteps: WorkerStep[] = [];
              for (let i = 0; i < progress.totalSteps; i++) {
                const isCompleted = i < progress.completedSteps.length;
                const isActive = i === progress.stepIndex - 1 && !isCompleted && progress.status === "running";
                const isFailed =
                  (progress.status === "failed" || progress.status === "budget_exhausted") &&
                  i === progress.stepIndex - 1;
                allSteps.push({
                  label: progress.completedSteps[i] ?? progress.step,
                  status: isFailed ? "failed" : isCompleted ? "completed" : isActive ? "active" : "pending",
                });
              }
              worker.steps = allSteps;

              // Append new logs (only the ones we haven't seen)
              const newLogs = progress.logs.slice(lastLogCount);
              lastLogCount = progress.logs.length;
              for (const logLine of newLogs) {
                worker.logs.push(`[worker] ${logLine}`);
              }

              // Show current step (only when it changes)
              const stepKey = `${progress.stepIndex}:${progress.step}`;
              if (stepKey !== lastStep) {
                lastStep = stepKey;
                lastProgressAt = Date.now();
                worker.logs.push(`[coordinator] Step ${progress.stepIndex}/${progress.totalSteps}: ${progress.message}`);
                onUpdate?.([...activeWorkers.values()]);
              } else if (newLogs.length > 0) {
                lastProgressAt = Date.now();
                // Still need to refresh if new worker logs arrived
                onUpdate?.([...activeWorkers.values()]);
              }

              if (
                progress.status === "completed" ||
                progress.status === "failed" ||
                progress.status === "budget_exhausted"
              ) {
                if (progress.result) {
                  data = progress.result;
                } else if (progress.error) {
                  data = {
                    workerId: remoteWorkerId,
                    status: progress.status === "budget_exhausted" ? "budget_exhausted" : "failed",
                    task: w.task,
                    findings: [],
                    recommendations: [],
                    filesRead: [],
                    webSources: [],
                    costUsd: 0,
                    tokensUsed: 0,
                    reasoning: "",
                    error: progress.error,
                  } as WorkerResultMessage;
                }
                break;
              }
            }

            if (!data) {
              throw new Error(`Worker timed out after ${Math.round(timeoutMs / 1000)}s`);
            }

            worker.status =
              data.status === "completed"
                ? "completed"
                : data.status === "budget_exhausted"
                  ? "budget_exhausted"
                  : "failed";
            worker.result = data;
            worker.rawOutput = data.rawOutput;
            worker.reasoning = data.reasoning;
            // Mark all steps completed (or failed) on finish
            if (worker.steps && worker.steps.length > 0) {
              for (const s of worker.steps) {
                if (s.status === "pending" || s.status === "active") {
                  s.status =
                    worker.status === "completed"
                      ? "completed"
                      : worker.status === "budget_exhausted"
                        ? "failed"
                        : "failed";
                }
              }
            }
            worker.logs.push(`[coordinator] Worker finished with status: ${data.status}`);
            if (data.phases && data.phases.length > 0) {
              const timeline = data.phases.map((p) => `${p.name}: ${Math.round(p.ms / 1000)}s`).join(" · ");
              worker.logs.push(`[coordinator] Phase timing: ${timeline}`);
            }
            if (data.error) {
              worker.logs.push(`[coordinator] Worker error: ${data.error}`);
            }
            if (data.rawOutput) {
              worker.logs.push(`[coordinator] Worker raw output (${data.rawOutput.length} chars):`);
              worker.logs.push(...data.rawOutput.split("\n").slice(-30));
            }
            // Include completed and budget_exhausted (partial) results in synthesis.
            // Budget-exhausted workers may still have useful findings.
            if (data.status === "completed" || data.status === "budget_exhausted") {
              results.push(data);
            }
          } catch (e) {
            worker.status = "failed";
            const err = e as Error;
            const cause = (err as unknown as { cause?: Error }).cause;
            let diagnostic = cause ? `${err.message} (${cause.message})` : err.message;
            // Surface common sandbox/DO failure modes in the UI
            if (diagnostic.includes("Network connection lost") || diagnostic.includes("reset")) {
              diagnostic += " — Cloudflare Sandbox Durable Object reset. This can happen when the worker exceeds CPU/memory limits or hits a transient platform issue. Try reducing task complexity or retrying.";
            }
            worker.error = diagnostic;
            worker.logs.push(`[coordinator] Fetch failed: ${diagnostic}`);
            logger.error("spawnWorkers:failed", { workerId, error: diagnostic });
          }
          onUpdate?.([...activeWorkers.values()]);
        }),
      );
    }

    while (queue.length > 0) {
      const batch = queue.splice(0, maxParallel);
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await runBatch(batch, batchId);
    }

    return results;
  }

  /** Heuristic synthesis — exact legacy behavior, preserved as fallback. */
  private synthesizeFindingsHeuristic(results: WorkerResultMessage[]): {
    plan: string;
    conflicts: string[];
    recommendations: string[];
  } {
    const allFindings = results.flatMap((r) => r.findings);
    const allRecommendations = results.flatMap((r) => r.recommendations);

    // Confidence score mapping for tie-breaking
    const CONFIDENCE_SCORE = { high: 3, medium: 2, low: 1 };

    // Deduplicate by topic, keeping the highest-confidence finding
    const topicToFinding = new Map<string, (typeof allFindings)[0]>();
    for (const f of allFindings) {
      const key = f.topic.toLowerCase().trim();
      const existing = topicToFinding.get(key);
      if (!existing || CONFIDENCE_SCORE[f.confidence] > CONFIDENCE_SCORE[existing.confidence]) {
        topicToFinding.set(key, f);
      }
    }
    const dedupedFindings = [...topicToFinding.values()];

    // Detect conflicts: same topic with different recommendations
    // Tie-breaker: prefer recommendations from higher-confidence workers
    const conflicts: string[] = [];
    const topicRecs = new Map<string, Map<string, number>>(); // topic -> rec -> max confidence score
    for (const r of allRecommendations) {
      const lower = r.toLowerCase();
      for (const f of dedupedFindings) {
        if (lower.includes(f.topic.toLowerCase())) {
          const recMap = topicRecs.get(f.topic) ?? new Map();
          const currentScore = recMap.get(r) ?? 0;
          const newScore = CONFIDENCE_SCORE[f.confidence];
          if (newScore > currentScore) {
            recMap.set(r, newScore);
          }
          topicRecs.set(f.topic, recMap);
        }
      }
    }

    const resolvedRecommendations: string[] = [];
    for (const [topic, recMap] of topicRecs) {
      const recs = [...recMap.entries()];
      if (recs.length > 1) {
        // Sort by confidence score descending and pick the highest
        recs.sort((a, b) => b[1] - a[1]);
        const winner = recs[0]![0];
        const losers = recs.slice(1).map((r) => r[0]);
        conflicts.push(`Topic "${topic}" had conflicting recommendations; preferred "${winner}" over ${losers.join(" / ")}`);
        resolvedRecommendations.push(winner);
      } else if (recs.length === 1) {
        resolvedRecommendations.push(recs[0]![0]);
      }
    }

    const budgetExhaustedCount = results.filter((r) => r.status === "budget_exhausted").length;

    const planLines: string[] = [
      "# Synthesized Execution Plan",
      "",
      "## Findings Summary",
      ...dedupedFindings.map(
        (f) => `- **${f.topic}** (${f.confidence}): ${f.summary}`,
      ),
      "",
      "## Recommendations",
      ...resolvedRecommendations.map((r) => `- ${r}`),
    ];

    if (budgetExhaustedCount > 0) {
      planLines.push(
        "",
        `> ⚠️ ${budgetExhaustedCount} worker(s) hit their budget ceiling and returned partial results. ` +
          `Findings above may be incomplete. Consider re-running with a higher budget if critical gaps remain.`,
      );
    }

    if (conflicts.length > 0) {
      planLines.push("", "## Conflicts Resolved", ...conflicts.map((c) => `- ${c}`));
    }

    return {
      plan: planLines.join("\n"),
      conflicts,
      recommendations: resolvedRecommendations,
    };
  }

  /** LLM-based synthesis with graceful fallback to heuristic. */
  private async synthesizeFindingsLlm(
    results: WorkerResultMessage[],
    opts: {
      prompt?: string;
      auth: LlmAuth;
      model: string;
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
    },
  ): Promise<{ plan: string; conflicts: string[]; recommendations: string[] }> {
    const MAX_RAW_OUTPUT = 2000;
    const MAX_REASONING = 2000;

    const workerBlocks = results.map((r, i) => {
      const findings = r.findings
        .map(
          (f) =>
            `  - Topic: ${f.topic}\n    Summary: ${f.summary}\n    Confidence: ${f.confidence}\n    Relevance: ${f.relevance}\n    Sources: ${f.sources.join(", ") || "none"}`,
        )
        .join("\n");
      const recs = r.recommendations.map((rec) => `  - ${rec}`).join("\n") || "  (none)";
      const reasoning = r.reasoning ? r.reasoning.slice(0, MAX_REASONING) : "(none)";
      const rawOutput = r.rawOutput ? r.rawOutput.slice(0, MAX_RAW_OUTPUT) : "(none)";
      return [
        `--- Worker ${r.workerId || `w${i + 1}`} ---`,
        `Task: ${r.task}`,
        `Status: ${r.status}`,
        `Findings:\n${findings || "  (none)"}`,
        `Recommendations:\n${recs}`,
        `Reasoning:\n${reasoning}`,
        `Raw Output (truncated):\n${rawOutput}`,
      ].join("\n");
    });

    const userContent = [
      opts.prompt ? `Original user request:\n${opts.prompt}` : "",
      "",
      "Worker outputs:",
      workerBlocks.join("\n\n"),
      "",
      "Instructions:",
      "1. Synthesize the worker findings into a coherent execution plan.",
      "2. Detect and resolve any conflicts between workers.",
      "3. Cite sources inline using [worker: <id>] notation.",
      "4. Return ONLY valid JSON in this exact shape (no markdown fences):",
      '{"plan":"markdown plan","conflicts":["string"],"recommendations":["string"],"reasoning":"optional string"}',
    ]
      .filter(Boolean)
      .join("\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a synthesis engine. Combine findings from multiple research workers into a single coherent execution plan. Be concise. Return only valid JSON.",
      },
      { role: "user", content: userContent },
    ];

    let text = "";
    const events = this._runKimi({
      ...opts.auth,
      model: opts.model,
      messages,
      temperature: 0.2,
      maxCompletionTokens: 4096,
      reasoningEffort: "low",
      signal: opts.signal,
    });
    for await (const ev of events) {
      if (ev.type === "text") {
        text += ev.delta;
        opts.onDelta?.(ev.delta);
      }
    }

    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/gi, "").trim();
    const parsed = JSON.parse(cleaned) as {
      plan?: string;
      conflicts?: string[];
      recommendations?: string[];
      reasoning?: string;
    };

    if (!parsed.plan || !Array.isArray(parsed.conflicts) || !Array.isArray(parsed.recommendations)) {
      throw new Error("LLM synthesis returned malformed JSON");
    }

    return {
      plan: parsed.plan,
      conflicts: parsed.conflicts,
      recommendations: parsed.recommendations,
    };
  }

  /** Synthesize findings from multiple workers into a unified execution plan.
   *
   * Uses LLM-based synthesis by default (configurable via synthesisStrategy).
   * Falls back to the heuristic path when credentials are missing, the strategy
   * demands it, or the LLM call fails.
   */
  async synthesizeFindings(
    results: WorkerResultMessage[],
    opts?: {
      prompt?: string;
      auth?: LlmAuth;
      model?: string;
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
      strategy?: "llm" | "heuristic" | "hybrid";
      disableLlmSynthesis?: boolean;
    },
  ): Promise<{
    plan: string;
    conflicts: string[];
    recommendations: string[];
  }> {
    const strategy = opts?.strategy ?? "llm";
    const disableLlm = opts?.disableLlmSynthesis ?? false;
    const hasCreds = !!opts?.auth && hasLlmAuth(opts.auth);

    const useHeuristic = !hasCreds || strategy === "heuristic" || disableLlm;
    if (useHeuristic) {
      return this.synthesizeFindingsHeuristic(results);
    }

    try {
      const llmResult = await this.synthesizeFindingsLlm(results, {
        prompt: opts?.prompt,
        auth: opts.auth!,
        model: opts?.model ?? DEFAULT_PLUMBING_MODEL,
        signal: opts?.signal,
        onDelta: opts?.onDelta,
      });
      return llmResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("supervisor:synthesis_llm_failed", { error: msg });
      if (strategy === "hybrid") {
        return this.synthesizeFindingsHeuristic(results);
      }
      throw err;
    }
  }

  /** Automatically spawn research workers for a heavy prompt.
   *
   * Decomposes the prompt into 2-4 parallel research tasks using a simple
   * heuristic (split on "and" / commas when multiple distinct topics are
   * mentioned). Falls back to 2 angled tasks when decomposition is unclear.
   *
   * Returns the synthesized plan after all workers complete.
   */
  async autoSpawnWorkers(
    prompt: string,
    context: string,
    onUpdate?: (workers: ActiveWorker[]) => void,
    onPhaseChange?: (phase: "spawning" | "synthesizing" | "complete") => void,
    signal?: AbortSignal,
    onNarration?: (text: string) => void,
  ): Promise<{
    plan: string;
    conflicts: string[];
    recommendations: string[];
    prUrl?: string;
    executor?: { status: "completed" | "failed"; error?: string };
  }> {
    if (this._activeWorkers.size > 0) {
      throw new Error(
        `Multi-agent already active (${this._activeWorkers.size} worker(s) in flight). ` +
        "Wait for completion or cancel before starting a new heavy task.",
      );
    }
    const cfg = await loadConfig().catch(() => null);
    const workers = await decomposePrompt(prompt, context, { cwd: process.cwd(), cfg: cfg ?? undefined });

    // Narrate the decomposition plan so the user knows what each agent will do
    const narrationLines: string[] = [
      `Decomposing your request into ${workers.length} parallel research task${workers.length > 1 ? "s" : ""}:`,
      ...workers.map((w, i) => `  ${i + 1}. ${w.task.slice(0, 200)}${w.task.length > 200 ? "…" : ""}`),
    ];
    onNarration?.(narrationLines.join("\n"));

    onPhaseChange?.("spawning");
    try {
      const results = await this.spawnWorkers(workers, onUpdate, signal);
      onPhaseChange?.("synthesizing");

      const synth = await this.synthesizeFindings(results, {
        prompt,
        auth: llmAuthFromConfig(cfg),
        model: cfg?.synthesisModel,
        signal,
        strategy: cfg?.synthesisStrategy,
        disableLlmSynthesis: cfg?.disableLlmSynthesis,
      });

      // Auto plan→execute chain ("the 4th agent"). Off by default for safety;
      // opt in via /multi-agent in the TUI or KIMIFLARE_AUTO_EXECUTE=1. Only
      // fires when synthesis produced actionable recommendations.
      const cfg2 = await loadConfig().catch(() => null);
      const autoExecute =
        cfg2?.autoExecute ?? /^(1|true|yes|on)$/i.test(process.env.KIMIFLARE_AUTO_EXECUTE ?? "");
      if (!autoExecute || synth.recommendations.length === 0) {
        return synth;
      }

      const executeTask = [
        `Original request: ${prompt}`,
        "",
        "A research pass produced this plan. Implement it.",
        "",
        synth.plan,
      ].join("\n");

      try {
        const execResults = await this.spawnWorkers(
          [{ mode: "execute", task: executeTask, context }],
          onUpdate,
          signal,
        );
        const exec = execResults[0];
        if (!exec) {
          return { ...synth, executor: { status: "failed", error: "executor worker did not return a result" } };
        }
        return {
          ...synth,
          prUrl: exec.prUrl,
          executor: { status: exec.status === "completed" ? "completed" : "failed", error: exec.error },
        };
      } catch (err) {
        return { ...synth, executor: { status: "failed", error: err instanceof Error ? err.message : String(err) } };
      }
    } finally {
      onPhaseChange?.("complete");
    }
  }

  clearWorkers(): void {
    this._activeWorkers.clear();
  }
}

/** In-memory cache for decomposition results keyed by prompt+context hash. */
const decompositionCache = new Map<string, SpawnWorkerOpts[]>();

const MAX_CACHE_ENTRIES = 50;

function cacheKey(prompt: string, context: string, strategy: string): string {
  return createHash("sha256").update(`${prompt}\0${context}\0${strategy}`).digest("hex");
}

function getCached(key: string): SpawnWorkerOpts[] | undefined {
  return decompositionCache.get(key);
}

function setCached(key: string, value: SpawnWorkerOpts[]): void {
  if (decompositionCache.size >= MAX_CACHE_ENTRIES) {
    const first = decompositionCache.keys().next().value;
    if (first !== undefined) decompositionCache.delete(first);
  }
  decompositionCache.set(key, value);
}

/** Build a lightweight file-tree snapshot for the current working directory.
 *  Returns top-level dirs + key files, capped at ~40 lines, excluding
 *  build artifacts and dependency folders. */
export async function getFileTreeSnapshot(cwd: string): Promise<string> {
  const IGNORED = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".astro",
    "coverage",
    ".coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".idea",
    ".vscode",
    ".DS_Store",
  ]);
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") && !e.name.startsWith(".github") && !e.name.startsWith(".config")) {
        if (!e.isDirectory()) continue;
      }
      if (IGNORED.has(e.name)) continue;
      if (e.isDirectory()) dirs.push(`${e.name}/`);
      else files.push(e.name);
    }
    dirs.sort();
    files.sort();
    const lines = [...dirs, ...files];
    if (lines.length === 0) return "(empty directory)";
    if (lines.length > 40) {
      return lines.slice(0, 40).join("\n") + "\n… (truncated)";
    }
    return lines.join("\n");
  } catch {
    return "(unable to read directory)";
  }
}

/** Pull explicit list items from a prompt: numbered (`1. …`, `1) …`) or
 *  bulleted (`- …`, `* …`, `• …`). Returns trimmed item bodies, or [] when
 *  no clear list structure is present. */
function extractListItems(prompt: string): string[] {
  const numbered = [...prompt.matchAll(/(?:^|\n)\s*\d+[.)]\s+([^\n]+)/g)].map((m) => m[1]?.trim() ?? "");
  if (numbered.length >= 2) return numbered.filter((s) => s.length > 0);
  const bulleted = [...prompt.matchAll(/(?:^|\n)\s*[-*•]\s+([^\n]+)/g)].map((m) => m[1]?.trim() ?? "");
  if (bulleted.length >= 2) return bulleted.filter((s) => s.length > 0);
  return [];
}

const DECOMPOSITION_SYSTEM = `You are a task-decomposition assistant. Given a user's coding request and a snapshot of their project directory, produce 2–4 well-scoped, non-overlapping research tasks that can be executed in parallel by independent agents.

Rules:
- Each task must be self-contained and actionable.
- Tasks must NOT overlap in scope. If two tasks would investigate the same file or concept, merge them.
- Respect file/directory boundaries mentioned in the prompt or visible in the file tree.
- Scale task count with perceived complexity: 2 tasks for simple questions, 3–4 for broad audits or multi-file changes.
- Return ONLY a JSON object with this exact shape (no markdown fences, no extra text):
  {"tasks":["task 1","task 2",...],"reasoning":"brief explanation of why you split this way"}`;

async function decomposeWithLlm(
  prompt: string,
  context: string,
  fileTree: string,
  cfg: KimiConfig,
): Promise<SpawnWorkerOpts[] | null> {
  const model = cfg.decompositionModel ?? DEFAULT_PLUMBING_MODEL;
  const auth = llmAuthFromConfig(cfg);
  if (!hasLlmAuth(auth)) {
    logger.warn("decompose:missing_creds", { reason: "no OpenRouter key or custom endpoint" });
    return null;
  }

  const userContent = [
    `User request: ${prompt}`,
    context ? `Additional context: ${context}` : "",
    `Project file tree (top-level):\n${fileTree}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: DECOMPOSITION_SYSTEM },
    { role: "user", content: userContent },
  ];

  try {
    let text = "";
    const events = client.runKimi({
      ...auth,
      model,
      messages,
      temperature: 0.1,
      maxCompletionTokens: 2048,
      reasoningEffort: "low",
    });
    for await (const ev of events) {
      if (ev.type === "text") text += ev.delta;
    }

    // Strip markdown fences if the model wrapped JSON in them
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/gi, "").trim();
    const parsed = JSON.parse(cleaned) as { tasks?: unknown; reasoning?: string };
    const rawTasks = parsed.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      logger.warn("decompose:invalid_tasks", { rawTasks });
      return null;
    }

    const tasks = rawTasks
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter((t) => t.length > 0);

    if (tasks.length < 2) {
      logger.warn("decompose:too_few_tasks", { count: tasks.length });
      return null;
    }

    // Deduplicate near-identical tasks
    const unique: string[] = [];
    for (const t of tasks) {
      const lower = t.toLowerCase();
      if (!unique.some((u) => u.toLowerCase() === lower || lower.includes(u.toLowerCase()) || u.toLowerCase().includes(lower))) {
        unique.push(t);
      }
    }

    const capped = unique.slice(0, 4);
    logger.debug("decompose:llm_success", { taskCount: capped.length, reasoning: parsed.reasoning });
    return capped.map((task) => ({ mode: "plan" as const, task, context }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("decompose:llm_failed", { error: msg });
    return null;
  }
}

/** Fallback decomposition for prose prompts without explicit list structure. */
function fallbackDecomposition(prompt: string, context: string): SpawnWorkerOpts[] {
  return [
    { mode: "plan", task: `Research overview and best practices for: ${prompt}`, context },
    { mode: "plan", task: `Investigate implementation details, trade-offs, and risks for: ${prompt}`, context },
  ];
}

/** Decompose a heavy prompt into parallel research tasks.
 *
 * 1. Explicit list items (numbered/bulleted) → immediate return.
 * 2. Check in-memory cache.
 * 3. If strategy is "regex" → fallback to 2-angle split.
 * 4. Otherwise → attempt LLM decomposition with file-tree awareness.
 * 5. On any failure → log warning and fallback to 2-angle split.
 */
export async function decomposePrompt(
  prompt: string,
  context: string,
  opts?: { cwd?: string; cfg?: KimiConfig },
): Promise<SpawnWorkerOpts[]> {
  const items = extractListItems(prompt);
  if (items.length >= 2) {
    return items.slice(0, 4).map((task) => ({ mode: "plan" as const, task, context }));
  }

  const strategy = opts?.cfg?.decompositionStrategy ?? "llm";
  const key = cacheKey(prompt, context, strategy);
  const cached = getCached(key);
  if (cached) {
    logger.debug("decompose:cache_hit");
    return cached;
  }

  if (strategy === "regex") {
    const result = fallbackDecomposition(prompt, context);
    setCached(key, result);
    return result;
  }

  // "llm" or "hybrid" — try LLM decomposition
  if (opts?.cfg) {
    const cwd = opts.cwd ?? process.cwd();
    const fileTree = await getFileTreeSnapshot(cwd);
    const llmResult = await decomposeWithLlm(prompt, context, fileTree, opts.cfg);
    if (llmResult) {
      setCached(key, llmResult);
      return llmResult;
    }
  }

  const result = fallbackDecomposition(prompt, context);
  setCached(key, result);
  return result;
}
