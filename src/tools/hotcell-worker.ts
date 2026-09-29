import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { WorkerFinding, WorkerResultMessage } from "../agent/messages.js";
import { validateModelId } from "../agent/client.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_PROMPT_CHARS = 40_000;
const DEFAULT_CELL_TIMEOUT_MS = 300_000;
const MAX_PARALLEL_WORKERS = 3;
let runningWorkers = 0;
const workerQueue: Array<() => void> = [];

export interface HotcellWorkerOptions {
  task: string;
  context?: string;
  model: string;
  budgetUsd: number;
  timeoutMs?: number;
  maxParallel?: number;
  cwd?: string;
  hotcellCommand?: string;
  processRunner?: HotcellProcessRunner;
  signal?: AbortSignal;
}

export interface HotcellProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
}

export type HotcellProcessRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
) => Promise<HotcellProcessResult>;

/** Run an independent read-only Autopilot research worker in a disposable Hotcell. */
export async function runHotcellWorker(options: HotcellWorkerOptions): Promise<WorkerResultMessage> {
  const workerId = `hotcell-${crypto.randomUUID().slice(0, 8)}`;
  const cwd = resolve(options.cwd ?? process.cwd());
  const model = options.model.trim();
  if (!model) throw new Error("Hotcell workers require the coordinator's explicit model ID.");
  validateModelId(model);
  if (options.task.length + (options.context?.length ?? 0) > MAX_PROMPT_CHARS) {
    throw new Error(`Hotcell worker prompt exceeds the ${MAX_PROMPT_CHARS.toLocaleString()} character limit.`);
  }
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) {
    throw new Error("Hotcell worker spend cap must be a positive number.");
  }
  if (options.signal?.aborted) return terminalResult(workerId, options.task, "cancelled", "Cancelled before worker setup.");

  await acquireSlot(options.maxParallel ?? MAX_PARALLEL_WORKERS, options.signal);
  let cellId: string | undefined;
  let result: WorkerResultMessage | undefined;
  const command = options.hotcellCommand ?? process.env.HOTCELL_BIN ?? "hotcell";
  const execute = options.processRunner ?? runProcess;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;

  try {
    const repo = await getCleanRepository(cwd);
    const cellName = "autopilot-" + workerId;
    const checkoutAndInstall = [
      `git fetch origin ${shellQuote(repo.commit)}`,
      `git -C /workspace checkout --detach ${shellQuote(repo.commit)}`,
      "cd /workspace && npm ci --no-audit --no-fund --loglevel=error && npm run build && npm link",
    ].join(" && ");
    const created = await execute(command, [
      "create", "-n", "1", "--name", cellName, "--repo", repo.url,
      "--ref", repo.ref, "--egress", "--egress-spend-cap", String(options.budgetUsd),
      "--memory", "1024", "--cpus", "2", "--setup", checkoutAndInstall,
    ], { cwd, signal: options.signal, timeoutMs: 300_000 });
    cellId = parseCellId(created.stdout);
    if (!cellId) {
      try {
        const cells = await execute(command, ["ls"], { cwd, timeoutMs: 10_000 });
        cellId = parseNamedCellId(cells.stdout, cellName);
      } catch {
        // Best effort: the create command can omit its ID or fail after recording the cell.
      }
    }
    if (created.timedOut || created.aborted) {
      result = terminalResult(
        workerId,
        options.task,
        options.signal?.aborted ? "cancelled" : "timed_out",
        options.signal?.aborted ? "Cancelled during Hotcell setup." : "Hotcell setup timed out before the worker started.",
        model,
      );
      return result;
    }
    if (created.code !== 0) throw new Error(formatSetupFailure(created));
    if (!cellId) throw new Error("Hotcell created a sandbox but did not return a recognizable cell ID.");
    if (/no providers configured|providers:\s*\(none\)/i.test(created.stdout)) {
      result = terminalResult(workerId, options.task, "failed", "Hotcell has no OpenRouter gateway route. Run `hotcell keys add openrouter` on the daemon host, then retry.", model);
      return result;
    }

    const prompt = [
      "You are an isolated, read-only research worker. You cannot edit files, run shell commands, push, publish, or call write-capable integrations.",
      "Use the exact requested model and return concise findings, recommendations, and relevant file paths. Do not claim to have changed files.",
      `Mission:\n${options.task}`,
      options.context ? `Coordinator context:\n${options.context}` : "",
    ].filter(Boolean).join("\n\n");
    // Use base64 to pass the bounded mission as one quoted shell argument. The
    // host key is never passed; Hotcell injects its revocable gateway token.
    const encodedPrompt = Buffer.from(prompt, "utf8").toString("base64");
    const shellCommand = [
      'export OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL%/}/v1"',
      `PROMPT="$(printf '%s' '${encodedPrompt}' | base64 -d)"`,
      `autopilot --format json --max-input-tokens 14000 --model ${shellQuote(model)} --worker-profile research -p "$PROMPT"`,
    ].join("; ");
    const execution = await execute(command, ["exec", cellId, shellCommand, "--cwd", "/workspace"], {
      cwd, signal: options.signal, timeoutMs,
    });
    const stats = await execute(command, ["stats", cellId], { cwd, timeoutMs: 30_000 }).catch(() => undefined);
    const metrics = stats?.code === 0 ? parseHotcellStats(stats.stdout) : {};
    const json = parsePrintOutput(execution.stdout);
    const summary = typeof json?.text === "string" ? json.text.trim() : execution.stdout.trim();
    const tokensUsed = typeof json?.usage?.totalTokens === "number" ? json.usage.totalTokens : 0;
    const budgetExhausted = execution.code === 42;
    const diagnostic = `${execution.stdout}\n${execution.stderr}`.toLowerCase();
    const spendExhausted = /(?:http\s*)?402|spend cap|spending limit/.test(diagnostic);
    const status = execution.timedOut
      ? "timed_out"
      : execution.aborted
        ? options.signal?.aborted ? "cancelled" : "failed"
        : spendExhausted ? "spend_exhausted"
        : budgetExhausted ? "budget_exhausted"
        : execution.code === 0 ? "completed" : "failed";
    const findings: WorkerFinding[] = summary
      ? [{ topic: "Research findings", summary: summary.slice(0, 40_000), confidence: "medium", sources: [], relevance: "high" }]
      : [];
    result = {
      workerId,
      status,
      task: options.task,
      findings,
      recommendations: [],
      filesRead: [],
      webSources: [],
      costUsd: metrics.costUsd ?? 0,
      tokensUsed: metrics.tokensUsed ?? tokensUsed,
      reasoning: "",
      model,
      exitCode: execution.code,
      ...(budgetExhausted || spendExhausted ? { budgetExceeded: true, partialResult: findings.length > 0 } : {}),
      ...(execution.code !== 0 && !budgetExhausted
        ? {
            error: status === "timed_out" ? "Worker timed out."
              : status === "cancelled" ? "Worker cancelled."
              : spendExhausted ? "Hotcell per-cell spend cap was reached."
              : execution.outputLimitExceeded ? "Worker output exceeded the 1 MB result limit."
              : /unknown model|model.{0,30}(?:not found|invalid|unavailable|unsupported)/i.test(diagnostic) ? "The requested model is unavailable in the Hotcell OpenRouter gateway."
              : /no openrouter api key|openrouter.{0,30}(?:key|gateway).{0,30}(?:missing|not configured)/i.test(diagnostic) ? "Hotcell OpenRouter gateway credentials are not configured. Run `hotcell keys add openrouter` on the daemon host."
              : `Worker process exited with code ${execution.code}.`,
          }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Hotcell worker error.";
    result = terminalResult(workerId, options.task, options.signal?.aborted ? "cancelled" : "failed", message, model);
  } finally {
    if (cellId) {
      try {
        // Removing the cell terminates any remaining process and revokes its
        // cell-scoped gateway token, including on timeout/cancellation paths.
        const removed = await execute(command, ["rm", cellId], { cwd, timeoutMs: 30_000 });
        if (removed.code !== 0 && result) {
          result = {
            ...result,
            status: result.status === "completed" ? "failed" : result.status,
            error: [result.error, "Hotcell cleanup failed; remove the cell manually to revoke its gateway token."].filter(Boolean).join(" "),
          };
        }
      } catch {
        if (result) {
          result = {
            ...result,
            status: result.status === "completed" ? "failed" : result.status,
            error: [result.error, "Hotcell cleanup failed; remove the cell manually to revoke its gateway token."].filter(Boolean).join(" "),
          };
        }
      }
    }
    releaseSlot();
  }
  return result!;
}

export async function getCleanRepository(cwd: string): Promise<{ url: string; commit: string; ref: string }> {
  const root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  const status = (await execFileAsync("git", ["status", "--porcelain"], { cwd: root })).stdout;
  if (status.trim()) throw new Error("Hotcell workers require a clean Git checkout; commit or stash local changes first.");
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const ref = (await execFileAsync("git", ["branch", "--show-current"], { cwd: root })).stdout.trim();
  if (!ref) throw new Error("Hotcell workers require a named branch so the daemon can clone before pinning the exact commit.");
  const url = (await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd: root })).stdout.trim();
  if (!/^(https:\/\/|git@|ssh:\/\/)/i.test(url) || /:\/\/[^/]*@/.test(url)) {
    throw new Error("Hotcell workers require a credential-free HTTPS or SSH origin URL that the Hotcell daemon can clone.");
  }
  return { url, commit, ref };
}

export function parseCellId(output: string): string | undefined {
  const uuid = output.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4,}){0,4}\b/gi)?.at(-1);
  if (uuid) return uuid;
  const labeled = output.match(/(?:sandbox|cell)(?:\s+id)?\s*[:= ]\s*([a-z0-9][a-z0-9_-]{7,79})/i)?.[1];
  if (labeled) return labeled;
  return output.split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => /^[a-z0-9][a-z0-9_-]{7,79}$/i.test(line));
}

export function parseNamedCellId(output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns[1] === name && /^[a-z0-9][a-z0-9_-]{7,79}$/i.test(columns[0] ?? "")) return columns[0];
  }
  return undefined;
}

function formatSetupFailure(result: HotcellProcessResult): string {
  const detail = sanitizeHotcellDiagnostic(`${result.stderr}\n${result.stdout}`);
  return `Hotcell setup failed (exit ${result.code})${detail ? `: ${detail}` : ". Check that the daemon, repository access, and gateway route are configured."}`;
}

function sanitizeHotcellDiagnostic(text: string): string {
  return text
    .replace(/\b(?:sk-or-v1-|sk-ant-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .trim()
    .slice(-1_500);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseHotcellStats(output: string): { tokensUsed?: number; costUsd?: number } {
  const llm = output.match(/LLM:\s*([\d,]+) calls,\s*([\d,]+) in \+ ([\d,]+) out tokens,\s*\$([\d.]+)/i);
  const totalCost = output.match(/Cost:\s*\$?([\d.]+)/i);
  const tokensUsed = llm
    ? Number(llm[2]!.replaceAll(",", "")) + Number(llm[3]!.replaceAll(",", ""))
    : undefined;
  const costUsd = totalCost ? Number(totalCost[1]) : llm ? Number(llm[4]) : undefined;
  return {
    ...(Number.isFinite(tokensUsed) ? { tokensUsed } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

export function parsePrintOutput(stdout: string): { text?: string; usage?: { totalTokens?: number } } | undefined {
  const candidate = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as { text?: string; usage?: { totalTokens?: number } };
  } catch {
    return undefined;
  }
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
): Promise<HotcellProcessResult> {
  if (options.signal?.aborted) return { code: 130, stdout: "", stderr: "", aborted: true };
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise({
        code: code ?? (aborted ? 130 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        aborted,
        timedOut,
        outputLimitExceeded,
      });
    });
  });
}

function terminalResult(
  workerId: string,
  task: string,
  status: "cancelled" | "timed_out" | "failed",
  error: string,
  model?: string,
): WorkerResultMessage {
  return {
    workerId, status, task, findings: [], recommendations: [], filesRead: [], webSources: [],
    costUsd: 0, tokensUsed: 0, reasoning: "", ...(model ? { model } : {}), error,
  };
}

async function acquireSlot(limit: number, signal?: AbortSignal): Promise<void> {
  const cap = Math.max(1, Math.min(MAX_PARALLEL_WORKERS, Math.floor(limit) || 1));
  if (runningWorkers < cap) {
    runningWorkers++;
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const wake = () => {
      if (signal?.aborted) {
        const index = workerQueue.indexOf(wake);
        if (index >= 0) workerQueue.splice(index, 1);
        reject(new Error("Hotcell worker cancelled while waiting for a slot."));
        return;
      }
      if (runningWorkers < cap) {
        const index = workerQueue.indexOf(wake);
        if (index >= 0) workerQueue.splice(index, 1);
        runningWorkers++;
        resolvePromise();
      }
    };
    workerQueue.push(wake);
    signal?.addEventListener("abort", wake, { once: true });
  });
}

function releaseSlot(): void {
  runningWorkers = Math.max(0, runningWorkers - 1);
  for (const wake of workerQueue.slice()) wake();
}
