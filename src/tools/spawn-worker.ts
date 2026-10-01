import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import type { WorkerResultMessage } from "../agent/messages.js";
import { logger } from "../util/logger.js";
import { loadConfig, resolveWorkerBudgetUsd, DEFAULT_MODEL } from "../config.js";
import { runHotcellWorker } from "./hotcell-worker.js";
import { llmAuthFromConfig, usesRequesty } from "../agent/llm-auth.js";

interface SpawnWorkerArgs {
  mode: "plan" | "execute";
  task: string;
  context?: string;
  budget?: { maxCostUsd?: number };
  outputFormat?: "structured" | "text";
  tools?: "all" | "read-only";
  model?: string;
  branchName?: string;
  baseBranch?: string;
  prTitle?: string;
  prBody?: string;
}

const DEFAULT_WORKER_TIMEOUT_MS = 300_000; // 5 minutes

export async function callWorkerEndpoint(
  endpoint: string,
  apiKey: string | undefined,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
): Promise<WorkerResultMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${endpoint}/worker`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { "X-Worker-Api-Key": apiKey } : {}),
  };
  const body = JSON.stringify(payload);
  const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  try {
    // Primary attempt
    const res = await fetch(url, { method: "POST", headers, body, signal: fetchSignal });
    if (res.ok) {
      return (await res.json()) as WorkerResultMessage;
    }

    // Retry once on 5xx or network-level failure
    if (res.status >= 500 && res.status < 600) {
      logger.warn("spawn_worker:retrying", { status: res.status, endpoint });
      const retryRes = await fetch(url, { method: "POST", headers, body, signal: fetchSignal });
      if (retryRes.ok) {
        return (await retryRes.json()) as WorkerResultMessage;
      }
      const text = await retryRes.text().catch(() => "");
      throw new Error(`Worker endpoint returned ${retryRes.status}: ${text.slice(0, 200)}`);
    }

    const text = await res.text().catch(() => "");
    throw new Error(`Worker endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spawn a standalone remote worker agent to perform research or execute a plan.
 *
 * Workers run independently with their own full context window and tool access.
 * Mode 'plan': read-only research worker that returns structured findings.
 * Mode 'execute': write-enabled worker that creates a branch, implements changes,
 * and opens a PR.
 *
 * This is the CLIENT side of the worker protocol. It POSTs to the configured
 * worker endpoint (KIMIFLARE_WORKER_ENDPOINT) and expects a WorkerResultMessage
 * in response. The server side (Commute /worker endpoint) is NOT yet built.
 *
 * For local testing without a real server, use scripts/mock-worker-server.mjs.
 */
export const spawnWorkerTool: ToolSpec<SpawnWorkerArgs> = {
  name: "spawn_worker",
  description: [
    "Spawn a standalone worker using the configured remote endpoint or an opt-in local Hotcell sandbox.",
    "Mode 'plan': read-only research. Local Hotcell workers use a clean committed revision and cannot edit files.",
    "Mode 'execute': remote write + PR only; local Hotcell execute mode is intentionally unavailable.",
    "Use for heavy tasks that benefit from parallel research (e.g. 'research OAuth2, testing, and migration').",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["plan", "execute"],
        description: "Worker mode: 'plan' for read-only research, 'execute' for write + PR.",
      },
      task: {
        type: "string",
        description: "The mission brief for the worker. Be specific about what to research or implement.",
      },
      context: {
        type: "string",
        description: "Additional context about the current project state or goals.",
      },
      budget: {
        type: "object",
        properties: {
          maxCostUsd: { type: "number", description: "Max cost in USD for this worker. Default 1.0." },
        },
      },
      outputFormat: {
        type: "string",
        enum: ["structured", "text"],
        description: "Output format. Default 'structured'.",
      },
      tools: {
        type: "string",
        enum: ["all", "read-only"],
        description: "Requested remote tool set. Local Hotcell research always uses a narrow read-only profile and rejects `all`.",
      },
      model: {
        type: "string",
        description: "Model to use for the worker. Defaults to the active session model.",
      },
      branchName: {
        type: "string",
        description: "For execute mode: feature branch name to create.",
      },
      baseBranch: {
        type: "string",
        description: "For execute mode: base branch to fork from. Default 'main'.",
      },
      prTitle: {
        type: "string",
        description: "For execute mode: PR title.",
      },
      prBody: {
        type: "string",
        description: "For execute mode: PR body markdown.",
      },
    },
    required: ["mode", "task"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({
    title: `spawn_worker (${args.mode})`,
    body: args.task.slice(0, 200),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const cfg = await loadConfig().catch(() => null);
    const timeoutMs = cfg?.workerTimeoutMs
      ?? readNumberEnv("KIMIFLARE_WORKER_TIMEOUT_MS")
      ?? DEFAULT_WORKER_TIMEOUT_MS;
    const budgetCeiling = resolveWorkerBudgetUsd(cfg);

    if (cfg?.workerBackend === "hotcell") {
      if (cfg.baseUrl || usesRequesty(llmAuthFromConfig(cfg))) {
        return textOutput("Hotcell workers currently require an OpenRouter-backed session; custom model endpoints and Requesty sessions cannot be routed through the Hotcell gateway.");
      }
      if (args.mode !== "plan") {
        return textOutput("Hotcell workers currently support read-only plan mode only. Execute mode is disabled until reviewed patch artifacts are supported.");
      }
      if (args.tools === "all") {
        return textOutput("Hotcell research workers are restricted to read-only tools; the requested broader toolset is not available.");
      }
      const model = args.model ?? ctx.model;
      if (!model) {
        return textOutput("Hotcell worker requires the coordinator's active model ID. No model was provided; refusing to fall back to a default.");
      }
      const requestedBudget = args.budget?.maxCostUsd ?? budgetCeiling;
      const budgetUsd = Math.min(requestedBudget, budgetCeiling);
      if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
        return textOutput("Hotcell worker spend cap must be a positive number.");
      }
      try {
        const result = await runHotcellWorker({
          task: args.task,
          context: args.context,
          model,
          budgetUsd,
          timeoutMs,
          maxParallel: cfg?.workerMaxParallel,
          cwd: ctx.cwd,
          signal: ctx.signal,
        });
        if (result.status !== "completed" && result.status !== "budget_exhausted") {
          return textOutput(`Hotcell worker ${result.status}: ${result.error ?? "unknown error"}`);
        }
        const lines = [
          `Hotcell worker ${result.status}${result.status === "budget_exhausted" ? " (partial result)" : ""}.`,
          `Model: ${result.model ?? model} · Tokens: ${result.tokensUsed.toLocaleString()} · Cost: ${result.costUsd > 0 ? `${result.costUsd.toFixed(4)} total Hotcell cost` : "unavailable from Hotcell stats"}.`,
          ...result.findings.map((finding) => `\n## ${finding.topic}\n${finding.summary}`),
        ];
        if (result.status === "budget_exhausted") {
          lines.push("\nWorker input-token budget was exhausted; review partial findings before relying on them.");
        }
        return textOutput(lines.join("\n"));
      } catch (error) {
        return textOutput(`Failed to spawn Hotcell worker: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const endpoint = process.env.KIMIFLARE_WORKER_ENDPOINT ?? cfg?.workerEndpoint ?? cfg?.remoteWorkerUrl;
    if (!endpoint) {
      return textOutput("Worker endpoint not configured. Set KIMIFLARE_WORKER_ENDPOINT or workerEndpoint in config, or set workerBackend to hotcell.");
    }

    const apiKey = process.env.KIMIFLARE_WORKER_API_KEY ?? cfg?.workerApiKey;
    const defaultModel = cfg?.model ?? DEFAULT_MODEL;
    const workerModel = args.model ?? ctx.model ?? defaultModel;
    // Requesty managed policy ids ("kimi-k2.6") have no vendor prefix, and the
    // remote worker does not inherit the session's Requesty credentials.
    if (cfg && usesRequesty(llmAuthFromConfig(cfg)) && !workerModel.includes("/")) {
      return textOutput("Remote workers require an OpenRouter-compatible model ID and do not inherit the session's Requesty credentials. Pass an OpenRouter model ID or configure the remote worker separately.");
    }
    const payload = {
      mode: args.mode,
      task: args.task,
      context: args.context ?? "",
      budget: { maxCostUsd: budgetCeiling },
      outputFormat: args.outputFormat ?? "structured",
      tools: args.tools ?? (args.mode === "plan" ? "read-only" : "all"),
      model: workerModel,
      ...(args.mode === "execute"
        ? {
            branchName: args.branchName,
            baseBranch: args.baseBranch ?? "main",
            prTitle: args.prTitle,
            prBody: args.prBody,
          }
        : {}),
    };

    logger.info("spawn_worker:starting", { mode: args.mode, endpoint, taskPreview: args.task.slice(0, 100) });

    try {
      const result = await callWorkerEndpoint(endpoint, apiKey, payload, ctx.signal, timeoutMs);

      if (result.status !== "completed" && result.status !== "budget_exhausted") {
        const msg = `Worker ${result.workerId} ${result.status}: ${result.error ?? "unknown error"}`;
        const bytes = Buffer.byteLength(msg, "utf8");
        return { content: msg, rawBytes: bytes, reducedBytes: bytes };
      }

      const lines: string[] = [
        `Worker ${result.workerId} ${result.status === "budget_exhausted" ? "budget_exhausted (partial result)" : "completed"}.`,
        `Cost: ${result.costUsd.toFixed(2)} · Tokens: ${result.tokensUsed.toLocaleString()}`,
        "",
        "## Findings",
        ...result.findings.map(
          (f) => `- **${f.topic}** (${f.confidence}): ${f.summary} [relevance: ${f.relevance}]`,
        ),
        "",
        "## Recommendations",
        ...result.recommendations.map((r) => `- ${r}`),
      ];

      if (result.status === "budget_exhausted") {
        lines.push(
          "",
          "> ⚠️ This worker hit its budget ceiling and returned partial results. Consider re-running with a higher budget if findings are incomplete.",
        );
      }

      if (result.filesRead.length > 0) {
        lines.push("", "## Files Read", ...result.filesRead.map((f) => `- ${f}`));
      }
      if (result.webSources.length > 0) {
        lines.push("", "## Web Sources", ...result.webSources.map((u) => `- ${u}`));
      }

      const content = lines.join("\n");
      const bytes = Buffer.byteLength(content, "utf8");
      return { content, rawBytes: bytes, reducedBytes: bytes };
    } catch (e) {
      const err = e as Error;
      const cause = (err as unknown as { cause?: Error }).cause;
      const diagnostic = cause ? `${err.message} (${cause.message})` : err.message;
      const msg = `Failed to spawn worker: ${diagnostic}`;
      logger.error("spawn_worker:failed", { error: diagnostic });
      const bytes = Buffer.byteLength(msg, "utf8");
      return { content: msg, rawBytes: bytes, reducedBytes: bytes };
    }
  },
};

function textOutput(content: string): ToolOutput {
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes: bytes, reducedBytes: bytes };
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
