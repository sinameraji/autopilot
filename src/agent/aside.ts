import { runKimi } from "./client.js";
import type { LlmAuth } from "./llm-auth.js";
import type { ChatMessage } from "./messages.js";

export interface AsideContext {
  currentTask: string;
  /** Task list / current step, if any. */
  progress?: string;
  /** The assistant's most recent visible text. */
  recentAssistantText?: string;
  /** Tools running right now, subagents included. */
  activity?: string;
}

/**
 * Answer a progress question ("how's it going?") from the current turn's
 * state with a small side request. The answer is shown to the user only;
 * it never enters the conversation history or disturbs the running turn.
 */
export async function answerAside(
  question: string,
  context: AsideContext,
  opts: LlmAuth & { model: string; signal?: AbortSignal },
): Promise<string> {
  const clip = (text: string | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You report on a coding agent's progress. Answer the user's question in one to three short sentences using only the state below. If the state doesn't say, say so. Do not invent progress.",
    },
    {
      role: "user",
      content: [
        `Task: ${clip(context.currentTask, 600)}`,
        context.progress ? `Progress: ${clip(context.progress, 600)}` : "",
        context.activity ? `Running now: ${clip(context.activity, 300)}` : "",
        context.recentAssistantText ? `Latest agent message: ${clip(context.recentAssistantText, 800)}` : "",
        `Question: ${clip(question, 400)}`,
      ].filter(Boolean).join("\n"),
    },
  ];
  let text = "";
  for await (const ev of runKimi({ ...opts, messages, maxCompletionTokens: 300, reasoningEffort: "low", signal: opts.signal })) {
    if (ev.type === "text") text += ev.delta;
  }
  return text.trim() || "No answer available from the current state.";
}
