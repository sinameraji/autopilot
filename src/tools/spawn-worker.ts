import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { loadConfig, resolveWorkerBudgetUsd } from "../config.js";
import { runHotcellWorker } from "./hotcell-worker.js";
import type { WorkerResultMessage } from "../agent/messages.js";

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
    "To run several workers in parallel, emit all of their spawn_worker calls in the same response; the user approves them together.",
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
  // Workers run in isolated Hotcell cells and never touch the workspace, so
  // several can run at once; the Hotcell slot semaphore bounds concurrency.
  concurrent: true,
  render: (args) => {
    const batch = (args as SpawnWorkerArgs & { batch?: SpawnWorkerArgs[] }).batch;
    if (Array.isArray(batch) && batch.length > 1) {
      return {
        title: `spawn_worker × ${batch.length} (Hotcell plan, run in parallel)`,
        body: batch.map((item, i) => `${i + 1}. ${String(item.task ?? "").slice(0, 160)}`).join("\n"),
      };
    }
    return {
      title: "spawn_worker (Hotcell plan)",
      body: args.task.slice(0, 200),
    };
  },
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
        setupTimeoutMs: readNumberEnv("KIMIFLARE_WORKER_SETUP_TIMEOUT_MS"),
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

    return textOutput(formatWorkerResult(result, model));
  },
};

/** Render a worker result for the coordinator: status, cost, cited findings,
 *  open questions, and a clear marker when the report was unstructured. */
export function formatWorkerResult(result: WorkerResultMessage, model: string): string {
  const lines = [
    "Local Hotcell worker " + result.status + (result.status === "budget_exhausted" ? " (partial result)" : "") + ".",
    "Model: " + (result.model ?? model) + " · Tokens: " + result.tokensUsed.toLocaleString() + " · Cost: " + (result.costUsd > 0 ? result.costUsd.toFixed(4) + " total Hotcell cost" : "unavailable from Hotcell stats") + ".",
    ...result.findings.map((finding) =>
      "\n## " + finding.topic + (result.structured ? " (" + finding.confidence + " confidence)" : "") + "\n" + finding.summary +
      (finding.sources.length ? "\nFiles: " + finding.sources.join(", ") : "")),
  ];
  if (result.openQuestions?.length) {
    lines.push("\n## Open questions\n" + result.openQuestions.map((q) => "- " + q).join("\n"));
  }
  if (result.filesRead.length) {
    lines.push("\nFiles read: " + result.filesRead.join(", "));
  }
  if (!result.structured && result.findings.length) {
    lines.push("\n(Worker did not return a structured report; findings above are its raw answer and are unverified.)");
  }
  if (result.status === "budget_exhausted") {
    lines.push("\nWorker input-token budget was exhausted; review partial findings before relying on them.");
  }
  return lines.join("\n");
}

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
