import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn } from "./loop.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ChatMessage } from "./messages.js";

describe("runAgentTurn", () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("exits gracefully when signal aborts during streaming", async () => {
    const controller = new AbortController();
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hi" },
    ];

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // Delay data so readSSE is pending when abort fires.
          const t = setTimeout(() => {
            try {
              c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
              c.close();
            } catch {
              /* controller may already be closed */
            }
          }, 200);
          // Clean up timeout if stream is cancelled early.
          controller.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const executor = {
      list: () => [],
      run: async () => {
        throw new Error("should not reach executor");
      },
    } as unknown as ToolExecutor;

    // Abort while the stream is pending.
    setTimeout(() => controller.abort(), 50);

    // Should throw because runAgentTurn checks signal.aborted after streaming.
    await assert.rejects(
      async () => {
        await runAgentTurn({
          openrouterApiKey: "sk-or-test",
          model: "test/model",
          messages,
          tools: [],
          executor,
          cwd: "/tmp",
          signal: controller.signal,
          callbacks: {
            askPermission: async () => "allow",
          },
        });
      },
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );

    // No assistant message should have been appended because abort happened
    // before the stream produced any usable content.
    assert.strictEqual(messages.length, 2);
  });

  it("throws AbortError when signal aborts after streaming but before tool execution", async () => {
    const controller = new AbortController();
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hi" },
    ];

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"read","arguments":""}}]}}]}\n\n',
            ),
          );
          c.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"x\\"}"}}]}}]}\n\n',
            ),
          );
          c.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n'));
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const executor = {
      list: () => [],
      run: async () => {
        throw new Error("should not reach executor");
      },
    } as unknown as ToolExecutor;

    await assert.rejects(
      async () => {
        await runAgentTurn({
          openrouterApiKey: "sk-or-test",
          model: "test/model",
          messages,
          tools: [],
          executor,
          cwd: "/tmp",
          signal: controller.signal,
          callbacks: {
            // Abort as soon as the assistant message is finalized (after streaming,
            // before tool execution starts).
            onAssistantFinal: () => {
              controller.abort();
            },
            askPermission: async () => "allow",
          },
        });
      },
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );

    // Assistant message should have been appended during streaming.
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[2]!.role, "assistant");
    assert.ok(Array.isArray(messages[2]!.tool_calls));
    assert.strictEqual(messages[2]!.tool_calls!.length, 1);

    // No tool result should have been appended because abort happened before execution.
    assert.strictEqual(messages.filter((m) => m.role === "tool").length, 0);
  });
});
