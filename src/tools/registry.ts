import type { ToolDef } from "../agent/messages.js";

export interface PlanOption {
  label: string;
  plan: string;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  onTasks?: (tasks: Task[]) => void;
  onPlanOptions?: (options: PlanOption[]) => void;
  coauthor?: { name: string; email: string };
  memoryManager?: import("../memory/manager.js").MemoryManager | null;
  sessionId?: string;
  githubToken?: string;
  /** Shell override for the bash tool. If omitted, the tool auto-detects based on platform. */
  shell?: string;
  /**
   * Intent tier classified for this turn, when known. Carried into
   * hook payloads (PreToolUse / PostToolUse) so user hooks can branch
   * on tier — e.g. skip auto-format for light-tier turns, or audit
   * every heavy-tier action. Optional because code-mode sub-calls
   * and SDK consumers may not have a tier.
   */
  intentTier?: "light" | "medium" | "heavy";
  /** Credentials for tools that need to call an LLM (see llm-auth.ts). */
  llmAuth?: import("../agent/llm-auth.js").LlmAuth;
  /** Model id for tools that need to call an LLM. */
  model?: string;
  /** When false (default), the bash tool blocks `git push` to the repository's
   *  default branch and directs the model to open a PR instead. */
  allowDirectPush?: boolean;
}

export interface ToolRender {
  title: string;
  body?: string;
  diff?: { path: string; before: string; after: string };
}

export interface ToolOutput {
  content: string;
  rawBytes: number;
  reducedBytes: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolSpec<Args = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsPermission: boolean;
  /** When true, the tool only reads state and never mutates the workspace.
   *  Read-only tools within a single turn may be executed in parallel. */
  isReadOnly?: boolean;
  render?: (args: Args) => ToolRender;
  run: (args: Args, ctx: ToolContext) => Promise<string | ToolOutput>;
}

export function toOpenAIToolDefs(tools: ToolSpec[]): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
}

export function isValidStatus(s: unknown): s is TaskStatus {
  return s === "pending" || s === "in_progress" || s === "completed";
}

export function validateTasks(input: unknown): Task[] {
  if (!Array.isArray(input)) throw new Error("tasks must be an array");
  return input.map((t, i) => {
    if (!t || typeof t !== "object") throw new Error(`tasks[${i}] must be an object`);
    const rec = t as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : String(i + 1);
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (!title) throw new Error(`tasks[${i}].title is required`);
    const status: TaskStatus = isValidStatus(rec.status) ? rec.status : "pending";
    return { id, title, status };
  });
}
