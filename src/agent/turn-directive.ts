import type { ChatMessage } from "./messages.js";

const HEADING = "## Subagent policy for this turn";

/** Matches a delegation block that older versions baked into the persisted
 *  system prompt: from the heading to the next `## ` section or the end. */
const PERSISTED_BLOCK = /\n*## Subagent policy for this turn\n[\s\S]*?(?=\n## |$)/;

/**
 * Build the messages actually sent to the model for one request, adding the
 * per-turn delegation directive as a transient system message.
 *
 * The directive is never written into `opts.messages` or the system prompt:
 * it applies to this turn only, must reach the model whether or not skill
 * routing rebuilt the prompt, and must not leak into later turns whose
 * guidance differs. It is placed right after the user message that started
 * the turn so the prompt prefix (system messages, earlier history) stays
 * byte-stable for caching.
 *
 * Stale blocks persisted by older versions are stripped from system messages.
 */
export function withTurnDirective(
  messages: ChatMessage[],
  directive: string | undefined,
  turnUserMessage: ChatMessage | undefined,
): ChatMessage[] {
  let out = messages;
  if (messages.some(hasPersistedBlock)) {
    out = messages.map((m) =>
      hasPersistedBlock(m) ? { ...m, content: (m.content as string).replace(PERSISTED_BLOCK, "") } : m,
    );
  }
  if (!directive) return out;

  let anchor = turnUserMessage ? out.indexOf(turnUserMessage) : -1;
  if (anchor === -1) {
    // The anchor was replaced (e.g. by compaction) or not supplied: fall back
    // to the latest user message.
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.role === "user") {
        anchor = i;
        break;
      }
    }
  }
  const directiveMessage: ChatMessage = { role: "system", content: `${HEADING}\n\n${directive}` };
  const insertAt = anchor === -1 ? out.length : anchor + 1;
  return [...out.slice(0, insertAt), directiveMessage, ...out.slice(insertAt)];
}

function hasPersistedBlock(m: ChatMessage): boolean {
  return m.role === "system" && typeof m.content === "string" && m.content.includes(HEADING);
}
