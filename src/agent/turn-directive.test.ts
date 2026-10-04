import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTurnDirective } from "./turn-directive.js";
import type { ChatMessage } from "./messages.js";

describe("withTurnDirective", () => {
  it("inserts the directive after the turn's user message without mutating history", () => {
    const user: ChatMessage = { role: "user", content: "research X and Y" };
    const history: ChatMessage[] = [
      { role: "system", content: "base" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "ok" },
      user,
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "file" },
    ];
    const snapshot = JSON.stringify(history);
    const sent = withTurnDirective(history, "Delegate independent work.", user);
    assert.equal(JSON.stringify(history), snapshot, "history is untouched");
    assert.equal(sent.length, history.length + 1);
    assert.equal(sent[4]!.role, "system");
    assert.match(String(sent[4]!.content), /Subagent policy for this turn\n\nDelegate independent work\./);
    assert.equal(sent[5], history[4], "tool-call pairing after the directive is preserved");
  });

  it("falls back to the latest user message when the anchor is gone", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "base" },
      { role: "user", content: "compacted turn" },
    ];
    const sent = withTurnDirective(history, "Do not call spawn_worker.", { role: "user", content: "replaced" });
    assert.equal(sent.at(-1)!.role, "system");
  });

  it("strips delegation blocks persisted by older versions, with or without a directive", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "base\n\n## Mode\n\nedit\n\n## Subagent policy for this turn\n\nUse spawn_worker in parallel." },
      { role: "user", content: "hi" },
    ];
    const none = withTurnDirective(history, undefined, history[1]);
    assert.equal(none[0]!.content, "base\n\n## Mode\n\nedit");
    assert.equal(none.length, 2);
    assert.match(String(history[0]!.content), /Use spawn_worker/, "persisted history itself is not rewritten");

    const middle: ChatMessage[] = [
      { role: "system", content: "a\n\n## Subagent policy for this turn\n\nold\n## Skills\n\nkeep" },
      { role: "user", content: "hi" },
    ];
    assert.equal(withTurnDirective(middle, undefined, undefined)[0]!.content, "a\n## Skills\n\nkeep");
  });

  it("returns the same array when there is nothing to do", () => {
    const history: ChatMessage[] = [{ role: "system", content: "base" }, { role: "user", content: "hi" }];
    assert.equal(withTurnDirective(history, undefined, history[1]), history);
  });
});
