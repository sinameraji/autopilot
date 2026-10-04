import { askJev, type AskJevOptions, type JevAnswer, type JevQuestion } from "./jev.js";

/**
 * Triage for user messages that arrive while the agent is working (#725).
 *
 *  interrupt  — the current work is wrong or should stop now
 *  steer      — amends the current task; delivered at the next tool boundary
 *  queue      — separate work; runs as its own turn afterwards
 *  aside      — a question about progress; answered without disturbing the turn
 *
 * Deterministic rules decide clear cases; a small typed model call (Jev)
 * handles ambiguous ones. Anything uncertain is queued — the user can
 * promote it with the "run now" shortcut.
 */
export type TriageKind = "interrupt" | "steer" | "queue" | "aside";

export interface TriageResult {
  kind: TriageKind;
  /** Where the decision came from. `default` means "unsure → queue". */
  source: "rule" | "model" | "default";
  reason: string;
  confidence?: number;
}

export interface TriageContext {
  /** The request the agent is currently working on. */
  currentTask: string;
  /** Short description of what it is doing right now (task list item, tool). */
  activity?: string;
}

const INTERRUPT = /^(?:stop\b|wait(?!\s+(?:until|till|for|to)\b)\b|hold on|hang on|halt\b|abort\b|cancel (?:that|this|it)\b|no(?:[,.!]|\s*$)|nope\b|wrong\b|that'?s (?:wrong|not (?:right|it|what i (?:want|meant|asked)))|don'?t (?:do|touch|change|edit|delete|push|commit)|do not (?:do|touch|change|edit|delete|push|commit))/i;
const STEER = /^(?:also\b|and also\b|plus\b|additionally\b|make sure\b|don'?t forget\b|remember to\b|keep in mind\b|note that\b|fyi\b|btw\b|use [^.?!]{1,60} instead\b|instead\b|actually\b|prefer\b|only\b|skip\b|ignore\b)/i;
const QUEUE = /^(?:after (?:this|that|you'?re done|you finish)|when you'?re done|once (?:you'?re )?(?:done|finished)|later\b|next(?: up)?[,:]|then[,:]|separately\b|new task\b|another (?:thing|task)\b|unrelated\b)/i;
const ASIDE = /^(?:how(?:'?s| is) it going|how far along|status\??$|what(?:'?s| is) (?:the )?status|what are you (?:doing|working on)|where are you (?:at|up to)|eta\b|are you (?:stuck|done|still)\b|still working\b)/i;

const OPTIONS = ["interrupt", "steer", "queue", "aside"] as const;
/** Minimum model probability to act on anything but "queue". */
export const TRIAGE_CONFIDENCE = 0.6;
const TRIAGE_TIMEOUT_MS = 3_000;
const MAX_CHARS = 600;

/** Clear cases only; returns null when a rule can't decide. */
export function triageByRules(text: string): TriageResult | null {
  const t = text.trim();
  if (t.startsWith("/") || t.startsWith("!")) return { kind: "queue", source: "rule", reason: "commands run in order" };
  if (INTERRUPT.test(t)) return { kind: "interrupt", source: "rule", reason: "asks to stop or says the current work is wrong" };
  if (QUEUE.test(t)) return { kind: "queue", source: "rule", reason: "asks for this after the current work" };
  if (ASIDE.test(t)) return { kind: "aside", source: "rule", reason: "asks about progress" };
  if (STEER.test(t)) return { kind: "steer", source: "rule", reason: "amends the current task" };
  return null;
}

export interface TriageOptions {
  apiKey?: string;
  /** Jev runs through OpenRouter only. */
  customEndpoint?: boolean;
  signal?: AbortSignal;
  ask?: (apiKey: string, question: JevQuestion, options?: AskJevOptions) => Promise<JevAnswer>;
}

export async function triageIncoming(text: string, context: TriageContext, opts: TriageOptions = {}): Promise<TriageResult> {
  const byRule = triageByRules(text);
  if (byRule) return byRule;
  if (!opts.apiKey || opts.customEndpoint) return unsure("no triage model for this provider");

  const question: JevQuestion = {
    kind: "choose",
    prompt: [
      "A coding agent is in the middle of a task. The user just sent a new message. Decide how to handle it:",
      "interrupt = the current work is wrong or should stop right now;",
      "steer = it adjusts or adds to the current task and should be folded in at the next step;",
      "queue = it is separate work that should run after the current task;",
      "aside = it is a question about progress that can be answered without changing the work.",
      `Current task: ${clip(context.currentTask)}`,
      context.activity ? `Doing now: ${clip(context.activity, 200)}` : "",
      `New message: ${clip(text)}`,
    ].filter(Boolean).join("\n"),
    options: [...OPTIONS],
  };
  const timeout = AbortSignal.timeout(TRIAGE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  try {
    const answer = await (opts.ask ?? askJev)(opts.apiKey, question, { signal });
    const probabilities = answer.type === "choice" ? answer.probabilities : undefined;
    if (!probabilities) return unsure("triage model gave no probabilities");
    let best: TriageKind = "queue";
    let bestP = -1;
    for (const kind of OPTIONS) {
      const p = probabilities[kind];
      if (typeof p === "number" && p > bestP) {
        best = kind;
        bestP = p;
      }
    }
    if (best !== "queue" && bestP < TRIAGE_CONFIDENCE) return unsure(`model leaned ${best} at ${Math.round(bestP * 100)}%`, bestP);
    return { kind: best, source: "model", reason: `model chose ${best}`, confidence: bestP };
  } catch {
    return unsure("triage model unavailable");
  }
}

function unsure(reason: string, confidence?: number): TriageResult {
  return { kind: "queue", source: "default", reason, ...(confidence === undefined ? {} : { confidence }) };
}

function clip(text: string, max = MAX_CHARS): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** User message text for a steer, so the model knows it arrived mid-task. */
export function steerMessage(text: string, promoted = false): string {
  return promoted
    ? `[The user asked to handle this before continuing with the current work]\n${text}`
    : `[Message from the user while you were working — fold it into the current task]\n${text}`;
}

export type TriageAction =
  /** Turn already ended, or triage said queue: leave it in the queue. */
  | { do: "keep-queued"; note?: string }
  | { do: "aside" }
  /** Move to the front of the queue and stop the turn at the next safe point. */
  | { do: "interrupt"; note: string }
  /** Deliver into the running turn at its next step. */
  | { do: "steer"; urgent: boolean; note: string };

/**
 * What a triage result means right now. Interrupts never cancel subagents:
 * while any run, an interrupt becomes an urgent steer delivered when the
 * current step (the workers) finishes.
 */
export function planTriageAction(
  result: TriageResult,
  state: { busy: boolean; subagentsRunning: boolean; promoted?: boolean },
): TriageAction {
  if (!state.busy) return { do: "keep-queued" };
  if (state.promoted) {
    return { do: "steer", urgent: true, note: "running this first — delivered to the agent at its next step" };
  }
  switch (result.kind) {
    case "queue":
      return { do: "keep-queued", note: result.source === "default" ? "queued (unsure)" : "queued" };
    case "aside":
      return { do: "aside" };
    case "interrupt":
      return state.subagentsRunning
        ? {
            do: "steer",
            urgent: true,
            note: "subagents are still running, so this will reach the agent when they finish (/subagents cancel <n> to stop them sooner)",
          }
        : { do: "interrupt", note: `interrupting to handle this now (${result.reason})` };
    case "steer":
      return { do: "steer", urgent: false, note: `steering the current task — delivered at the agent's next step (${result.reason})` };
  }
}
