import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { loadConfig, resolveWorkerBudgetUsd } from "../config.js";
import { runHotcellWorker } from "./hotcell-worker.js";

interface SpawnWorkerArgs {
  mode: "plan";
  task: string;
  context?: string;
  budget?: { maxCostUsd?: number };
  model?: string;
}

const DEFAULT_WORKER_TIMEOUT_MS = 300_000;

/** Spawn an isolated, local Hotcell research worker. */
export const spawnWorkerTool: ToolSpec<SpawnWorkerArgs> = {
  name: "spawn_worker",
  description: [
    "Spawn a read-only research worker in a local Hotcell sandbox. Hotcell is the only worker backend.",
    "Workers inspect the committed repository snapshot and cannot edit files; implement any changes in the coordinator.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["plan"],
        description: "Read-only research mode. Workers cannot edit files.",
      },
      task: {
        type: "string",
        description: "A specific, independent research mission for the worker.",
      },
      context: {
        type: "string",
        description: "Additional context about the current project or goal.",
      },
      budget: {
        type: "object",
        properties: {
          maxCostUsd: { type: "number", description: "Max Hotcell spend in USD. Defaults to the configured worker budget." },
        },
        additionalProperties: false,
      },
      model: {
        type: "string",
        description: "Model to use. Defaults to the active session model.",
      },
    },
    required: ["mode", "task"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({
    title: "spawn_worker (Hotcell plan)",
    body: args.task.slice(0, 200),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const cfg = await loadConfig().catch(() => null);
    if (!cfg?.openrouterApiKey) {
      throw new Error("Local Hotcell workers require an OpenRouter-backed session. Configure OpenRouter, then retry.");
    }
    if (cfg.baseUrl) {
      throw new Error("Local Hotcell workers do not support custom model endpoints.");
    }

    const model = args.model ?? ctx.model;
    if (!model) {
      throw new Error("Local Hotcell worker requires the coordinator's active model ID; refusing to choose a different model.");
    }
    const timeoutMs = cfg.workerTimeoutMs
      ?? readNumberEnv("KIMIFLARE_WORKER_TIMEOUT_MS")
      ?? DEFAULT_WORKER_TIMEOUT_MS;
    const budgetCeiling = resolveWorkerBudgetUsd(cfg);
    const requestedBudget = args.budget?.maxCostUsd ?? budgetCeiling;
    const budgetUsd = Math.min(requestedBudget, budgetCeiling);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error("Hotcell worker spend cap must be a positive number.");
    }

    let result;
    try {
      result = await runHotcellWorker({
        task: args.task,
        context: args.context,
        model,
        budgetUsd,
        timeoutMs,
        maxParallel: cfg.workerMaxParallel,
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
    } catch (error) {
      throw new Error("Failed to spawn local Hotcell worker: " + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    if (result.status !== "completed" && result.status !== "budget_exhausted") {
      throw new Error("Local Hotcell worker " + result.status + ": " + (result.error ?? "unknown error"));
    }

    const lines = [
      "Local Hotcell worker " + result.status + (result.status === "budget_exhausted" ? " (partial result)" : "") + ".",
      "Model: " + (result.model ?? model) + " · Tokens: " + result.tokensUsed.toLocaleString() + " · Cost: " + (result.costUsd > 0 ? result.costUsd.toFixed(4) + " total Hotcell cost" : "unavailable from Hotcell stats") + ".",
      ...result.findings.map((finding) => "\n## " + finding.topic + "\n" + finding.summary),
    ];
    if (result.status === "budget_exhausted") {
      lines.push("\nWorker input-token budget was exhausted; review partial findings before relying on them.");
    }
    return textOutput(lines.join("\n"));
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
