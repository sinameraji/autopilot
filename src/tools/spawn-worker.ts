import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import type { WorkerResultMessage } from "../agent/messages.js";
import { logger } from "../util/logger.js";
import { loadConfig, resolveWorkerBudgetUsd, DEFAULT_MODEL } from "../config.js";

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
const DEFAULT_WORKER_BUDGET_USD = 1.0;

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
  const fetchSignal = signal ?? controller.signal;

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
    "Spawn a standalone remote worker agent to perform research or execute a plan.",
    "Workers run independently with their own full context window and tool access.",
    "Mode 'plan': read-only research worker that returns structured findings.",
    "Mode 'execute': write-enabled worker that creates a branch, implements changes, and opens a PR.",
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
        description: "Tool set available to the worker. Default 'all' for plan mode, ignored for execute.",
      },
      model: {
        type: "string",
        description: `Model to use for the worker. Defaults to the session's model (${DEFAULT_MODEL} if unset).`,
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
    const endpoint = process.env.KIMIFLARE_WORKER_ENDPOINT;
    if (!endpoint) {
      const msg = "Worker endpoint not configured. Set KIMIFLARE_WORKER_ENDPOINT or workerEndpoint in config.";
      const bytes = Buffer.byteLength(msg, "utf8");
      return { content: msg, rawBytes: bytes, reducedBytes: bytes };
    }

    const apiKey = process.env.KIMIFLARE_WORKER_API_KEY;
    const timeoutMs = readNumberEnv("KIMIFLARE_WORKER_TIMEOUT_MS") ?? DEFAULT_WORKER_TIMEOUT_MS;
    const cfg = await loadConfig().catch(() => null);
    const budgetUsd = resolveWorkerBudgetUsd(cfg);
    const defaultModel = cfg?.model ?? DEFAULT_MODEL;

    const payload = {
      mode: args.mode,
      task: args.task,
      context: args.context ?? "",
      budget: { maxCostUsd: budgetUsd },
      outputFormat: args.outputFormat ?? "structured",
      tools: args.tools ?? (args.mode === "plan" ? "read-only" : "all"),
      model: args.model ?? defaultModel,
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

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
