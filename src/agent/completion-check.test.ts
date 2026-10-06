import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completionCheckFromConfig, createJevCompletionCheck, shouldCheckCompletion, toolsUsedSince } from "./completion-check.js";
import type { JevQuestion } from "./jev.js";
import type { ChatMessage } from "./messages.js";

const input = { userRequest: "Implement the feature", finalText: "I reviewed the code. Next I'll implement it.", toolsUsed: ["read", "grep"] };

describe("completion check", () => {
  it("only checks substantial turns that didn't end by asking the user", () => {
    assert.equal(shouldCheckCompletion(input, "medium"), true);
    assert.equal(shouldCheckCompletion(input, "light"), false);
    assert.equal(shouldCheckCompletion({ ...input, finalText: "Should I use Postgres or SQLite?" }, "heavy"), false);
    assert.equal(shouldCheckCompletion({ ...input, finalText: "  " }, "heavy"), false);
  });

  it("asks Jev a yes/no question with the request, tool summary, and final message (redacted)", async () => {
    let asked: JevQuestion | undefined;
    const check = createJevCompletionCheck("k", async (_key, q) => {
      asked = q;
      return { type: "noul", noul: 0.03 };
    });
    const p = await check({ ...input, userRequest: "deploy with API_KEY=sk-or-v1-abcdefghijk" }, new AbortController().signal);
    assert.equal(p, 0.03);
    assert.equal(asked?.kind, "yes");
    assert.match(asked!.prompt, /stopping early, only planning, or announcing next steps/);
    assert.match(asked!.prompt, /clearly explaining a blocker or question that needs the user/);
    assert.match(asked!.prompt, /2 tool calls \(read, grep\); it only read or searched/);
    assert.match(asked!.prompt, /Next I'll implement it/);
    assert.doesNotMatch(asked!.prompt, /sk-or-v1-abcdefghijk/);
  });

  it("returns null when Jev fails or answers in the wrong shape", async () => {
    assert.equal(await createJevCompletionCheck("k", async () => { throw new Error("down"); })(input, new AbortController().signal), null);
    assert.equal(await createJevCompletionCheck("k", async () => ({ type: "choice", probabilities: {} }))(input, new AbortController().signal), null);
  });

  it("is off without OpenRouter, with a custom endpoint, or when disabled", () => {
    assert.equal(completionCheckFromConfig({}), undefined);
    assert.equal(completionCheckFromConfig({ openrouterApiKey: "k", baseUrl: "https://x" }), undefined);
    assert.equal(completionCheckFromConfig({ openrouterApiKey: "k", completionCheck: false }), undefined);
    assert.equal(typeof completionCheckFromConfig({ openrouterApiKey: "k" }), "function");
  });

  it("lists the tools used since the turn's request", () => {
    const user: ChatMessage = { role: "user", content: "go" };
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "0", type: "function", function: { name: "old", arguments: "{}" } }] },
      user,
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }, { id: "2", type: "function", function: { name: "edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "x" },
    ];
    assert.deepEqual(toolsUsedSince(messages, user), ["read", "edit"]);
  });
});
