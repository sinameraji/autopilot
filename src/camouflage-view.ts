/**
 * Camouflage UI (`--ui camouflage`): the same App as the Ink UI, drawn by
 * the Camouflage inline renderer.
 *
 * App keeps all of autopilot's interactive logic (turns, slash commands,
 * MCP/LSP/memory/hooks, queueing, sessions). Through an AppBridge it reports
 * what's on screen after each render; this module turns that into renderer
 * events and turns the user's input back into App actions. Ink renders
 * nothing in this mode.
 *
 * Needs camouflage-tui with the inline SDK. CAMOUFLAGE_BIN overrides the
 * renderer binary.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type { AppActions, AppBridge, AppModal, AppSnapshot } from "./ui/app-bridge.js";
import type { ChatEvent } from "./ui/chat.js";
import type { ToolEventState } from "./ui/tool-view.js";
import type { Cfg } from "./app.js";
import { BUILTIN_COMMANDS } from "./commands/builtins.js";
import { listModels } from "./models/registry.js";
import { MODES, type Mode } from "./mode.js";
import { logger } from "./util/logger.js";

interface CamouflageHandle {
  send(eventType: string, payload?: Record<string, unknown>): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  close(): Promise<number>;
}
interface CamouflageSdk {
  mount(opts: Record<string, unknown>): Promise<CamouflageHandle>;
  permission(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ choice: "allow_once" | "allow_session" | "deny" }>;
  selectList(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; value?: string; cancelled: boolean }>;
}

async function loadSdk(): Promise<CamouflageSdk> {
  const sdk = (await import("camouflage-tui").catch((err) => {
    throw new Error(`camouflage-tui is not installed (${(err as Error).message}). Reinstall autopilot, or use --ui ink.`);
  })) as unknown as Partial<CamouflageSdk>;
  if (typeof sdk.permission !== "function" || typeof sdk.mount !== "function" || typeof sdk.selectList !== "function") {
    throw new Error("the installed camouflage-tui is too old for --ui camouflage. Update autopilot, or use --ui ink.");
  }
  return sdk as CamouflageSdk;
}

export interface CamouflageViewOpts {
  cfg: Cfg;
  version: string;
  /** Mount App with this bridge (renderApp with the bridge, Ink drawing nothing). */
  runApp: (bridge: AppBridge) => Promise<void>;
}

export async function runCamouflageView(opts: CamouflageViewOpts): Promise<void> {
  const sdk = await loadSdk();
  const restoreConsole = captureConsole();
  const cam = await sdk.mount({
    ui: "inline",
    appTitle: "autopilot",
    inheritStderr: false,
    ...(process.env.CAMOUFLAGE_BIN ? { bin: process.env.CAMOUFLAGE_BIN } : {}),
  });
  cam.on("stderr", (chunk: string) => logger.warn("camouflage.stderr", { chunk }));

  const cwd = process.cwd();
  cam.send("SessionStarted", {
    title: `autopilot ${opts.version}`,
    detail: [
      [shortModel(opts.cfg.model), shortPath(cwd), gitBranch(cwd)].filter(Boolean).join(" · "),
      "/ for commands · @ to mention files · shift+tab to switch modes",
    ],
    accent: "orange",
    assistant_label: "autopilot",
  });
  cam.send("SlashCommandsRegistered", {
    commands: BUILTIN_COMMANDS.map((c) => ({ name: c.name, description: c.description, args_hint: c.argHint })),
  });
  const files = listFiles(cwd);
  if (files.length > 0) {
    cam.send("MentionCandidatesRegistered", { candidates: files.map((token) => ({ token, kind: "file" })) });
  }

  const view = new View(cam, sdk);
  cam.on("userInput", (text: string) => {
    view.echoed.push(text.trim());
    view.actions?.submit(text);
  });
  cam.on("cancelRequested", () => view.actions?.interrupt());
  cam.on("modeChangeRequested", () => view.actions?.cycleMode());

  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    await cam.close().catch(() => undefined);
    restoreConsole();
  };
  cam.on("exit", () => {
    // The user quit the renderer (Ctrl+C twice): end the App too.
    void finish().then(() => {
      if (view.actions) view.actions.exit();
      else process.exit(0);
    });
  });

  try {
    await opts.runApp(view);
  } finally {
    await finish();
    if (view.hadConversation) process.stdout.write("Resume this conversation with: autopilot -c\n");
  }
}

/** Translates App snapshots into renderer events, sending only what changed. */
class View implements AppBridge {
  actions: AppActions | null = null;
  hadConversation = false;
  /** Prompts the renderer already printed when the user submitted them. */
  echoed: string[] = [];
  /** Per-event state already sent, keyed by ChatEvent.key. */
  private sent = new Map<string, { text: number; done: boolean }>();
  /** Events before this index are fully sent and won't change. */
  private settled = 0;
  private firstKey: string | undefined;
  private segments: Record<string, string> = {};
  private todos = "";
  private permission: unknown = null;
  private openPrompt: string | null = null;

  constructor(
    private cam: CamouflageHandle,
    private sdk: CamouflageSdk,
  ) {}

  connect(actions: AppActions): void {
    this.actions = actions;
  }

  sync(s: AppSnapshot): void {
    this.syncEvents(s.events);
    this.syncStatus(s);
    const todos = JSON.stringify(s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })));
    if (todos !== this.todos) {
      this.todos = todos;
      this.cam.send("TodoListUpdate", { todos: JSON.parse(todos) });
    }
    this.syncPermission(s);
    this.syncPrompts(s);
  }

  private syncEvents(events: ChatEvent[]): void {
    // /clear, /resume and compaction replace the list: start over.
    if (events.length < this.settled || (this.firstKey !== undefined && events[0]?.key !== this.firstKey)) {
      this.cam.send("TranscriptCleared", {});
      this.sent.clear();
      this.settled = 0;
    }
    this.firstKey = events[0]?.key;
    let allSettledSoFar = true;
    for (let i = this.settled; i < events.length; i++) {
      const done = this.syncEvent(events[i]!);
      if (done && allSettledSoFar) this.settled = i + 1;
      else allSettledSoFar = false;
    }
  }

  /** Send whatever is new about one event. Returns true once it's final. */
  private syncEvent(e: ChatEvent): boolean {
    const prev = this.sent.get(e.key);
    if (prev?.done) return true;
    switch (e.kind) {
      case "user": {
        if (e.queued) return false;
        this.hadConversation = true;
        // The renderer printed what the user typed when they submitted it;
        // don't print App's copy again. (Messages App adds on its own,
        // e.g. from a resumed session, still go through.)
        const i = this.echoed.indexOf(e.text.trim());
        if (i >= 0) this.echoed.splice(0, i + 1);
        else this.cam.send("UserMessageCreated", { text: e.text });
        return this.mark(e.key, 0, true);
      }
      case "assistant": {
        if (!prev) this.cam.send("AssistantStreamStarted", { stream_id: e.key });
        const already = prev?.text ?? 0;
        if (e.text.length > already && e.text.startsWith(e.text.slice(0, already))) {
          this.cam.send("AssistantTokenDelta", { stream_id: e.key, token: e.text.slice(already) });
        }
        if (!e.streaming) {
          this.cam.send("AssistantMessageCompleted", { stream_id: e.key, text: e.text });
          return this.mark(e.key, e.text.length, true);
        }
        return this.mark(e.key, e.text.length, false);
      }
      case "tool":
        return this.syncTool(e, prev);
      case "info":
      case "memory":
        return this.notice(e.key, e.text, "info");
      case "error":
        return this.notice(e.key, e.text, "error");
      case "api_error":
        return this.notice(e.key, e.message, "error");
      case "jev":
        return this.notice(e.key, `Jev: ${e.result}${e.probability ? ` ${e.probability}` : ""} · ${e.receipt}`, "info");
      case "qrcode":
        this.cam.send("Splash", { text: [e.caption, "", ...e.lines].join("\n") });
        return this.mark(e.key, 0, true);
      default:
        return this.mark((e as { key: string }).key, 0, true);
    }
  }

  private syncTool(e: { key: string } & ToolEventState, prev: { text: number; done: boolean } | undefined): boolean {
    if (!prev) {
      const { label, args } = toolRow(e.name, e.render?.title, e.args);
      this.cam.send("ToolExecutionStarted", { tool_id: e.key, tool: label, command: args, started_at_ms: e.startedAt });
    }
    if (e.status === "queued" || e.status === "running") return this.mark(e.key, 0, false);
    const ok = e.status === "done";
    const content = e.result ?? "";
    this.cam.send("ToolExecutionFinished", {
      tool_id: e.key,
      exit_code: ok ? 0 : 1,
      status: e.status === "rejected" ? "rejected" : e.status === "cancelled" ? "cancelled" : ok ? "done" : "error",
      summary: toolSummary(e.name, ok, e.status === "rejected", content),
      output: e.status === "rejected" ? "" : content,
      ...(ok && e.render?.diff ? { diff: e.render.diff } : {}),
    });
    return this.mark(e.key, 0, true);
  }

  private notice(key: string, message: string, severity: "info" | "warn" | "error"): boolean {
    if (message.includes("\n")) {
      // Multi-line output (reports, lists) is preformatted: print it as-is.
      const color = severity === "error" ? "\x1b[31m" : severity === "warn" ? "\x1b[33m" : "\x1b[2m";
      this.cam.send("Splash", { text: message.split("\n").map((l) => `${color}${l}\x1b[0m`).join("\n") });
    } else {
      this.cam.send("RuntimeError", { message, severity });
    }
    return this.mark(key, 0, true);
  }

  private mark(key: string, text: number, done: boolean): boolean {
    this.sent.set(key, { text, done });
    return done;
  }

  private syncStatus(s: AppSnapshot): void {
    const next: Record<string, string> = {
      mode: s.mode === "auto" ? "auto" : s.mode === "plan" ? "plan" : "edit",
      phase: s.busy ? "thinking" : "idle",
      model: shortModel(s.model),
      tokens: s.usage ? `${formatK(s.usage.prompt_tokens)} tokens` : "",
      cost: s.sessionUsage ? `${s.sessionUsage.reconcilePending ? "≈" : ""}$${s.sessionUsage.cost.toFixed(2)}` : "",
    };
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (this.segments[k] !== v) changed[k] = v;
    }
    if (Object.keys(changed).length > 0) {
      this.segments = next;
      this.cam.send("StatusUpdate", { segments: changed });
    }
  }

  private syncPermission(s: AppSnapshot): void {
    if (!s.permission) {
      this.permission = null;
      return;
    }
    if (this.permission === s.permission.args) return;
    this.permission = s.permission.args;
    const { tool, args } = s.permission;
    let render: { title: string; diff?: { path: string; before: string; after: string } } | undefined;
    try {
      render = tool.render?.(args);
    } catch {
      render = undefined;
    }
    void this.sdk
      .permission(this.cam, {
        request_id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tool: tool.name,
        action: render?.title ?? tool.name,
        ...(render?.diff ? { diff: render.diff } : {}),
      })
      .then((answer) => {
        const decision = answer.choice === "allow_once" ? "allow" : answer.choice === "allow_session" ? "allow_session" : "deny";
        this.actions?.decidePermission(decision);
      });
  }

  /** Map App's pickers to renderer prompts; dialogs without one yet are
   *  closed with a pointer to the Ink UI. */
  private syncPrompts(s: AppSnapshot): void {
    const a = this.actions;
    if (!a) return;
    const want = (key: string, open: () => Promise<void>) => {
      if (this.openPrompt === key) return;
      this.openPrompt = key;
      void open().finally(() => {
        if (this.openPrompt === key) this.openPrompt = null;
      });
    };
    if (s.resumeSessions) {
      const sessions = s.resumeSessions;
      return want("resume", async () => {
        if (sessions.length === 0) {
          a.pickResume(null);
          return void this.cam.send("RuntimeError", { message: "No earlier conversations in this directory.", severity: "info" });
        }
        const r = await this.select("Resume a conversation", sessions.map((x) => ({ value: x.id, label: x.title ?? x.firstPrompt, description: `${relTime(x.updatedAt)} · ${x.messageCount} messages` })));
        a.pickResume(sessions.find((x) => x.id === r) ?? null);
      });
    }
    if (s.checkpoints) {
      const { list } = s.checkpoints;
      return want("checkpoint", async () => {
        const r = await this.select("Restore a checkpoint", list.map((c) => ({ value: c.id, label: c.label, description: relTime(c.timestamp) })));
        a.pickCheckpoint(r);
      });
    }
    if (s.planOptions) {
      const options = s.planOptions;
      return want("planOptions", async () => {
        const r = await this.select("Choose a plan", options.map((o, i) => ({ value: String(i), label: o.label })));
        a.pickPlanOption(r === null ? null : options[Number(r)] ?? null);
      });
    }
    const modal = s.modals[0];
    if (!modal) return;
    switch (modal) {
      case "model":
        return want("model", async () => {
          const models = listModels();
          const r = await this.select("Select a model", models.map((m) => ({ value: m.id, label: m.id, description: m.name })), s.model);
          a.pickModel(models.find((m) => m.id === r) ?? null);
        });
      case "mode":
        return want("mode", async () => {
          const r = await this.select("Switch mode", MODES.map((m) => ({ value: m, label: m })), s.mode);
          a.pickMode((r as Mode | null) ?? null);
        });
      case "planComplete":
        return want("planComplete", async () => {
          const r = await this.select("The plan is ready. What next?", [
            { value: "auto", label: "Execute this plan and accept changes (auto mode)" },
            { value: "edit", label: "Start building and ask for permission (edit mode)" },
            { value: "continue", label: "Continue planning or ask a question" },
          ]);
          a.pickPlanComplete((r as "auto" | "edit" | "continue" | null) ?? null);
        });
      case "help":
        this.cam.send("ShowKeyValueView", {
          id: "help",
          title: "Commands",
          items: BUILTIN_COMMANDS.map((c) => ({ label: `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`, value: c.description })),
        });
        a.closeModal("help");
        return;
      default:
        this.cam.send("RuntimeError", {
          message: `${modalName(modal)} isn't available in the Camouflage UI yet. Run \`autopilot --ui ink\` for it.`,
          severity: "warn",
        });
        a.closeModal(modal);
    }
  }

  private async select(prompt: string, options: { value: string; label: string; description?: string }[], current?: string): Promise<string | null> {
    const r = await this.sdk.selectList(this.cam, {
      id: `pick-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      prompt,
      options,
      ...(current ? { default: current } : {}),
    });
    return r.cancelled || r.value === undefined ? null : r.value;
  }
}

// ----- helpers ---------------------------------------------------------------

function modalName(m: AppModal): string {
  const names: Record<AppModal, string> = {
    model: "The model picker",
    mode: "The mode picker",
    theme: "/theme",
    ui: "/ui",
    help: "/help",
    memory: "The memory picker",
    skills: "The skills picker",
    shell: "The shell picker",
    planComplete: "The plan picker",
    commandList: "/command list",
    commandWizard: "The command editor",
    commandPicker: "The command picker",
    lspWizard: "The LSP setup wizard",
    remoteDashboard: "The remote dashboard",
    inbox: "The inbox",
    multiAgent: "Multi-agent settings",
    hooksDashboard: "The hooks dashboard",
    changelogImage: "/changelog-image",
  };
  return names[m];
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
export function toolSummary(name: string, ok: boolean, declined: boolean, content: string): string {
  if (declined) return "You declined this · tell autopilot what to do instead";
  const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
  if (!ok) {
    const first = content.split("\n").find((l) => l.trim()) ?? "Failed";
    return first.length > 100 ? `${first.slice(0, 99)}…` : first;
  }
  switch (name) {
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

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
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

/** The renderer owns the terminal; send stray console output to the log. */
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
