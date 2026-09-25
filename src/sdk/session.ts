import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runAgentTurn, BudgetExhaustedError, AgentLoopError } from "../agent/loop.js";
import type { AgentCallbacks } from "../agent/loop.js";
import type { ChatMessage, ContentPart, Usage } from "../agent/messages.js";
import { buildSystemPrompt, buildSystemMessages, buildSessionPrefix } from "../agent/system-prompt.js";
import { ToolExecutor, ALL_TOOLS } from "../tools/executor.js";
import type { PermissionDecision, PermissionRequest, ToolResult } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { MemoryManager } from "../memory/manager.js";
import { LspManager } from "../lsp/manager.js";
import { makeLspTools } from "../tools/lsp.js";
import { saveSession, loadSession, makeSessionId, sessionsDir } from "../sessions.js";
import type { SessionFile } from "../sessions.js";
import { recordUsage } from "../usage-tracker.js";
import type { OpenRouterProviderPrefs } from "../agent/client.js";
import { llmAuthFromConfig, usesRequesty } from "../agent/llm-auth.js";
import { ensureOpenRouterCatalog } from "../models/openrouter-catalog.js";
import { ensureRequestyCatalog } from "../models/requesty-catalog.js";
import { resolveCustomEndpoint } from "../agent/custom-endpoint.js";
import { logger } from "../util/logger.js";
import { resolveSdkConfig } from "./config.js";
import type { CreateSessionOptions, KimiFlareSession, SessionEvent, SessionUsage, SessionStatus, PromptOptions } from "./types.js";
import { createDefaultPermissionHandler } from "./permissions.js";
import type { Mode } from "../mode.js";

export async function createAgentSession(
  opts: CreateSessionOptions,
): Promise<{ session: KimiFlareSession }> {
  const config = await resolveSdkConfig(opts);
  // Model capabilities/pricing come from OpenRouter's catalog (cached on disk,
  // refreshed every 6h; a failed fetch falls back to the cache or seed list).
  if (usesRequesty(llmAuthFromConfig(config))) await ensureRequestyCatalog();
  else if (!resolveCustomEndpoint(config)) await ensureOpenRouterCatalog();
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tools = opts.tools ?? ALL_TOOLS;
  // M6.1: SDK consumers opt in to hooks via `opts.enableHooks` (default
  // off — SDK is a primitive, not the TUI). When enabled, load from
  // the same settings.json files as the TUI / print mode.
  let hooks: import("../hooks/manager.js").HooksManager | undefined;
  if (opts.enableHooks) {
    const { HooksManager } = await import("../hooks/manager.js");
    hooks = new HooksManager(cwd);
  }
  const executor = new ToolExecutor(tools, { hooks });

  // Memory
  let memoryManager: MemoryManager | null = null;
  const memoryEnabled = opts.memoryEnabled ?? config.memoryEnabled ?? false;
  if (memoryEnabled) {
    const dbPath =
      config.memoryDbPath ?? join(homedir(), ".local", "share", "kimiflare", "memory.db");
    memoryManager = new MemoryManager({
      dbPath,
      ...llmAuthFromConfig(config),
      model: config.model,
      plumbingModel: config.plumbingModel,
      extractionModel: config.memoryExtractionModel,
      embeddingModel: config.memoryEmbeddingModel,
      maxAgeDays: config.memoryMaxAgeDays,
      maxEntries: config.memoryMaxEntries,
    });
    memoryManager.open();
  }

  // LSP
  let lspManager: LspManager | null = null;
  let lspTools: ToolSpec[] = [];
  const lspEnabled = opts.lspEnabled ?? config.lspEnabled ?? false;
  if (lspEnabled && config.lspServers) {
    lspManager = new LspManager();
    for (const [id, serverConfig] of Object.entries(config.lspServers)) {
      if (serverConfig.enabled === false) continue;
      try {
        await lspManager.startServer(id, serverConfig, cwd);
      } catch (e) {
        logger.warn("lsp:start_failed", { id, error: (e as Error).message });
      }
    }
    lspTools = makeLspTools(lspManager);
  }

  // Session persistence
  let sessionFile: SessionFile;
  if (opts.sessionId) {
    const filePath = join(sessionsDir(), `${opts.sessionId}.json`);
    try {
      sessionFile = await loadSession(filePath);
    } catch {
      sessionFile = {
        id: opts.sessionId,
        cwd,
        model: config.model,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
    }
  } else {
    sessionFile = {
      id: makeSessionId("sdk-session"),
      cwd,
      model: config.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
  }

  // Build initial system prompt
  const allTools = [...tools, ...lspTools];
  const systemPrompt = buildSystemPrompt({
    cwd,
    tools: allTools,
    model: config.model,
    preferPullRequests: config.preferPullRequests,
  });
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...sessionFile.messages.filter((m) => m.role !== "system"),
  ];

  const session = new InternalSession({
    sessionFile,
    cwd,
    config,
    messages,
    executor,
    memoryManager,
    lspManager,
    lspTools,
    allTools,
    permissionHandler: opts.permissionHandler,
    onKimiMdStale: opts.onKimiMdStale,
    hooks,
    provider: opts.provider,
  });

  return { session };
}

interface InternalSessionOpts {
  sessionFile: SessionFile;
  cwd: string;
  config: Awaited<ReturnType<typeof resolveSdkConfig>>;
  messages: ChatMessage[];
  executor: ToolExecutor;
  memoryManager: MemoryManager | null;
  lspManager: LspManager | null;
  lspTools: ToolSpec[];
  allTools: ToolSpec[];
  permissionHandler?: import("./types.js").PermissionHandler;
  onKimiMdStale?: () => void;
  provider?: OpenRouterProviderPrefs;
  /** M6.1: optional. When provided, the loop fires Stop at end-of-turn.
   *  PreToolUse / PostToolUse fire via the executor regardless. */
  hooks?: import("../hooks/manager.js").HooksManager;
}

class InternalSession implements KimiFlareSession {
  readonly sessionId: string;
  readonly cwd: string;
  messages: ChatMessage[];
  isStreaming = false;

  private config: InternalSessionOpts["config"];
  private executor: ToolExecutor;
  private memoryManager: MemoryManager | null;
  private lspManager: LspManager | null;
  private lspTools: ToolSpec[];
  private allTools: ToolSpec[];
  private permissionHandler: import("./types.js").PermissionHandler;
  private onKimiMdStale?: () => void;
  private provider?: OpenRouterProviderPrefs;
  private hooks?: import("../hooks/manager.js").HooksManager;

  private listeners = new Set<(event: SessionEvent) => void>();
  private steerQueue: string[] = [];
  private followUpQueue: string[] = [];
  private abortController: AbortController | null = null;
  private permissionResolvers = new Map<string, (decision: PermissionDecision) => void>();
  private nextRequestId = 0;
  private nextMessageId = 0;
  private currentAssistantMessageId: string | null = null;
  private currentMode: Mode = "edit";
  private model: string;
  private reasoningEffort: "low" | "medium" | "high" = "medium";
  private usage: SessionUsage = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    turnCount: 0,
  };
  private disposed = false;

  constructor(opts: InternalSessionOpts) {
    this.sessionId = opts.sessionFile.id;
    this.cwd = opts.cwd;
    this.messages = opts.messages;
    this.config = opts.config;
    this.executor = opts.executor;
    this.memoryManager = opts.memoryManager;
    this.lspManager = opts.lspManager;
    this.lspTools = opts.lspTools;
    this.allTools = opts.allTools;
    this.model = opts.config.model;
    this.reasoningEffort = opts.config.reasoningEffort ?? "medium";
    this.onKimiMdStale = opts.onKimiMdStale;
    this.provider = opts.provider;
    this.hooks = opts.hooks;

    this.permissionHandler =
      opts.permissionHandler ??
      createDefaultPermissionHandler({
        mode: this.currentMode,
        onRequest: (req) => {
          const requestId = `req_${this.nextRequestId++}`;
          this.emit({
            type: "permission.request",
            requestId,
            toolName: req.tool.name,
            args: req.args,
          });
        },
      });
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        logger.error("sdk:listener_error", { error: (e as Error).message });
      }
    }
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    if (this.disposed) throw new Error("Session is disposed");
    if (this.isStreaming) {
      this.steerQueue.push(text);
      return;
    }

    const mode = options?.mode ?? this.currentMode;
    const messageId = `msg_${this.nextMessageId++}`;

    // Build user message
    let userContent: string | ContentPart[] = text;
    if (options?.images && options.images.length > 0) {
      const parts: ContentPart[] = [{ type: "text", text }];
      for (const img of options.images) {
        if ("path" in img) {
          const { readFile } = await import("node:fs/promises");
          const data = await readFile(img.path, "base64");
          const mimeType = img.path.endsWith(".png")
            ? "image/png"
            : img.path.endsWith(".jpg") || img.path.endsWith(".jpeg")
              ? "image/jpeg"
              : "image/webp";
          parts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } });
        } else {
          parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
        }
      }
      userContent = parts;
    }

    const userMessage: ChatMessage = { role: "user", content: userContent };
    this.messages.push(userMessage);

    this.emit({ type: "message.start", messageId, role: "user" });
    this.emit({ type: "message.end", messageId });

    this.isStreaming = true;
    this.emit({ type: "status", status: "streaming" });

    this.abortController = new AbortController();

    try {
      await this.runTurn(mode, options?.maxToolIterations);

      // Append follow-ups
      for (const followUp of this.followUpQueue) {
        this.messages.push({ role: "user", content: followUp });
      }
      this.followUpQueue = [];

      this.isStreaming = false;
      this.emit({ type: "status", status: "idle" });
      await this.save();
    } catch (err) {
      this.isStreaming = false;
      if ((err as Error).name === "AbortError") {
        this.emit({ type: "session.end", reason: "aborted" });
        this.emit({ type: "status", status: "idle" });
      } else if (err instanceof BudgetExhaustedError || err instanceof AgentLoopError) {
        this.emit({ type: "session.end", reason: "error", error: (err as Error).message });
        this.emit({ type: "status", status: "error" });
        throw err;
      } else {
        this.emit({ type: "session.end", reason: "error", error: (err as Error).message });
        this.emit({ type: "status", status: "error" });
        throw err;
      }
    }
  }

  async steer(text: string): Promise<void> {
    if (!this.isStreaming) return;
    this.steerQueue.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUpQueue.push(text);
  }

  async abort(): Promise<void> {
    // Deny pending permission requests first: the executor awaits the
    // decision without racing the abort signal, so a turn blocked on
    // `permission.request` would otherwise keep running until the
    // 5-minute auto-deny timeout despite the abort.
    this.denyPendingPermissions();
    this.abortController?.abort();
  }

  setModel(modelId: string): void {
    this.model = modelId;
  }

  setMode(mode: "plan" | "edit" | "auto"): void {
    this.currentMode = mode;
  }

  setReasoningEffort(level: "low" | "medium" | "high"): void {
    this.reasoningEffort = level;
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const resolver = this.permissionResolvers.get(requestId);
    if (resolver) {
      resolver(decision);
      this.permissionResolvers.delete(requestId);
    }
  }

  private denyPendingPermissions(): void {
    // Resolve (deny) rather than drop the waiters: clearing the map
    // without resolving disarms the auto-deny timeout in askPermission,
    // which would leave an in-flight prompt() pending forever.
    for (const resolver of this.permissionResolvers.values()) {
      resolver("deny");
    }
    this.permissionResolvers.clear();
  }

  getUsage(): SessionUsage {
    return { ...this.usage };
  }

  getStatus(): SessionStatus {
    return {
      isStreaming: this.isStreaming,
      isCompacting: false,
      pendingSteer: [...this.steerQueue],
      pendingFollowUp: [...this.followUpQueue],
      currentMode: this.currentMode,
    };
  }

  async save(): Promise<void> {
    await saveSession({
      id: this.sessionId,
      cwd: this.cwd,
      model: this.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: this.messages,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.denyPendingPermissions();
    this.abortController?.abort();
    this.lspManager?.stopAll().catch(() => {});
    this.memoryManager?.close();
    this.listeners.clear();
  }

  private async runTurn(mode: Mode, maxToolIterations?: number): Promise<void> {
    const signal = this.abortController!.signal;
    const coauthor =
      this.config.coauthor !== false
        ? {
            name: this.config.coauthorName || "kimiflare",
            email: this.config.coauthorEmail || "kimiflare@proton.me",
          }
        : undefined;

    const callbacks: AgentCallbacks = {
      onAssistantStart: () => {
        const messageId = `msg_${this.nextMessageId++}`;
        this.currentAssistantMessageId = messageId;
        this.emit({ type: "message.start", messageId, role: "assistant" });
      },
      onReasoningDelta: (text) => {
        const messageId = this.currentAssistantMessageId;
        if (messageId) {
          this.emit({ type: "message.reasoning", messageId, text });
        }
      },
      onTextDelta: (text) => {
        const messageId = this.currentAssistantMessageId;
        if (messageId) {
          this.emit({ type: "message.delta", messageId, text });
        }
      },
      onAssistantFinal: () => {
        const messageId = this.currentAssistantMessageId;
        if (messageId) {
          this.emit({ type: "message.end", messageId });
        }
        this.currentAssistantMessageId = null;
      },
      onToolCallStart: (_index, id, name) => {
        // We don't have args yet at this point; wait for onToolCallFinalized
      },
      onToolCallFinalized: (call) => {
        let args: unknown;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        this.emit({
          type: "tool.start",
          toolCallId: call.id,
          toolName: call.function.name,
          args,
        });
      },
      onToolResult: (result) => {
        this.emit({
          type: "tool.result",
          toolCallId: result.tool_call_id,
          toolName: result.name,
          result: result.content,
          isError: !result.ok,
        });
      },
      onUsage: (usage) => {
        this.emit({
          type: "usage",
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        });
      },
      onUsageFinal: (usage, gatewayMeta) => {
        this.usage.totalInputTokens += usage.prompt_tokens;
        this.usage.totalOutputTokens += usage.completion_tokens;
        this.usage.turnCount += 1;
        void recordUsage(this.sessionId, usage, costLookup(this.config, gatewayMeta), this.model);
      },
      onTasks: (tasks) => {
        this.emit({ type: "tasks.update", tasks });
      },
      onWarning: (msg) => {
        this.emit({ type: "warning", message: msg });
      },
      askPermission: async (req) => {
        if (mode === "auto") return "allow";
        if (mode === "plan") {
          const { isBlockedInPlanMode, isReadOnlyBash } = await import("../mode.js");
          if (req.tool.name === "bash" && typeof req.args.command === "string" && isReadOnlyBash(req.args.command)) {
            return "allow";
          }
          if (isBlockedInPlanMode(req.tool.name)) {
            return "deny";
          }
          return "allow";
        }

        // edit mode: emit event and wait for external resolution
        const requestId = `req_${this.nextRequestId++}`;
        this.emit({
          type: "permission.request",
          requestId,
          toolName: req.tool.name,
          args: req.args,
        });

        const decision = await new Promise<PermissionDecision>((resolve) => {
          this.permissionResolvers.set(requestId, resolve);
          // Timeout after 5 minutes to avoid hanging forever
          setTimeout(() => {
            if (this.permissionResolvers.has(requestId)) {
              this.permissionResolvers.delete(requestId);
              resolve("deny");
            }
          }, 300_000);
        });

        this.emit({
          type: "permission.resolved",
          requestId,
          decision,
        });

        return decision;
      },
      onToolLimitReached: async () => {
        // In SDK mode, stop on limit reached
        this.emit({ type: "status", status: "error" });
        return "stop";
      },
      onKimiMdStale: () => {
        this.onKimiMdStale?.();
      },
    };

    await runAgentTurn({
      ...llmAuthFromConfig(this.config),
      ...(this.provider
        ? { provider: { ...(this.config.openrouterProvider ?? {}), ...this.provider } }
        : {}),
      model: this.model,
      messages: this.messages,
      tools: this.allTools,
      executor: this.executor,
      cwd: this.cwd,
      signal,
      callbacks,
      hooks: this.hooks, // M6.1: Stop fires at end-of-turn when enabled.
      maxToolIterations,
      reasoningEffort: this.reasoningEffort,
      coauthor,
      sessionId: this.sessionId,
      memoryManager: this.memoryManager,
      allowDirectPush: this.config.allowDirectPush,
      preferPullRequests: this.config.preferPullRequests,
      onIterationEnd: async (messages, _signal) => {
        // Inject steer queue messages
        for (const steerText of this.steerQueue) {
          messages.push({ role: "user", content: steerText });
        }
        this.steerQueue = [];
        return messages;
      },
      onFileChange: (path, content) => {
        if (content) {
          this.lspManager?.notifyChange(path, content);
        } else {
          void import("node:fs/promises")
            .then(({ readFile }) =>
              readFile(path, "utf8")
                .then((c) => this.lspManager?.notifyChange(path, c))
                .catch(() => {}),
            )
            .catch(() => {});
        }
      },
    });

    // Update system prompt if KIMI.md was generated
    if (existsSync(join(this.cwd, "KIMI.md"))) {
      this.messages[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: this.cwd,
          tools: this.allTools,
          model: this.model,
          mode: this.currentMode,
          preferPullRequests: this.config.preferPullRequests,
        }),
      };
    }
  }
}

function costLookup(
  config: InternalSessionOpts["config"],
  meta: import("../agent/client.js").ResponseMeta | undefined,
): import("../usage-tracker.js").CostLookup | undefined {
  // Custom endpoint active: the host's gateway does its own metering.
  if (!config.openrouterApiKey || !meta?.generationId || resolveCustomEndpoint(config)) return undefined;
  return { apiKey: config.openrouterApiKey, meta };
}
