/**
 * Camouflage UI mode (`--ui camouflage`).
 *
 * Runs autopilot's agent loop with the Camouflage inline renderer instead of
 * Ink. Finished output goes into the terminal's normal scrollback, only a
 * small live region is redrawn, and an idle session uses no CPU however long
 * it runs. The renderer owns the look (tool rows, diffs, prompts, footer);
 * this module only translates the agent's callbacks into renderer events.
 *
 * Needs camouflage-tui with the inline SDK (`mount({ ui: "inline" })`,
 * `permission()`). Set CAMOUFLAGE_BIN to point at a locally built renderer.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { runAgentTurn, BudgetExhaustedError, AgentLoopError } from "./agent/loop.js";
import { llmAuthFromConfig } from "./agent/llm-auth.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import type { ChatMessage, ToolCall, Usage } from "./agent/messages.js";
import type { ResponseMeta } from "./agent/client.js";
import { ToolExecutor, ALL_TOOLS, type PermissionDecision, type PermissionRequest, type ToolResult } from "./tools/executor.js";
import type { KimiConfig } from "./config.js";
import { MODES, nextMode, type Mode } from "./mode.js";
import { decidePermission } from "./ui/use-permission-controller.js";
import { costLookupFromConfig } from "./ui/app-helpers.js";
import { recordUsage, getCostReport } from "./usage-tracker.js";
import { makeSessionId, generateSessionTitle, saveSession } from "./sessions.js";
import { classifyIntent } from "./intent/classify.js";
import { loadOpenRouterCatalog } from "./models/openrouter-catalog.js";
import { KimiApiError, humanizeApiError } from "./util/errors.js";
import { logger } from "./util/logger.js";

/** The subset of the camouflage-tui SDK this mode uses. Declared here so
 *  autopilot builds regardless of which SDK version is installed; the
 *  runtime check in `loadSdk` catches an SDK that is too old. */
interface CamouflageHandle {
  send(eventType: string, payload?: Record<string, unknown>): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  close(): Promise<number>;
}
interface CamouflageSdk {
  mount(opts: Record<string, unknown>): Promise<CamouflageHandle>;
  permission(
    cam: CamouflageHandle,
    spec: Record<string, unknown>,
  ): Promise<{ choice: "allow_once" | "allow_session" | "deny"; feedback?: string }>;
  selectList(
    cam: CamouflageHandle,
    spec: Record<string, unknown>,
  ): Promise<{ id: string; value?: string; cancelled: boolean }>;
}

export interface CamouflageModeOpts {
  cfg: KimiConfig;
  model: string;
  version: string;
}

const COMMANDS: { name: string; description: string; args_hint?: string }[] = [
  { name: "help", description: "Show commands and shortcuts" },
  { name: "model", description: "Switch the model for new turns", args_hint: "[id]" },
  { name: "mode", description: "Switch between edit, plan and auto", args_hint: "[edit|plan|auto]" },
  { name: "cost", description: "Show token usage and spend" },
  { name: "clear", description: "Start a fresh conversation" },
  { name: "exit", description: "Quit autopilot" },
];

async function loadSdk(): Promise<CamouflageSdk> {
  const sdk = (await import("camouflage-tui").catch((err) => {
    throw new Error(`camouflage-tui is not installed (${(err as Error).message}). Reinstall autopilot, or use --ui ink.`);
  })) as unknown as Partial<CamouflageSdk>;
  if (typeof sdk.permission !== "function" || typeof sdk.mount !== "function" || typeof sdk.selectList !== "function") {
    throw new Error("the installed camouflage-tui is too old for --ui camouflage (needs the inline SDK). Update autopilot, or use --ui ink.");
  }
  return sdk as CamouflageSdk;
}

export async function runCamouflageMode(opts: CamouflageModeOpts): Promise<void> {
  const sdk = await loadSdk();
  const { cfg } = opts;
  let model = opts.model;
  let mode: Mode = "edit";
  const cwd = process.cwd();

  // The renderer owns the terminal. Anything the host (or a library) prints
  // would land in the middle of its live region, so route it to the log.
  const restoreConsole = captureConsole();

  const cam = await sdk.mount({
    ui: "inline",
    appTitle: "autopilot",
    inheritStderr: false,
    ...(process.env.CAMOUFLAGE_BIN ? { bin: process.env.CAMOUFLAGE_BIN } : {}),
  });
  cam.on("stderr", (chunk: string) => logger.warn("camouflage.stderr", { chunk }));

  const executor = new ToolExecutor(ALL_TOOLS);
  const systemMessage = (): ChatMessage => ({
    role: "system",
    content: buildSystemPrompt({ cwd, tools: ALL_TOOLS, model, mode, preferPullRequests: cfg.preferPullRequests }),
  });
  let messages: ChatMessage[] = [systemMessage()];
  let session: { id: string; createdAt: string; title?: string } | null = null;
  let responseMeta: ResponseMeta | null = null;
  let controller: AbortController | null = null;
  const queue: string[] = [];
  let busy = false;

  const status = (segments: Record<string, string>) => cam.send("StatusUpdate", { segments });
  const notice = (message: string, severity: "info" | "warn" | "error" = "info") =>
    cam.send("RuntimeError", { message, severity });

  const branch = gitBranch(cwd);
  cam.send("SessionStarted", {
    title: `autopilot ${opts.version}`,
    detail: [
      [shortModel(model), shortPath(cwd), branch].filter(Boolean).join(" · "),
      "/ for commands · @ to mention files · shift+tab to switch modes",
    ],
    accent: "orange",
    assistant_label: "autopilot",
  });
  cam.send("SlashCommandsRegistered", { commands: COMMANDS });
  const files = listFiles(cwd);
  if (files.length > 0) {
    cam.send("MentionCandidatesRegistered", { candidates: files.map((token) => ({ token, kind: "file" })) });
  }
  status({ mode, model: shortModel(model) });

  const setMode = (next: Mode) => {
    mode = next;
    messages[0] = systemMessage();
    if (mode === "plan") executor.clearSessionPermissions();
    status({ mode: mode === "auto" ? "auto" : mode });
  };

  const refreshCost = async () => {
    if (!session) return;
    try {
      const report = await getCostReport(session.id);
      status({ cost: `${report.session.reconcilePending ? "≈" : ""}$${report.session.cost.toFixed(2)}` });
    } catch (err) {
      logger.warn("camouflage.cost", { error: String(err) });
    }
  };

  const persist = async () => {
    if (!session) return;
    try {
      await saveSession({
        id: session.id,
        cwd,
        model,
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
        messages,
        title: session.title,
      });
    } catch (err) {
      logger.warn("camouflage.save_session", { error: String(err) });
    }
  };

  const askPermission = async (req: PermissionRequest): Promise<PermissionDecision> => {
    const outcome = decidePermission(req, mode);
    if (outcome.kind === "resolve") return outcome.decision;
    if (outcome.kind === "plan_blocked") {
      notice(`Plan mode is on, so autopilot won't run ${outcome.toolName}. Shift+Tab to switch modes.`, "warn");
      return "deny";
    }
    const render = safeRender(req.tool, req.args);
    const answer = await sdk.permission(cam, {
      request_id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tool: req.tool.name,
      action: render?.title ?? req.tool.name,
      ...(render?.diff ? { diff: render.diff } : {}),
    });
    if (answer.choice === "allow_once") return "allow";
    if (answer.choice === "allow_session") return "allow_session";
    return "deny";
  };

  async function runTurn(text: string): Promise<void> {
    busy = true;
    if (!session) {
      const intent = classifyIntent(text);
      session = {
        id: makeSessionId(text),
        createdAt: new Date().toISOString(),
        title: generateSessionTitle(text, intent.tier),
      };
    }
    messages.push({ role: "user", content: text });
    controller = new AbortController();
    status({ phase: "thinking", activity: "" });

    let streamSeq = 0;
    let streamId: string | null = null;
    const toolRenders = new Map<string, ReturnType<typeof safeRender>>();

    try {
      await runAgentTurn({
        ...llmAuthFromConfig(cfg),
        model,
        reasoningEffort: cfg.reasoningEffort,
        messages,
        tools: ALL_TOOLS,
        executor,
        cwd,
        signal: controller.signal,
        codeMode: cfg.codeMode,
        maxTotalToolIterations: cfg.maxTotalToolIterations,
        preferPullRequests: cfg.preferPullRequests,
        callbacks: {
          onAssistantStart: () => {
            streamId = `s${++streamSeq}`;
            cam.send("AssistantStreamStarted", { stream_id: streamId });
          },
          onTextDelta: (delta: string) => {
            if (!streamId) {
              streamId = `s${++streamSeq}`;
              cam.send("AssistantStreamStarted", { stream_id: streamId });
            }
            cam.send("AssistantTokenDelta", { stream_id: streamId, token: delta });
          },
          onAssistantFinal: () => {
            if (streamId) cam.send("AssistantMessageCompleted", { stream_id: streamId });
            streamId = null;
          },
          onToolCallFinalized: (call: ToolCall) => {
            const spec = executor.list().find((t) => t.name === call.function.name);
            const render = spec ? safeRender(spec, parseArgs(call.function.arguments)) : undefined;
            toolRenders.set(call.id, render);
            const { label, args } = toolRow(call.function.name, render?.title, call.function.arguments);
            cam.send("ToolExecutionStarted", { tool_id: call.id, tool: label, command: args });
            status({ activity: `Running ${label}` });
          },
          onToolResult: (r: ToolResult) => {
            const render = toolRenders.get(r.tool_call_id);
            const declined = !r.ok && typeof r.content === "string" && r.content.startsWith("Permission denied");
            cam.send("ToolExecutionFinished", {
              tool_id: r.tool_call_id,
              exit_code: r.ok ? 0 : 1,
              status: declined ? "rejected" : r.ok ? "done" : "error",
              summary: toolSummary(r, declined),
              output: declined ? "" : r.content,
              ...(r.ok && render?.diff ? { diff: render.diff } : {}),
            });
            status({ activity: "" });
          },
          onUsage: (u: Usage) => status({ tokens: `${formatK(u.prompt_tokens)} tokens` }),
          onUsageFinal: (u: Usage, meta?: ResponseMeta) => {
            status({ tokens: `${formatK(u.prompt_tokens)} tokens` });
            if (session) {
              void recordUsage(session.id, u, costLookupFromConfig(cfg, meta ?? responseMeta), model).then(refreshCost);
            }
          },
          onResponseMeta: (m: ResponseMeta) => {
            responseMeta = m;
          },
          onTasks: (tasks: { id: string; title: string; status: string }[]) => {
            cam.send("TodoListUpdate", {
              todos: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
            });
          },
          onInfo: (text: string) => notice(text),
          onWarning: (msg: string) => notice(msg, "warn"),
          onGuardrail: (ev: { message: string }) => notice(ev.message, "warn"),
          onMemoryRecalled: (count: number) => {
            if (count > 0) notice(`Recalled ${count} ${count === 1 ? "memory" : "memories"} about this repo`);
          },
          askPermission,
        },
      });
    } catch (err) {
      if (controller?.signal.aborted) {
        // The renderer already printed "Interrupted"; nothing to add.
      } else if (err instanceof BudgetExhaustedError) {
        notice("This session used up its input-token budget. Start a new session with /clear.", "error");
      } else if (err instanceof AgentLoopError) {
        notice("Stopped: the agent was repeating the same tool calls.", "error");
      } else if (err instanceof KimiApiError) {
        notice(humanizeApiError(err), "error");
      } else {
        notice(err instanceof Error ? err.message : String(err), "error");
      }
    } finally {
      if (streamId) cam.send("AssistantMessageCompleted", { stream_id: streamId });
      cam.send("TodoListUpdate", { todos: [] });
      status({ phase: "idle", activity: "" });
      controller = null;
      busy = false;
      await persist();
    }
    const next = queue.shift();
    if (next !== undefined) void runTurn(next);
  }

  async function slash(input: string): Promise<void> {
    try {
      await runSlash(input);
    } catch (err) {
      logger.error("camouflage.slash", { input, error: String(err) });
      notice(`${input} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  async function runSlash(input: string): Promise<void> {
    const [name, ...rest] = input.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (name) {
      case "help":
        cam.send("ShowKeyValueView", {
          id: "help",
          title: "Commands",
          items: COMMANDS.map((c) => ({ label: `/${c.name}${c.args_hint ? ` ${c.args_hint}` : ""}`, value: c.description })),
        });
        return;
      case "mode": {
        const next = arg ? (MODES.find((m) => m === arg) ?? null) : nextMode(mode);
        if (!next) return void notice(`Unknown mode "${arg}". Use edit, plan or auto.`, "warn");
        setMode(next);
        cam.send("ShowToast", { text: `Mode: ${next}` });
        return;
      }
      case "model": {
        let chosen = arg;
        if (!chosen) {
          const models = await loadOpenRouterCatalog().catch(() => []);
          if (models.length === 0) return void notice("Couldn't load the model list. Try /model <id>.", "warn");
          const pick = await sdk.selectList(cam, {
            id: `model-${Date.now()}`,
            prompt: "Select a model",
            default: model,
            options: models.map((m) => ({ value: m.id, label: m.id, description: m.name })),
          });
          if (pick.cancelled || !pick.value) return;
          chosen = pick.value;
        }
        model = chosen;
        messages[0] = systemMessage();
        status({ model: shortModel(model) });
        notice(`Model set to ${model}. It applies from the next turn.`);
        return;
      }
      case "cost": {
        const report = await getCostReport(session?.id).catch(() => null);
        if (!report) return void notice("No usage recorded yet.");
        const row = (label: string, d: { cost: number; promptTokens: number; completionTokens: number }) => ({
          label,
          value: `$${d.cost.toFixed(2)} · ${formatK(d.promptTokens)} in · ${formatK(d.completionTokens)} out`,
        });
        cam.send("ShowKeyValueView", {
          id: "cost",
          title: "Usage",
          items: [row("This session", report.session), row("Today", report.today), row("This month", report.month), row("All time", report.allTime)],
        });
        return;
      }
      case "clear":
        if (busy) return void notice("Can't clear while a turn is running. Press Esc to interrupt first.", "warn");
        await persist();
        messages = [systemMessage()];
        session = null;
        executor.clearSessionPermissions();
        cam.send("TranscriptCleared", {});
        cam.send("ShowToast", { text: "Started a new conversation" });
        return;
      case "exit":
      case "quit":
        await shutdown(0);
        return;
      default:
        notice(`/${name} isn't available in the Camouflage UI yet. Run \`autopilot --ui ink\` to use it.`, "warn");
    }
  }

  let shuttingDown = false;
  async function shutdown(code: number): Promise<never> {
    if (!shuttingDown) {
      shuttingDown = true;
      controller?.abort();
      await persist();
      await cam.close().catch(() => undefined);
      restoreConsole();
      if (session) process.stdout.write(`\nResume this conversation with: autopilot -c\n`);
    }
    process.exit(code);
  }

  cam.on("userInput", (text: string) => {
    logger.debug("camouflage.input", { text: text.slice(0, 200) });
    const t = text.trim();
    if (!t) return;
    if (t.startsWith("/")) {
      void slash(t);
    } else if (busy) {
      queue.push(t);
      cam.send("ShowToast", { text: `Queued · runs after this turn (${queue.length})` });
    } else {
      void runTurn(t);
    }
  });
  cam.on("cancelRequested", () => {
    queue.length = 0;
    controller?.abort();
  });
  cam.on("modeChangeRequested", () => setMode(nextMode(mode)));
  cam.on("exit", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(143));

  // Keep the process alive until the renderer exits.
  await new Promise<never>(() => undefined);
}

// ----- helpers ---------------------------------------------------------------

type Render = { title: string; body?: string; diff?: { path: string; before: string; after: string } };

function safeRender(spec: { render?: (args: any) => Render }, args: Record<string, unknown>): Render | undefined {
  try {
    return spec.render?.(args);
  } catch {
    return undefined;
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** "read src/a.ts" → { label: "Read", args: "src/a.ts" }. */
export function toolRow(name: string, title: string | undefined, rawArgs: string | undefined): { label: string; args: string } {
  const label = name.startsWith("mcp_") || name.startsWith("lsp_") ? name : name.charAt(0).toUpperCase() + name.slice(1);
  if (title) {
    const rest = title.toLowerCase().startsWith(`${name.toLowerCase()} `) ? title.slice(name.length + 1) : title;
    return { label, args: rest.trim() };
  }
  const args = (rawArgs ?? "").replace(/\s+/g, " ").trim();
  return { label, args: args.length > 120 ? `${args.slice(0, 119)}…` : args };
}

/** One line under the tool row: what the result amounts to. */
export function toolSummary(r: ToolResult, declined: boolean): string {
  if (declined) return "You declined this · tell autopilot what to do instead";
  const content = typeof r.content === "string" ? r.content : "";
  const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
  if (!r.ok) {
    const first = content.split("\n").find((l) => l.trim()) ?? "Failed";
    return first.length > 100 ? `${first.slice(0, 99)}…` : first;
  }
  switch (r.name) {
    case "read":
      return `${lines} ${lines === 1 ? "line" : "lines"}`;
    case "grep":
    case "glob":
      return lines === 0 ? "No matches" : `${lines} ${lines === 1 ? "match" : "matches"}`;
    case "write":
    case "edit":
      return content.split("\n")[0]?.slice(0, 100) || "Done";
    default:
      return lines === 0 ? "Done" : `${lines} ${lines === 1 ? "line" : "lines"} of output`;
  }
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function shortModel(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

function shortPath(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

function gitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Tracked and untracked-but-not-ignored files, for `@` mentions. */
function listFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).slice(0, 5000);
  } catch {
    return [];
  }
}

function captureConsole(): () => void {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const to = (level: "info" | "warn" | "error") => (...args: unknown[]) =>
    logger[level]("console", { message: args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" ") });
  console.log = to("info");
  console.info = to("info");
  console.debug = to("info");
  console.warn = to("warn");
  console.error = to("error");
  return () => Object.assign(console, saved);
}

function safeString(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
