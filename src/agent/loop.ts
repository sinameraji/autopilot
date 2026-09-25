import { runKimi } from "./client.js";
import type { ResponseMeta } from "./client.js";
import type { LlmAuth } from "./llm-auth.js";
import { toOpenAIToolDefs, type ToolSpec } from "../tools/registry.js";
import type { ToolExecutor, PermissionAsker, ToolResult } from "../tools/executor.js";
import { mergeReasoningDetails, sanitizeString, stableStringify, stripOldImages } from "./messages.js";
import type { ChatMessage, ReasoningDetail, ToolCall, Usage } from "./messages.js";
import type { Task, PlanOption } from "../tools/registry.js";
import type { MemoryManager } from "../memory/manager.js";
import type { HybridResult } from "../memory/schema.js";
import { hasRecalledMemory, injectRecalledMemoryOnce } from "../memory/recall-inject.js";
import { logTurnDebug, analyzePrompt } from "../cost-debug.js";
import { EXTRACTORS } from "../memory/extractors.js";
import { stripHistoricalReasoning } from "./strip-reasoning.js";
import { generateTypeScriptApi, runInSandbox } from "../code-mode/index.js";
import { estimatePromptTokens } from "./artifact-compaction.js";
import { logger } from "../util/logger.js";
import { selectSkills } from "../skills/router.js";
import type { SemanticSkillRoutingResult } from "../skills/types.js";
import type Database from "better-sqlite3";
import { buildSystemPrompt, buildSessionPrefix } from "./system-prompt.js";
import { getModelOrInfer } from "../models/registry.js";
import type { Mode } from "../mode.js";

export interface AgentCallbacks {
  onAssistantStart?: () => void;
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onInfo?: (text: string) => void;
  onToolCallStart?: (index: number, id: string, name: string) => void;
  onToolCallArgs?: (index: number, delta: string) => void;
  onToolCallFinalized?: (call: ToolCall) => void;
  /** Called right before a tool call is handed to the executor for actual execution.
   *  Fires after onToolCallFinalized, one at a time, as tools are dequeued. */
  onToolWillExecute?: (toolCallId: string, name: string) => void;
  onUsage?: (usage: Usage) => void;
  onUsageFinal?: (usage: Usage, responseMeta?: ResponseMeta) => void;
  onResponseMeta?: (meta: ResponseMeta) => void;
  onAssistantFinal?: (msg: ChatMessage) => void;
  onToolResult?: (result: ToolResult) => void;
  onTasks?: (tasks: Task[]) => void;
  onPlanOptions?: (options: PlanOption[]) => void;
  /** Called once per session when the sandbox falls back to node:vm. */
  onWarning?: (message: string) => void;
  /** Called when a tool's content was truncated before being shown to the model.
   *  `artifactId`, when present, points at the full raw bytes in the artifact store. */
  onTruncation?: (info: { tool: string; toolCallId: string; rawBytes: number; reducedBytes: number; artifactId?: string }) => void;
  askPermission: PermissionAsker;
  /** Called when the tool-call iteration limit is reached. Return "continue" to
   *  reset the counter and keep going, or "stop" to end the turn immediately. */
  onToolLimitReached?: () => Promise<"continue" | "stop">;
  /** Called when the agent is detected repeating identical tool calls (loop). Return "continue" to
   *  reset the guardrail and keep going, "synthesize" to ask the agent to conclude without tools,
   *  or "stop" to end the turn immediately. */
  onLoopDetected?: () => Promise<"continue" | "stop" | "synthesize">;
  /** Called when accumulated high-signal memories suggest KIMI.md may be stale. */
  onKimiMdStale?: () => void;
  /** Called when session-start memory recall succeeds and memories are injected. */
  onMemoryRecalled?: (count: number) => void;
  /** Called when semantic skill routing completes. */
  onSkillsSelected?: (result: SemanticSkillRoutingResult) => void;
  /** Called after pre-turn setup (memory + skills) to emit the meta banner. */
  onMetaBanner?: (info: { intentTier: string; skillsActive: number; memoryRecalled: boolean }) => void;
  /** Called when worker status changes during multi-agent orchestration. */
  onWorkersUpdated?: (workers: import("./supervisor.js").ActiveWorker[]) => void;
}

/** Credentials come in as `LlmAuth` fields — spread `llmAuthFromConfig(cfg)`. */
export interface AgentTurnOpts extends LlmAuth {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  executor: ToolExecutor;
  cwd: string;
  signal: AbortSignal;
  callbacks: AgentCallbacks;
  maxToolIterations?: number;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  coauthor?: { name: string; email: string };
  sessionId?: string;
  githubToken?: string;
  /** Drop image_url parts from user messages older than this many turns. */
  keepLastImageTurns?: number;
  memoryManager?: MemoryManager | null;
  /** Enable Code Mode: present tools as a TypeScript API and execute generated code in a sandbox. */
  codeMode?: boolean;
  /** Called after write/edit tools succeed so LSP document sync can fire. */
  onFileChange?: (path: string, content: string) => void;
  /** When true, hitting the tool-call limit resets the counter and appends a continue message instead of throwing. */
  continueOnLimit?: boolean;
  /** Cumulative prompt token budget. When exceeded, a final synthesis turn is run and then BudgetExhaustedError is thrown. */
  maxInputTokens?: number;
  /** Intent classification result for this turn, for telemetry. */
  intentClassification?: { intent: string; tier: "light" | "medium" | "heavy"; rawScore: number; confidence: number };
  /** Skills injected into the system prompt for this turn. */
  selectedSkills?: { name: string; body: string }[];
  /**
   * M6.1: lifecycle hooks for events the loop owns (`Stop` at clean
   * turn end). PreToolUse / PostToolUse hooks live on the
   * `ToolExecutor` itself, so they fire for every executor caller
   * (standard loop, code-mode sandbox, init, SDK, print mode)
   * automatically — no need to thread `hooks` through to those.
   */
  hooks?: import("../hooks/manager.js").HooksManager;
  /** Called after each tool-iteration cycle to allow external compaction or state management.
   *  Return the (possibly mutated) messages array. */
  onIterationEnd?: (messages: ChatMessage[], signal: AbortSignal) => Promise<ChatMessage[]>;
  /** Shell override for the bash tool. If omitted, the tool auto-detects based on platform. */
  shell?: string;
  /** When false (default), the bash tool blocks `git push` to the default branch. */
  allowDirectPush?: boolean;
  /** When true (default), the system prompt instructs the model to prefer PRs over direct pushes. */
  preferPullRequests?: boolean;
  /** Session-start memory recall promise. If provided, awaited at turn start and injected into messages. */
  sessionStartRecall?: Promise<HybridResult[]>;
  /** Skills DB for semantic skill routing. */
  skillsDb?: Database.Database;
  /** Config for skill routing. */
  skillRoutingConfig?: {
    embeddingModel?: string;
    maxSkillTokens?: number;
  };
  /** Current mode for system prompt. */
  mode?: Mode;
  /** Whether to use cache-stable prompt assembly (dual system messages). */
  cacheStable?: boolean;
  /** Abort the API stream if no data arrives for this many milliseconds. Default 60000.
   *  A cold upstream provider after tool use can exceed the default — bump this for
   *  long-running embeddings / image-heavy turns. */
  idleTimeoutMs?: number;
  /** Once the first byte arrives, tighten the idle timeout to this value.
   *  Default 30000 — a live stream stalling mid-flight should surface fast. */
  postFirstByteIdleTimeoutMs?: number;
}

export class BudgetExhaustedError extends Error {
  constructor(message = "Cumulative input token budget exhausted") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class AgentLoopError extends Error {
  constructor(message = "Agent got stuck repeating the same tool calls") {
    super(message);
    this.name = "AgentLoopError";
  }
}

const codeModeApiCache = new Map<string, string>();

/** Per-session sliding window of turn indices where a high-signal memory landed.
 *  We fire `onKimiMdStale` when >=DRIFT_THRESHOLD events fall inside
 *  DRIFT_WINDOW recent turns. Replaces the older count-with-decay scheme
 *  which almost never fired on long sessions (RF-2 / OP-8). */
const driftEvents = new Map<string, number[]>();
const DRIFT_WINDOW = 10;
const DRIFT_THRESHOLD = 3;

export function _resetDriftEventsForTests(): void {
  driftEvents.clear();
}

/** Per-session count of fire-and-forget memory-extraction errors. Exposed via
 *  `getMemoryExtractionErrorCount` for a future `/memory health` surface. */
const memoryExtractionErrorCounts = new Map<string, number>();

export function getMemoryExtractionErrorCount(sessionId: string | undefined): number {
  return memoryExtractionErrorCounts.get(sessionId ?? "default") ?? 0;
}

export function _resetMemoryExtractionErrorCountsForTests(): void {
  memoryExtractionErrorCounts.clear();
}

/** Per-session web-fetch history. Lifted from per-turn so a research spiral
 *  split across multiple turns still trips the guardrail. */
const sessionWebFetchHistory = new Map<string, { url: string; domain: string }[]>();
/** Hard soft-cap of total web fetches per session before we nudge for synthesis. */
const SESSION_WEB_FETCH_CAP = 25;

function getSessionWebFetchHistory(sessionId: string | undefined): { url: string; domain: string }[] {
  const key = sessionId ?? "default";
  let arr = sessionWebFetchHistory.get(key);
  if (!arr) {
    arr = [];
    sessionWebFetchHistory.set(key, arr);
  }
  return arr;
}

/** Test/embed hook: clears session web-fetch state. Not exported in the public API. */
export function _resetSessionWebFetchHistoryForTests(): void {
  sessionWebFetchHistory.clear();
}

function isHighSignalMemory(memory: {
  topicKey: string;
  category: string;
  importance: number;
}): boolean {
  return (
    memory.topicKey === "project_dependencies" ||
    memory.topicKey === "project_tsconfig" ||
    memory.topicKey === "project_entry_point" ||
    memory.category === "instruction" ||
    memory.category === "preference" ||
    (memory.category === "event" && memory.importance >= 3)
  );
}

/** Default completion budget if the caller doesn't pin one. Mirrors
 *  client.ts. The API counts `input + max_completion_tokens` against the
 *  context window, so this must be subtracted from the soft limit. */
const DEFAULT_MAX_COMPLETION_TOKENS = 16_384;

/** Extra headroom on top of `max_completion_tokens` to absorb estimator
 *  drift (we estimate prompt tokens via chars-per-token, which under-counts
 *  for code- and JSON-heavy content vs. the server-side tokenizer). */
const BUDGET_SAFETY_MARGIN_TOKENS = 8_192;

/** Max characters for a single tool result message before truncation.
 *  ~10k chars ≈ 2,500 tokens — generous but prevents runaway growth. */
const MAX_TOOL_CONTENT_CHARS = 10_000;

/** When Code Mode is on, these context-heavy IO tools must be called via
 *  api.<tool>() inside execute_code (so only console.log output returns to
 *  context) rather than as direct tools (whose full output floods the prompt).
 *  web_fetch is intentionally excluded so its session anti-abuse budget still
 *  applies on the direct path. */
const CODE_MODE_REDIRECT_TOOLS = new Set(["read", "bash", "grep", "glob"]);

/** Per-turn cap on redirect nudges. After this many, direct calls execute
 *  normally — a safety valve so a stubborn model or an unrunnable sandbox
 *  degrades to plain tool calling instead of looping or bricking. */
const MAX_CODE_MODE_REDIRECTS = 4;

function codeModeRedirectMessage(tool: string): string {
  return (
    `Code Mode is on: \`${tool}\` is not available as a direct tool because its full output would flood your context. ` +
    `Call \`api.${tool}({ ... })\` INSIDE an \`execute_code\` block instead — only what you \`console.log\` is returned to you. ` +
    `You can batch several reads/greps/commands in a single execute_code call.`
  );
}

function extractLastUserText(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
      } else {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }
    }),
  ]);
}

export async function runAgentTurn(opts: AgentTurnOpts): Promise<void> {
  const turnStart = performance.now();
  logger.info("turn:start", { sessionId: opts.sessionId, codeMode: opts.codeMode ?? false });
  const max = opts.maxToolIterations ?? 200;
  const codeMode = opts.codeMode ?? false;

  // M6.1: fire the Stop hook on any clean exit (turn ended normally,
  // user opted to stop on loop/limit). Skipped on abort/throw because
  // those aren't "the agent finished its turn." Inline at each return
  // site below — three of them in this function.
  const fireStopHook = async (): Promise<void> => {
    if (opts.signal.aborted) return;
    if (!opts.hooks?.hasEnabledHooks("Stop")) return;
    try {
      await opts.hooks.fire(
        "Stop",
        { event: "Stop", session_id: opts.sessionId ?? null, cwd: opts.cwd },
        null,
      );
    } catch {
      // best-effort — must not crash turn cleanup
    }
  };

  // --- Pre-turn async work (memory recall + skill routing, in parallel) ---
  const preTurnStart = performance.now();
  let memoryRecalledCount = 0;
  let skillResult: SemanticSkillRoutingResult | undefined;

  const lastUserPrompt = extractLastUserText(opts.messages);
  const userPromptPreview = lastUserPrompt.slice(0, 200);

  // Light + trivially short prompts skip skill routing entirely. These almost
  // never benefit from injected skills and the embeddings round-trip dominates
  // their wall-clock time. Threshold is conservative — anything substantive
  // crosses 40 chars quickly.
  const skipSkillRouting =
    opts.intentClassification?.tier === "light" &&
    lastUserPrompt.length < 40;

  // Session-start recall is a ONE-SHOT: the supervisor reuses the same recall
  // promise across every runAgentTurn invocation, so without this guard we
  // re-synthesize (a byte-different paraphrase) and re-splice a recall block on
  // every turn, stacking duplicates at the front of the array and busting the
  // prompt-prefix cache. Skip entirely once a block is already present.
  const recallPromise: Promise<{ text: string; count: number } | null> =
    opts.sessionStartRecall && opts.memoryManager && !hasRecalledMemory(opts.messages)
      ? (async () => {
          const results = await opts.sessionStartRecall!;
          if (results.length === 0 || !opts.memoryManager) return null;
          const text = await opts.memoryManager.synthesizeRecalled(results, opts.signal);
          return { text, count: results.length };
        })()
      : Promise.resolve(null);

  const skillsPromise: Promise<SemanticSkillRoutingResult | undefined> =
    opts.skillsDb && opts.skillRoutingConfig && opts.intentClassification && lastUserPrompt && !skipSkillRouting
      ? selectSkills(
          {
            prompt: lastUserPrompt,
            tier: opts.intentClassification.tier,
            maxSkillTokens: opts.skillRoutingConfig.maxSkillTokens ?? 250_000 - 10_000,
          },
          {
            db: opts.skillsDb,
            ...llmAuthOf(opts),
            embeddingModel: opts.skillRoutingConfig.embeddingModel,
          },
        )
      : Promise.resolve(undefined);

  const [recallSettled, skillsSettled] = await Promise.allSettled([
    raceWithSignal(recallPromise, opts.signal),
    raceWithSignal(skillsPromise, opts.signal),
  ]);

  // Propagate abort; swallow other failures (both paths are non-fatal).
  for (const settled of [recallSettled, skillsSettled]) {
    if (
      settled.status === "rejected" &&
      settled.reason instanceof DOMException &&
      settled.reason.name === "AbortError"
    ) {
      throw settled.reason;
    }
  }

  if (recallSettled.status === "fulfilled" && recallSettled.value) {
    const { text, count } = recallSettled.value;
    if (injectRecalledMemoryOnce(opts.messages, text)) {
      memoryRecalledCount = count;
      opts.callbacks.onMemoryRecalled?.(count);
    }
  }

  if (skillsSettled.status === "fulfilled" && skillsSettled.value) {
    skillResult = skillsSettled.value;
    opts.callbacks.onSkillsSelected?.(skillResult);

    const allTools = opts.tools;
    if (opts.cacheStable) {
      opts.messages[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: opts.cwd,
          tools: allTools,
          model: opts.model,
          mode: opts.mode,
          skillContext: skillResult.skillContext,
          preferPullRequests: opts.preferPullRequests,
        }),
      };
    } else {
      opts.messages[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: opts.cwd,
          tools: allTools,
          model: opts.model,
          mode: opts.mode,
          skillContext: skillResult.skillContext,
          preferPullRequests: opts.preferPullRequests,
        }),
      };
    }
  }

  if (opts.signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const preTurnMs = Math.round(performance.now() - preTurnStart);

  opts.callbacks.onMetaBanner?.({
    intentTier: opts.intentClassification?.tier ?? "medium",
    skillsActive: skillResult?.sectionCount ?? 0,
    memoryRecalled: memoryRecalledCount > 0,
  });

  let toolDefs: ReturnType<typeof toOpenAIToolDefs>;
  let codeModeApiString = "";

  if (codeMode) {
    const toolsKey = stableStringify(opts.tools);
    const cached = codeModeApiCache.get(toolsKey);
    if (cached) {
      codeModeApiString = cached;
    } else {
      codeModeApiString = generateTypeScriptApi(opts.tools);
      codeModeApiCache.set(toolsKey, codeModeApiString);
    }
    toolDefs = [
      {
        type: "function",
        function: {
          name: "execute_code",
          description:
            `Write and execute TypeScript code to accomplish your task.\n\n` +
            `Available APIs:\n${codeModeApiString}\n\n` +
            `Use console.log() to return results. Only console.log output is sent back to you.\n\n` +
            `IMPORTANT — explore through code, not direct tools: to read files, run shell commands, grep, or glob, ` +
            `call api.read(...), api.bash(...), api.grep(...), api.glob(...) INSIDE this code block and console.log only what you need. ` +
            `Do NOT call read/bash/grep/glob as separate tools — their full output floods your context, while here only what you log returns. ` +
            `Batch multiple reads/greps/commands into a single execute_code call.`,
          parameters: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "TypeScript code to execute. Use the api object to call available tools.",
              },
              reasoning: {
                type: "string",
                description: "Brief reasoning about what the code does.",
              },
            },
            required: ["code"],
            additionalProperties: false,
          },
        },
      },
    ];
  } else {
    toolDefs = toOpenAIToolDefs(opts.tools);
  }

  let turn = 0;
  let lastUsage: Usage | null = null;

  // Anti-loop guardrail: track recent tool call signatures to detect thrashing
  const recentToolCalls: string[] = [];
  const LOOP_WINDOW = 8;
  const LOOP_THRESHOLD = 2; // 3rd identical call triggers the guardrail

  // Web-fetch anti-loop: domain counts and the total now span the session,
  // so a research spiral split across turns still trips the guardrail.
  // (RF-3 / OP-6.) The per-turn ceiling stays in place for hot-path bursts.
  const webFetchHistory = getSessionWebFetchHistory(opts.sessionId);
  let webFetchesThisTurn = 0;
  // Per-turn counter of Code Mode redirect nudges (capped by MAX_CODE_MODE_REDIRECTS).
  let codeModeRedirects = 0;
  const MAX_WEB_FETCH_PER_TURN = 5;
  const WEB_FETCH_DOMAIN_THRESHOLD = 2; // 3rd fetch to same domain triggers warning

  let cumulativePromptTokens = 0;
  let iter = 0;
  let budgetExhausted = false;
  let loopExhausted = false;

  // Task auto-advance heuristic: track tasks state and mutating tools since
  // the last tasks_set so we can nudge the UI forward when the model forgets.
  let currentTasks: Task[] = [];
  let mutatingToolsSinceLastTasksSet = 0;
  const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);
  const AUTO_ADVANCE_THRESHOLD = 3;
  const originalOnTasks = opts.callbacks.onTasks;
  const wrappedOnTasks = (tasks: Task[]) => {
    currentTasks = tasks;
    mutatingToolsSinceLastTasksSet = 0;
    originalOnTasks?.(tasks);
  };

  while (true) {
    // Budget enforcement: before starting a new turn, if we've already hit the
    // limit, run one final synthesis turn and then signal budget exhaustion.
    if (budgetExhausted) {
      opts.messages.push({
        role: "system",
        content:
          "You have reached the cumulative input token budget for this session. " +
          "Please synthesize your findings and provide a final summary of what was accomplished.",
      });
    }

    if (loopExhausted) {
      opts.messages.push({
        role: "system",
        content:
          "You have repeatedly called the same tools with identical arguments and are stuck in a loop. " +
          "Please synthesize what you know from the conversation history and provide a final answer.",
      });
    }

    if (iter >= max) {
      if (opts.callbacks.onToolLimitReached) {
        const decision = await opts.callbacks.onToolLimitReached();
        if (decision === "continue") {
          opts.messages.push({
            role: "system",
            content:
              "You have reached the tool-call limit for this session. " +
              "The counter has been reset so you can continue working. Please proceed with your task.",
          });
          iter = 0;
        } else {
          await fireStopHook();
          return;
        }
      } else if (opts.continueOnLimit) {
        opts.messages.push({
          role: "system",
          content:
            "You have reached the tool-call limit for this session. " +
            "The counter has been reset so you can continue working. Please proceed with your task.",
        });
        iter = 0;
      } else {
        throw new Error(`kimiflare: tool iteration limit reached (${max})`);
      }
    }

    iter++;
    turn++;
    const previousMessages = opts.messages.slice();
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let content = "";
    let reasoning = "";
    let responseMeta: ResponseMeta | undefined;
    let reasoningDetails: ReasoningDetail[] = [];
    opts.callbacks.onAssistantStart?.();

    const stripReasoning = process.env.KIMIFLARE_STRIP_REASONING === "1";
    const shadowStrip = process.env.KIMIFLARE_SHADOW_STRIP === "1";
    const keepLastRaw = process.env.KIMIFLARE_REASONING_KEEP_LAST;
    const keepLast = keepLastRaw ? parseInt(keepLastRaw, 10) : 1;

    let apiMessages = opts.messages;
    let shadowStripMetrics:
      | { originalApproxTokens: number; strippedApproxTokens: number; savingsPct: number }
      | undefined;

    if (stripReasoning || shadowStrip) {
      const stripped = stripHistoricalReasoning(opts.messages, {
        keepLast: Number.isNaN(keepLast) ? 1 : keepLast,
      });
      if (shadowStrip) {
        const originalSections = analyzePrompt(opts.messages);
        const strippedSections = analyzePrompt(stripped);
        const originalApproxTokens = originalSections.reduce(
          (sum, s) => sum + s.approxTokens,
          0,
        );
        const strippedApproxTokens = strippedSections.reduce(
          (sum, s) => sum + s.approxTokens,
          0,
        );
        shadowStripMetrics = {
          originalApproxTokens,
          strippedApproxTokens,
          savingsPct:
            originalApproxTokens > 0
              ? Math.round(
                  ((originalApproxTokens - strippedApproxTokens) / originalApproxTokens) * 100,
                )
              : 0,
        };
      }
      if (stripReasoning) {
        apiMessages = stripped;
      }
    }

    if (opts.keepLastImageTurns !== undefined) {
      apiMessages = stripOldImages(apiMessages, opts.keepLastImageTurns);
    }

    const promptTokens = estimatePromptTokens(apiMessages);
    const ctxWindow = getModelOrInfer(opts.model).contextWindow;
    // The API rejects when `input + max_completion_tokens > ctxWindow`,
    // so compute the budget from those exact terms (plus a safety margin
    // for estimator drift) rather than a flat percentage.
    const completionBudget = opts.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    const maxPromptTokens = ctxWindow - completionBudget - BUDGET_SAFETY_MARGIN_TOKENS;
    if (promptTokens > maxPromptTokens) {
      throw new Error(
        `kimiflare: context window exceeded (~${promptTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens). ` +
          `Run /compact to summarize older turns, or /clear to start fresh.`,
      );
    }

    logger.debug("turn:api_request", { sessionId: opts.sessionId, messageCount: apiMessages.length });
    const events = runKimi({
      ...llmAuthOf(opts),
      model: opts.model,
      messages: apiMessages,
      tools: toolDefs,
      signal: opts.signal,
      temperature: opts.temperature,
      maxCompletionTokens: opts.maxCompletionTokens,
      reasoningEffort: opts.reasoningEffort,
      sessionId: opts.sessionId,
      idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
      postFirstByteIdleTimeoutMs: opts.postFirstByteIdleTimeoutMs,
    });

    let gotFirstChunk = false;
    for await (const ev of events) {
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        logger.debug("turn:api_first_chunk", { sessionId: opts.sessionId });
      }
      switch (ev.type) {
        case "response_meta":
          responseMeta = ev.meta;
          opts.callbacks.onResponseMeta?.(ev.meta);
          break;
        case "reasoning_details":
          reasoningDetails = mergeReasoningDetails(reasoningDetails, ev.details);
          break;
        case "reasoning":
          reasoning += ev.delta;
          opts.callbacks.onReasoningDelta?.(ev.delta);
          break;
        case "text":
          content += ev.delta;
          opts.callbacks.onTextDelta?.(ev.delta);
          break;
        case "tool_call_start":
          opts.callbacks.onToolCallStart?.(ev.index, ev.id, ev.name);
          break;
        case "tool_call_args":
          opts.callbacks.onToolCallArgs?.(ev.index, ev.argsDelta);
          break;
        case "tool_call_complete": {
          const safeArgs = validateToolArguments(ev.arguments);
          const call: ToolCall = {
            id: ev.id,
            type: "function",
            function: { name: ev.name, arguments: safeArgs },
          };
          toolCalls.push(call);
          opts.callbacks.onToolCallFinalized?.(call);
          break;
        }
        case "usage":
          lastUsage = ev.usage;
          opts.callbacks.onUsage?.(ev.usage);
          break;
        case "done":
          break;
      }
    }

    if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");

    if (lastUsage) {
      opts.callbacks.onUsageFinal?.(lastUsage, responseMeta);
      cumulativePromptTokens += lastUsage.prompt_tokens;
      // Flip the budget flag regardless of whether this turn produced tool
      // calls — a long pure-text turn past the cap should still trip the
      // limit. The no-tools branch below short-circuits to BudgetExhaustedError
      // instead of an extra synthesis turn. (RF-5 / OP-9.)
      if (
        !budgetExhausted &&
        opts.maxInputTokens !== undefined &&
        opts.maxInputTokens > 0 &&
        cumulativePromptTokens >= opts.maxInputTokens
      ) {
        budgetExhausted = true;
      }
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: content ? sanitizeString(content) : null,
      ...(reasoning ? { reasoning_content: sanitizeString(reasoning) } : {}),
      ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((tc) => ({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: sanitizeString(tc.function.arguments),
              },
            })),
          }
        : {}),
    };
    opts.messages.push(assistantMsg);
    opts.callbacks.onAssistantFinal?.(assistantMsg);

    if (toolCalls.length === 0) {
      if (opts.sessionId && lastUsage) {
        void logTurnDebug({
          sessionId: opts.sessionId,
          turn,
          messages: opts.messages,
          previousMessages,
          toolResults,
          usage: lastUsage,
          shadowStrip: shadowStripMetrics,
          durationMs: Math.round(performance.now() - turnStart),
          intentClassification: opts.intentClassification,
          codeMode: opts.codeMode,
          selectedSkills: opts.selectedSkills,
          userPromptPreview,
          preTurnMs,
          memoryRecalled: memoryRecalledCount > 0,
        });
      }
      if (budgetExhausted) {
        throw new BudgetExhaustedError();
      }
      logger.info("turn:complete", { sessionId: opts.sessionId, durationMs: Math.round(performance.now() - turnStart) });
      await fireStopHook();
      return;
    }

    let blockedCount = 0;

    // Determine if every tool in this batch is read-only.  When they are,
    // we can execute them in parallel because there are no write-order
    // dependencies or mutation side-effects to sequence.
    const allReadOnly =
      toolCalls.length > 1 &&
      toolCalls.every((tc) => {
        const tool = opts.executor.list().find((t) => t.name === tc.function.name);
        return tool?.isReadOnly === true;
      });

    // NOTE: Extending parallel execution to *mutable* tool calls is
    // possible but requires an explicit dependency graph (e.g. a write to
    // file X must complete before a subsequent read of file X).  Without
    // such ordering guarantees, parallelising mutable calls risks race
    // conditions and non-deterministic results.  If you want to add this
    // in the future, build a DAG of tool dependencies first, then execute
    // each topological layer in parallel while respecting the sequential
    // order within a layer.
    if (allReadOnly) {
      opts.callbacks.onInfo?.(`${toolCalls.length} read-only tools running in parallel`);
      type ParallelItem =
        | { kind: "blocked"; tc: ToolCall; loopSignature: string; result: ToolResult }
        | { kind: "run"; tc: ToolCall; loopSignature: string };

      const items: ParallelItem[] = [];
      for (const tc of toolCalls) {
        if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
        const loopSignature = `${tc.function.name}:${stableStringify(tc.function.arguments)}`;
        const loopCount = recentToolCalls.filter((s) => s === loopSignature).length;
        if (loopCount >= LOOP_THRESHOLD) {
          items.push({
            kind: "blocked",
            tc,
            loopSignature,
            result: {
              tool_call_id: tc.id,
              name: tc.function.name,
              content: `Loop detected: you have called ${tc.function.name} with the same arguments multiple times in a row. Consider a different approach.`,
              ok: false,
            },
          });
          continue;
        }
        if (codeMode && CODE_MODE_REDIRECT_TOOLS.has(tc.function.name) && codeModeRedirects < MAX_CODE_MODE_REDIRECTS) {
          codeModeRedirects++;
          items.push({
            kind: "blocked",
            tc,
            loopSignature,
            result: { tool_call_id: tc.id, name: tc.function.name, content: codeModeRedirectMessage(tc.function.name), ok: false },
          });
          continue;
        }
        if (tc.function.name === "web_fetch") {
          const args = JSON.parse(tc.function.arguments || "{}") as { url?: string };
          const url = args.url || "";
          try {
            const domain = new URL(url).hostname;
            const domainCount = webFetchHistory.filter((h) => h.domain === domain).length;
            const totalSessionFetches = webFetchHistory.length;
            if (
              webFetchesThisTurn >= MAX_WEB_FETCH_PER_TURN ||
              totalSessionFetches >= SESSION_WEB_FETCH_CAP ||
              domainCount >= WEB_FETCH_DOMAIN_THRESHOLD
            ) {
              let warning: string;
              if (webFetchesThisTurn >= MAX_WEB_FETCH_PER_TURN) {
                warning = `Research budget exceeded: you have already made ${MAX_WEB_FETCH_PER_TURN} web requests this turn. Synthesize what you have learned instead of fetching more pages.`;
              } else if (totalSessionFetches >= SESSION_WEB_FETCH_CAP) {
                warning = `Session research budget exceeded: ${totalSessionFetches} web fetches across this session. Synthesize what you have learned from prior fetches instead of starting another page.`;
              } else {
                warning = `Loop detected: you have fetched from ${domain} multiple times. Consider a different approach or synthesize existing findings.`;
              }
              items.push({
                kind: "blocked",
                tc,
                loopSignature,
                result: { tool_call_id: tc.id, name: "web_fetch", content: warning, ok: false },
              });
              continue;
            }
            webFetchHistory.push({ url, domain });
            webFetchesThisTurn++;
          } catch {
            // Invalid URL, let it fail normally
          }
        }
        items.push({ kind: "run", tc, loopSignature });
      }

      const runItems = items.filter((it): it is ParallelItem & { kind: "run" } => it.kind === "run");
      const executed = await Promise.all(
        runItems.map(async (it) => {
          opts.callbacks.onToolWillExecute?.(it.tc.id, it.tc.function.name);
          logger.debug("turn:tool_start", { sessionId: opts.sessionId, tool: it.tc.function.name, toolCallId: it.tc.id });
          const result = await opts.executor.run(
            { id: it.tc.id, name: it.tc.function.name, arguments: it.tc.function.arguments },
            opts.callbacks.askPermission,
            {
              cwd: opts.cwd,
              signal: opts.signal,
              onTasks: wrappedOnTasks,
              onPlanOptions: opts.callbacks.onPlanOptions,
              coauthor: opts.coauthor,
              memoryManager: opts.memoryManager,
              sessionId: opts.sessionId,
              githubToken: opts.githubToken,
              shell: opts.shell,
              intentTier: opts.intentClassification?.tier,
              llmAuth: llmAuthOf(opts),
              model: opts.model,
              allowDirectPush: opts.allowDirectPush,
            },
            opts.onFileChange,
          );
          let content = result.content;
          if (content.length > MAX_TOOL_CONTENT_CHARS) {
            const rawBytes = content.length;
            content = content.slice(0, MAX_TOOL_CONTENT_CHARS) + `\n\n[truncated: ${rawBytes - MAX_TOOL_CONTENT_CHARS} chars omitted]`;
            opts.callbacks.onTruncation?.({
              tool: it.tc.function.name,
              toolCallId: it.tc.id,
              rawBytes,
              reducedBytes: content.length,
              artifactId: result.artifactId,
            });
          }
          return { ...result, content } as ToolResult;
        }),
      );

      const resultMap = new Map<string, ToolResult>();
      for (let i = 0; i < runItems.length; i++) {
        resultMap.set(runItems[i]!.tc.id, executed[i]!);
      }

      for (const it of items) {
        if (it.kind === "blocked") {
          toolResults.push(it.result);
          opts.messages.push({
            role: "tool",
            tool_call_id: it.tc.id,
            content: sanitizeString(it.result.content),
            name: it.tc.function.name,
          });
          opts.callbacks.onToolResult?.(it.result);
          recentToolCalls.push(it.loopSignature);
          if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
          blockedCount++;
          continue;
        }

        const result = resultMap.get(it.tc.id)!;
        if (!result.ok && result.errorCode === "policy_rejection") {
          logger.warn("hook:vetoed_tool_call", {
            sessionId: opts.sessionId,
            tool: it.tc.function.name,
            toolCallId: it.tc.id,
          });
        }
        logger.debug("turn:tool_end", { sessionId: opts.sessionId, tool: it.tc.function.name, toolCallId: it.tc.id, ok: result.ok });
        if (!result.ok && result.errorCode) {
          logger.warn("tool:error_classified", {
            sessionId: opts.sessionId,
            tool: it.tc.function.name,
            toolCallId: it.tc.id,
            code: result.errorCode,
            recoverable: result.recoverable,
          });
        }
        toolResults.push(result);
        opts.messages.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          content: sanitizeString(result.content),
          name: result.name,
        });
        opts.callbacks.onToolResult?.(result);

        if (opts.memoryManager) {
          let filePath: string | undefined;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(it.tc.function.arguments || "{}") as Record<string, unknown>;
            filePath = toolArgs.path as string | undefined;
          } catch {
            // ignore parse errors
          }
          const lastAssistant = [...opts.messages].reverse().find(
            (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
          );
          const assistantMessage = lastAssistant?.content ?? "";
          const llmOpts = opts.memoryManager.getExtractionLlmOpts();
          const turnAtMemoryCommit = turn;
          for (const extractor of EXTRACTORS) {
            if (extractor.match(it.tc.function.name, filePath)) {
              void (async () => {
                try {
                  const memory = await extractor.extract(result.content, filePath, {
                    toolArgs: { ...toolArgs, _toolName: it.tc.function.name },
                    assistantMessage: typeof assistantMessage === "string" ? assistantMessage : "",
                    llmOpts: { ...llmOpts, signal: opts.signal },
                  });
                  if (memory) {
                    await opts.memoryManager!.remember(
                      memory.content,
                      memory.category,
                      memory.importance,
                      opts.cwd,
                      opts.sessionId ?? "unknown",
                      opts.signal,
                      undefined,
                      memory.topicKey,
                    );
                    if (isHighSignalMemory(memory)) {
                      const sid = opts.sessionId ?? "default";
                      const events = driftEvents.get(sid) ?? [];
                      events.push(turnAtMemoryCommit);
                      const cutoff = turnAtMemoryCommit - DRIFT_WINDOW + 1;
                      const recent = events.filter((t) => t >= cutoff);
                      driftEvents.set(sid, recent);
                      if (recent.length >= DRIFT_THRESHOLD) {
                        try {
                          opts.callbacks.onKimiMdStale?.();
                        } catch (cbErr) {
                          logger.debug("memory:onKimiMdStale_threw", {
                            sessionId: opts.sessionId,
                            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                          });
                        }
                        driftEvents.set(sid, []);
                      }
                    }
                  }
                } catch (err) {
                  const sid = opts.sessionId ?? "default";
                  const next = (memoryExtractionErrorCounts.get(sid) ?? 0) + 1;
                  memoryExtractionErrorCounts.set(sid, next);
                  const msg = err instanceof Error ? err.message : String(err);
                  logger.debug("memory:extract_error", {
                    sessionId: opts.sessionId,
                    tool: it.tc.function.name,
                    count: next,
                    error: msg,
                  });
                  if (next === 1) {
                    try {
                      opts.callbacks.onWarning?.(
                        `[memory] auto-extraction failed (${msg}). Subsequent failures will be counted silently; check /memory health.`,
                      );
                    } catch (cbErr) {
                      logger.debug("memory:onWarning_threw", {
                        sessionId: opts.sessionId,
                        error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                      });
                    }
                  }
                }
              })();
            }
          }
        }

        recentToolCalls.push(it.loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
      }
    } else {
      for (const [i, tc] of toolCalls.entries()) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");

      // Anti-loop guardrail
      const loopSignature = `${tc.function.name}:${stableStringify(tc.function.arguments)}`;
      const loopCount = recentToolCalls.filter((s) => s === loopSignature).length;
      if (loopCount >= LOOP_THRESHOLD) {
        const warning = `Loop detected: you have called ${tc.function.name} with the same arguments multiple times in a row. Consider a different approach.`;
        const loopResult: ToolResult = {
          tool_call_id: tc.id,
          name: tc.function.name,
          content: warning,
          ok: false,
        };
        toolResults.push(loopResult);
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: sanitizeString(warning),
          name: tc.function.name,
        });
        opts.callbacks.onToolResult?.(loopResult);
        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
        blockedCount++;
        continue;
      }

      // Web-fetch spiral guardrail
      if (tc.function.name === "web_fetch") {
        const args = JSON.parse(tc.function.arguments || "{}") as { url?: string };
        const url = args.url || "";
        try {
          const domain = new URL(url).hostname;
          const domainCount = webFetchHistory.filter((h) => h.domain === domain).length;
          const totalSessionFetches = webFetchHistory.length;

          if (webFetchesThisTurn >= MAX_WEB_FETCH_PER_TURN) {
            const warning = `Research budget exceeded: you have already made ${MAX_WEB_FETCH_PER_TURN} web requests this turn. Synthesize what you have learned instead of fetching more pages.`;
            const budgetResult: ToolResult = {
              tool_call_id: tc.id,
              name: "web_fetch",
              content: warning,
              ok: false,
            };
            toolResults.push(budgetResult);
            opts.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: sanitizeString(warning),
              name: "web_fetch",
            });
            opts.callbacks.onToolResult?.(budgetResult);
            recentToolCalls.push(loopSignature);
            if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
            blockedCount++;
            continue;
          }

          if (totalSessionFetches >= SESSION_WEB_FETCH_CAP) {
            const warning = `Session research budget exceeded: ${totalSessionFetches} web fetches across this session. Synthesize what you have learned from prior fetches instead of starting another page.`;
            const sessionCapResult: ToolResult = {
              tool_call_id: tc.id,
              name: "web_fetch",
              content: warning,
              ok: false,
            };
            toolResults.push(sessionCapResult);
            opts.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: sanitizeString(warning),
              name: "web_fetch",
            });
            opts.callbacks.onToolResult?.(sessionCapResult);
            recentToolCalls.push(loopSignature);
            if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
            blockedCount++;
            continue;
          }

          if (domainCount >= WEB_FETCH_DOMAIN_THRESHOLD) {
            const warning = `Loop detected: you have fetched from ${domain} multiple times. Consider a different approach or synthesize existing findings.`;
            const loopResult: ToolResult = {
              tool_call_id: tc.id,
              name: "web_fetch",
              content: warning,
              ok: false,
            };
            toolResults.push(loopResult);
            opts.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: sanitizeString(warning),
              name: "web_fetch",
            });
            opts.callbacks.onToolResult?.(loopResult);
            recentToolCalls.push(loopSignature);
            if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
            blockedCount++;
            continue;
          }

          webFetchHistory.push({ url, domain });
          webFetchesThisTurn++;
        } catch {
          // Invalid URL, let it fail normally
        }
      }

      if (codeMode && tc.function.name === "execute_code") {
        const args = JSON.parse(tc.function.arguments || "{}") as { code?: string; reasoning?: string };
        const code = args.code || "";

        const sandboxResult = await runInSandbox({
          code,
          tools: opts.tools,
          executor: opts.executor,
          askPermission: opts.callbacks.askPermission,
          ctx: { cwd: opts.cwd, signal: opts.signal, onTasks: wrappedOnTasks, onPlanOptions: opts.callbacks.onPlanOptions, coauthor: opts.coauthor, memoryManager: opts.memoryManager, sessionId: opts.sessionId, githubToken: opts.githubToken },
          timeoutMs: 30000,
          memoryLimitMB: 128,
        });

        // Emit individual tool results from inside the script
        for (const stc of sandboxResult.toolCalls) {
          const toolResult: ToolResult = {
            tool_call_id: tc.id,
            name: stc.name,
            content: stc.result,
            ok: true,
          };
          toolResults.push(toolResult);
          opts.callbacks.onToolResult?.(toolResult);
        }

        // Surface sandbox warnings (e.g. isolated-vm fallback) as a separate UI notice
        if (sandboxResult.warnings && sandboxResult.warnings.length > 0) {
          for (const w of sandboxResult.warnings) {
            opts.callbacks.onWarning?.(w);
          }
        }

        let resultContent = sandboxResult.error
          ? `Error: ${sandboxResult.error}\n\nOutput:\n${sandboxResult.output}`
          : sandboxResult.output;
        if (resultContent.length > MAX_TOOL_CONTENT_CHARS) {
          const rawBytes = resultContent.length;
          resultContent =
            resultContent.slice(0, MAX_TOOL_CONTENT_CHARS) +
            `\n\n[truncated: ${rawBytes - MAX_TOOL_CONTENT_CHARS} chars omitted]`;
          opts.callbacks.onTruncation?.({
            tool: "execute_code",
            toolCallId: tc.id,
            rawBytes,
            reducedBytes: resultContent.length,
          });
        }

        const result: ToolResult = {
          tool_call_id: tc.id,
          name: "execute_code",
          content: resultContent,
          ok: !sandboxResult.error,
        };
        toolResults.push(result);
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: sanitizeString(resultContent),
          name: "execute_code",
        });
        opts.callbacks.onToolResult?.(result);
        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
      } else if (codeMode && CODE_MODE_REDIRECT_TOOLS.has(tc.function.name) && codeModeRedirects < MAX_CODE_MODE_REDIRECTS) {
        // Redirect a direct context-heavy IO call back into execute_code.
        codeModeRedirects++;
        const msg = codeModeRedirectMessage(tc.function.name);
        const redirectResult: ToolResult = { tool_call_id: tc.id, name: tc.function.name, content: msg, ok: false };
        toolResults.push(redirectResult);
        opts.messages.push({ role: "tool", tool_call_id: tc.id, content: msg, name: tc.function.name });
        opts.callbacks.onToolResult?.(redirectResult);
      } else {
        opts.callbacks.onToolWillExecute?.(tc.id, tc.function.name);
        logger.debug("turn:tool_start", { sessionId: opts.sessionId, tool: tc.function.name, toolCallId: tc.id });

        // M6.1: PreToolUse / PostToolUse fire inside `executor.run`
        // (see src/tools/executor.ts). The executor owns them so every
        // caller — standard loop, code-mode sandbox, init turn, SDK,
        // CLI print mode — gets the same behavior automatically.
        // A vetoed PreToolUse returns a synthetic policy_rejection
        // ToolResult; the loop treats it the same as any other failed
        // call (pushes the rejection text as a tool message so the
        // model sees the reason).
        const result = await opts.executor.run(
          { id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
          opts.callbacks.askPermission,
          {
            cwd: opts.cwd,
            signal: opts.signal,
            onTasks: wrappedOnTasks,
            onPlanOptions: opts.callbacks.onPlanOptions,
            coauthor: opts.coauthor,
            memoryManager: opts.memoryManager,
            sessionId: opts.sessionId,
            githubToken: opts.githubToken,
            shell: opts.shell,
            intentTier: opts.intentClassification?.tier,
            llmAuth: llmAuthOf(opts),
            model: opts.model,
            allowDirectPush: opts.allowDirectPush,
          },
          opts.onFileChange,
        );
        if (!result.ok && result.errorCode === "policy_rejection") {
          logger.warn("hook:vetoed_tool_call", {
            sessionId: opts.sessionId,
            tool: tc.function.name,
            toolCallId: tc.id,
          });
        }
        let content = result.content;
        if (content.length > MAX_TOOL_CONTENT_CHARS) {
          const rawBytes = content.length;
          content =
            content.slice(0, MAX_TOOL_CONTENT_CHARS) +
            `\n\n[truncated: ${rawBytes - MAX_TOOL_CONTENT_CHARS} chars omitted]`;
          opts.callbacks.onTruncation?.({
            tool: tc.function.name,
            toolCallId: tc.id,
            rawBytes,
            reducedBytes: content.length,
            artifactId: result.artifactId,
          });
        }
        logger.debug("turn:tool_end", { sessionId: opts.sessionId, tool: tc.function.name, toolCallId: tc.id, ok: result.ok });
        if (!result.ok && result.errorCode) {
          // M2.1: surface the classified failure mode in the structured
          // log so the M5.1 + M5.2 sinks can answer "which tools fail
          // most, and how?" without parsing message strings.
          logger.warn("tool:error_classified", {
            sessionId: opts.sessionId,
            tool: tc.function.name,
            toolCallId: tc.id,
            code: result.errorCode,
            recoverable: result.recoverable,
          });
        }
        toolResults.push(result);
        opts.messages.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          content: sanitizeString(content),
          name: result.name,
        });
        opts.callbacks.onToolResult?.(result);

        // Auto-extract memories from tool results
        if (opts.memoryManager) {
          let filePath: string | undefined;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
            filePath = toolArgs.path as string | undefined;
          } catch {
            // ignore parse errors
          }

          // Find the preceding assistant message for intent context
          const lastAssistant = [...opts.messages].reverse().find(
            (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
          );
          const assistantMessage = lastAssistant?.content ?? "";

          const llmOpts = opts.memoryManager.getExtractionLlmOpts();

          // Capture turn at IIFE creation so the sliding-window drift
          // detector below is anchored to when the memory was extracted,
          // not whatever value `turn` has when the await chain settles.
          const turnAtMemoryCommit = turn;
          for (const extractor of EXTRACTORS) {
            if (extractor.match(tc.function.name, filePath)) {
              void (async () => {
                try {
                  const memory = await extractor.extract(result.content, filePath, {
                    toolArgs: { ...toolArgs, _toolName: tc.function.name },
                    assistantMessage: typeof assistantMessage === "string" ? assistantMessage : "",
                    llmOpts: {
                      ...llmOpts,
                      signal: opts.signal,
                    },
                  });
                  if (memory) {
                    await opts.memoryManager!.remember(
                      memory.content,
                      memory.category,
                      memory.importance,
                      opts.cwd,
                      opts.sessionId ?? "unknown",
                      opts.signal,
                      undefined,
                      memory.topicKey,
                    );

                    // Real-time drift detection — sliding window:
                    // fire `onKimiMdStale` when >=DRIFT_THRESHOLD high-signal
                    // memories land within DRIFT_WINDOW turns. Clustered
                    // changes = drift; spread-out changes = incremental work
                    // and aren't worth nagging about. (RF-2 / OP-8.)
                    if (isHighSignalMemory(memory)) {
                      const sid = opts.sessionId ?? "default";
                      const events = driftEvents.get(sid) ?? [];
                      events.push(turnAtMemoryCommit);
                      const cutoff = turnAtMemoryCommit - DRIFT_WINDOW + 1;
                      const recent = events.filter((t) => t >= cutoff);
                      driftEvents.set(sid, recent);
                      if (recent.length >= DRIFT_THRESHOLD) {
                        // Wrapped defensively: a throwing callback inside
                        // this fire-and-forget IIFE would become an
                        // unhandled rejection (process-fatal under Node's
                        // default --unhandled-rejections=throw).
                        try {
                          opts.callbacks.onKimiMdStale?.();
                        } catch (cbErr) {
                          logger.debug("memory:onKimiMdStale_threw", {
                            sessionId: opts.sessionId,
                            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                          });
                        }
                        driftEvents.set(sid, []);
                      }
                    }
                  }
                } catch (err) {
                  // Auto-extraction must never break the turn, but a silent
                  // swallow hides systemic failures (bad embedding endpoint,
                  // DB lock, schema mismatch). Track per session and surface
                  // through onWarning so /memory health (and SDK consumers)
                  // can see something is wrong.
                  const sid = opts.sessionId ?? "default";
                  const next = (memoryExtractionErrorCounts.get(sid) ?? 0) + 1;
                  memoryExtractionErrorCounts.set(sid, next);
                  const msg = err instanceof Error ? err.message : String(err);
                  logger.debug("memory:extract_error", {
                    sessionId: opts.sessionId,
                    tool: tc.function.name,
                    count: next,
                    error: msg,
                  });
                  // Only emit the user-visible warning on the first failure
                  // per session — repeated errors stay in the counter.
                  // Wrapped defensively for the same reason as the
                  // onKimiMdStale fire above.
                  if (next === 1) {
                    try {
                      opts.callbacks.onWarning?.(
                        `[memory] auto-extraction failed (${msg}). Subsequent failures will be counted silently; check /memory health.`,
                      );
                    } catch (cbErr) {
                      logger.debug("memory:onWarning_threw", {
                        sessionId: opts.sessionId,
                        error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                      });
                    }
                  }
                }
              })();
            }
          }
        }

        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
      }

      // Heuristic auto-advance: if the model has executed multiple mutating
      // tools without calling tasks_set, nudge the task list forward so the
      // UI stays honest. We only do this when tasks_set is not coming later
      // in the same batch of tool calls.
      if (MUTATING_TOOLS.has(tc.function.name)) {
        mutatingToolsSinceLastTasksSet++;
        const hasTasksSetComing = toolCalls.slice(i + 1).some((t) => t.function.name === "tasks_set");
        if (!hasTasksSetComing && mutatingToolsSinceLastTasksSet >= AUTO_ADVANCE_THRESHOLD) {
          const inProgressIdx = currentTasks.findIndex((t) => t.status === "in_progress");
          const nextPendingIdx = currentTasks.findIndex((t) => t.status === "pending");
          if (inProgressIdx !== -1 && nextPendingIdx !== -1) {
            const updated = currentTasks.map((t, idx) => {
              if (idx === inProgressIdx) return { ...t, status: "completed" as const };
              if (idx === nextPendingIdx) return { ...t, status: "in_progress" as const };
              return t;
            });
            currentTasks = updated;
            mutatingToolsSinceLastTasksSet = 0;
            wrappedOnTasks(updated);
          }
        }
      }
    }
    }

    if (blockedCount === toolCalls.length && toolCalls.length > 0) {
      loopExhausted = true;
    }

    // (Drift accumulator decay was removed in OP-8 — drift detection is
    // now a sliding window over recent turns, not a decaying counter.)

    // Allow external compaction / state management between iterations
    if (opts.onIterationEnd) {
      opts.messages = await opts.onIterationEnd(opts.messages, opts.signal);
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
    }

    if (opts.sessionId && lastUsage) {
      void logTurnDebug({
        sessionId: opts.sessionId,
        turn,
        messages: opts.messages,
        previousMessages,
        toolResults,
        usage: lastUsage,
        shadowStrip: shadowStripMetrics,
        durationMs: Math.round(performance.now() - turnStart),
        intentClassification: opts.intentClassification,
        codeMode: opts.codeMode,
        selectedSkills: opts.selectedSkills,
        userPromptPreview,
        preTurnMs,
        memoryRecalled: memoryRecalledCount > 0,
      });
    }

    if (budgetExhausted) {
      throw new BudgetExhaustedError();
    }
    if (loopExhausted) {
      if (opts.callbacks.onLoopDetected) {
        const decision = await opts.callbacks.onLoopDetected();
        if (decision === "continue") {
          opts.messages.push({
            role: "system",
            content:
              "You were stuck calling the same tools with identical arguments. " +
              "The guardrail has been reset so you can continue. Try a different approach.",
          });
          loopExhausted = false;
          recentToolCalls.length = 0;
          continue;
        }
        if (decision === "synthesize") {
          opts.messages.push({
            role: "system",
            content:
              "You were stuck calling the same tools with identical arguments. " +
              "Please synthesize and conclude your findings so far. Do not call any more tools.",
          });
          loopExhausted = false;
          recentToolCalls.length = 0;
          continue;
        }
        await fireStopHook();
        return;
      }
      throw new AgentLoopError();
    }
  }
}

function validateToolArguments(raw: string): string {
  if (!raw || !raw.trim()) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

/** The credential subset of turn opts, for side-calls made on the turn's behalf. */
function llmAuthOf(opts: LlmAuth): LlmAuth {
  return {
    ...(opts.openrouterApiKey ? { openrouterApiKey: opts.openrouterApiKey } : {}),
    ...(opts.customEndpoint ? { customEndpoint: opts.customEndpoint } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
}
