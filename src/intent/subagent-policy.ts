import { askJev, JEV_TIMEOUT_MS, type JevAnswer, type JevQuestion, type AskJevOptions } from "../agent/jev.js";

export type SubagentPolicy = "off" | "suggest" | "auto";
export type SubagentGuidanceKind = "none" | "explicit-delegate" | "explicit-sequential" | "suggest" | "auto-delegate";

export interface SubagentGuidance {
  kind: SubagentGuidanceKind;
  reason: string;
  probability?: number;
  directive?: string;
}

export function allowsSubagentDispatch(kind: SubagentGuidanceKind): boolean {
  return kind === "explicit-delegate" || kind === "suggest" || kind === "auto-delegate";
}

export interface ResolveSubagentGuidanceOptions {
  prompt: string;
  tier: "light" | "medium" | "heavy";
  policy: SubagentPolicy;
  apiKey?: string;
  customEndpoint?: boolean;
  signal?: AbortSignal;
  ask?: (apiKey: string, question: JevQuestion, options?: AskJevOptions) => Promise<JevAnswer>;
}

const EXPLICIT_NO = /\b(?:do\s+not|don't|dont|never|avoid|without|no)\s+(?:(?:(?:want\s+to\s+)?(?:use|using|spawn|call|ask|start|launch|skip))\s+)?(?:(?:any|the|a)\s+)?(?:sub[- ]?agents?|agents?|workers?)\b|\b(?:do\s+not|don't|dont|never|avoid|without|no)\s+delegat(?:e|ion|ing)\b|\bwork\s+sequentially\b/i;
const EXPLICIT_YES = /\b(?:use|spawn|call|start|launch|ask|send|delegate\s+to)\s+(?:(?:some|several|multiple|parallel)\s+)?(?:sub[- ]?agents?|agents?|workers?)\b|\b(?:parallelize|split)\b.{0,50}\b(?:agents?|workers?|subtasks?)\b/i;
const SEQUENTIAL_DEPENDENCY = /\b(?:one\s+at\s+a\s+time|sequentially|in\s+sequence|in\s+dependency\s+order|tightly\s+coupled|same\s+(?:file|function|module)|first\b.{0,80}\bbefore\b|before\b.{0,80}\bthen\b|step[- ]by[- ]step)\b/i;
const CLEAR_PARALLEL = /\b(?:independent\s+(?:research|tasks?|questions?|work)|in\s+parallel|parallel\s+agents?|separately\s+investigate)\b/i;
const AMBIGUOUS_CANDIDATE = /\b(?:research|investigat\w*|audit|compare|contrast|review|comprehensive|across\s+(?:the\s+)?(?:codebase|repo|repository)|entire\s+(?:codebase|repo|repository)|multiple\s+(?:systems|modules|approaches|sources))\b/i;

export const SUBAGENT_JEV_TIMEOUT_MS = Math.min(JEV_TIMEOUT_MS, 4_000);
export const SUBAGENT_JEV_OPTIONS = ["delegate", "sequential"] as const;
const SUGGEST_THRESHOLD = 0.65;
const MAX_JEV_PROMPT_CHARS = 1_200;

function directiveFor(kind: SubagentGuidanceKind): string | undefined {
  if (kind === "explicit-sequential") {
    return "The user explicitly asked not to delegate. Do not call spawn_worker; handle the task in the main session and respect any stated dependencies.";
  }
  if (kind === "explicit-delegate") {
    return "The user explicitly requested subagents. Before acting, split the request into bounded missions that can make progress independently; use spawn_worker in plan mode for useful parallel read-only research, wait for the workers, and synthesize their findings before dependent implementation. Do not delegate tightly coupled or sequential steps. The tool's normal permission prompt and all configured safety limits still apply.";
  }
  if (kind === "suggest") {
    return "The harness sees a possible parallel-work opportunity, but the user did not request delegation. Use spawn_worker only if you can define bounded, independent missions that materially help. The tool's normal permission prompt is the required user confirmation; never assume approval. Keep dependent implementation in the coordinator.";
  }
  if (kind === "auto-delegate") {
    return "Proactive subagent delegation is enabled for this substantial task. First assess its structure, dependencies, and coordination cost. If two or more bounded research tracks can make meaningful progress independently, delegate them with spawn_worker in plan mode in parallel, wait for their results, and synthesize the findings before doing dependent work in the coordinator. Keep trivial, tightly coupled, and sequential work local. Worker calls still require normal permission and local Hotcell with OpenRouter, a clean committed repository, spend, concurrency, timeout, and read-only restrictions; never bypass them. If a worker cannot run or fails, explain that plainly and continue locally without implying delegation succeeded.";
  }
  return undefined;
}

function result(kind: SubagentGuidanceKind, reason: string, probability?: number): SubagentGuidance {
  const directive = directiveFor(kind);
  return {
    kind,
    reason,
    ...(probability === undefined ? {} : { probability }),
    ...(directive ? { directive } : {}),
  };
}

/** Resolve harness guidance without ever launching a worker itself. */
export async function resolveSubagentGuidance(options: ResolveSubagentGuidanceOptions): Promise<SubagentGuidance> {
  const prompt = options.prompt.trim();
  if (EXPLICIT_NO.test(prompt)) return result("explicit-sequential", "explicit user instruction");
  if (EXPLICIT_YES.test(prompt)) return result("explicit-delegate", "explicit user instruction");
  if (options.policy === "off") return result("none", "automatic delegation is off");
  if (SEQUENTIAL_DEPENDENCY.test(prompt)) return result("none", "routine or sequential task");
  if (CLEAR_PARALLEL.test(prompt)) {
    return result(options.policy === "auto" ? "auto-delegate" : "suggest", "independent work is explicit");
  }
  if (options.tier === "light") return result("none", "routine or sequential task");
  // In auto mode the coordinator, which sees the full task and can reason about
  // dependencies, makes the parallelizability decision. Do not require users to
  // name subagents or match a narrow list of research keywords to enable it.
  if (options.policy === "auto") {
    return result("auto-delegate", "substantial task; coordinator assesses independence");
  }
  if (!AMBIGUOUS_CANDIDATE.test(prompt)) return result("none", "no parallel-work signal");
  if (!options.apiKey || options.customEndpoint) return result("none", "Jev is unavailable for this provider configuration");
  if (options.signal?.aborted) return result("none", "turn cancelled before Jev advice");

  const safePrompt = redactPrompt(prompt).slice(0, MAX_JEV_PROMPT_CHARS);
  const question: JevQuestion = {
    kind: "choose",
    prompt: [
      "Choose whether this task benefits from independent subagent research before coordinator synthesis.",
      "Delegate only if useful work can proceed independently; otherwise keep the task sequential.",
      `Task effort: ${options.tier}. User task: ${safePrompt}`,
    ].join("\n"),
    options: [...SUBAGENT_JEV_OPTIONS],
  };
  const ask = options.ask ?? askJev;
  const timeout = AbortSignal.timeout(SUBAGENT_JEV_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const answer = await ask(options.apiKey, question, { signal });
    const probability = answer.type === "choice" ? answer.probabilities?.delegate : undefined;
    if (probability === undefined || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return result("none", "Jev returned no usable delegation probability");
    }
    if (probability >= SUGGEST_THRESHOLD) return result("suggest", "Jev sees a possible parallel-work benefit", probability);
    return result("none", "Jev recommends sequential work", probability);
  } catch {
    // Advice must never block the main turn or turn a transient Jev failure into dispatch.
    return result("none", "Jev unavailable; continue in the main session");
  }
}

function redactPrompt(prompt: string): string {
  return prompt
    .replace(/\b(?:sk-or-v1-|sk-ant-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]");
}
