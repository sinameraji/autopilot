/**
 * Cross-provider smoke tests for runKimi.
 *
 * The Cloudflare AI Gateway Universal Endpoint translates Anthropic / Gemini /
 * Groq / DeepSeek response shapes into OpenAI chat-completions before the bytes
 * reach us — so the parser only needs to handle one shape. These tests pin the
 * three things that actually matter for multi-provider correctness:
 *
 *   1. The OpenAI-shaped stream is parsed correctly when it carries the
 *      reasoning + tool-call shape an Anthropic/OpenAI gateway response uses.
 *   2. BYOK auth-header routing: alias > raw key > unified-billing, with the
 *      right header being sent (and the others omitted) per setting.
 *   3. Workers AI plumbing models route through gateway.ai.cloudflare.com when
 *      a gateway is configured — so memory/extraction/summarization usage
 *      shows up in the AI Gateway dashboard rather than the direct ai/run path.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runKimi, type KimiEvent } from "./client.js";
import { registerOpenRouterModels } from "../models/registry.js";

function sse(...lines: string[]): string {
  return lines.map((l) => `data: ${l}`).join("\n\n") + "\n\n";
}

describe("runKimi: OpenAI-shaped stream from AI Gateway Universal Endpoint", () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses reasoning, text, tool calls, and usage from an Anthropic-via-gateway stream", async () => {
    // Universal Endpoint translates Anthropic's thinking + tool_use blocks into
    // OpenAI-shaped chunks with `reasoning_content` and `tool_calls[*].function`.
    const body = sse(
      JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: "Thinking…" } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "Sure, " } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "running grep." } }],
      }),
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "toolu_01abc",
                  type: "function",
                  function: { name: "shell", arguments: `{"cmd":` },
                },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: `"grep -r foo"}` } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      }),
      "[DONE]",
    );

    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const events: KimiEvent[] = [];
    for await (const ev of runKimi({
      accountId: "a",
      apiToken: "t",
      model: "anthropic/claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      gateway: { id: "gw" },
      providerKeys: { anthropic: "sk-ant-test" },
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e): e is Extract<KimiEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    assert.strictEqual(text, "Sure, running grep.");

    const reasoning = events
      .filter((e): e is Extract<KimiEvent, { type: "reasoning" }> => e.type === "reasoning")
      .map((e) => e.delta)
      .join("");
    assert.strictEqual(reasoning, "Thinking…");

    const completedCall = events.find(
      (e): e is Extract<KimiEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete",
    );
    assert.ok(completedCall, "expected a tool_call_complete event");
    assert.strictEqual(completedCall.name, "shell");
    assert.strictEqual(completedCall.id, "toolu_01abc");
    assert.strictEqual(completedCall.arguments, `{"cmd":"grep -r foo"}`);

    const done = events.find(
      (e): e is Extract<KimiEvent, { type: "done" }> => e.type === "done",
    );
    assert.ok(done);
    assert.strictEqual(done.finishReason, "tool_calls");
    assert.strictEqual(done.usage?.prompt_tokens, 42);
    assert.strictEqual(done.usage?.completion_tokens, 7);
  });
});

describe("runKimi: provider auth-header routing (BYOK alias vs raw key vs unified)", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      lastRequest = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });
  beforeEach(() => {
    lastRequest = null;
  });

  const baseOpts = {
    accountId: "acct",
    apiToken: "cf-token",
    model: "anthropic/claude-haiku-4-5",
    messages: [{ role: "user" as const, content: "hi" }],
    gateway: { id: "gw" },
  };

  it("with providerKeyAliases set: sends cf-aig-byok-alias and omits cf-aig-authorization", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      providerKeyAliases: { anthropic: "kimi-code-anthropic-abc123" },
    })) {
      /* drain */
    }
    assert.ok(lastRequest);
    assert.strictEqual(
      lastRequest!.headers.get("cf-aig-byok-alias"),
      "kimi-code-anthropic-abc123",
    );
    assert.strictEqual(lastRequest!.headers.get("cf-aig-authorization"), null);
  });

  it("alias takes precedence over raw providerKey when both are set", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      providerKeyAliases: { anthropic: "alias-1" },
      providerKeys: { anthropic: "sk-ant-stale" },
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.headers.get("cf-aig-byok-alias"), "alias-1");
    assert.strictEqual(lastRequest!.headers.get("cf-aig-authorization"), null);
  });

  it("with only providerKeys set: sends cf-aig-authorization with raw key (local-fallback path)", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      providerKeys: { anthropic: "sk-ant-local" },
    })) {
      /* drain */
    }
    assert.strictEqual(
      lastRequest!.headers.get("cf-aig-authorization"),
      "Bearer sk-ant-local",
    );
    assert.strictEqual(lastRequest!.headers.get("cf-aig-byok-alias"), null);
  });

  it("with unifiedBilling=true: sends neither byok header (CF pays via credits)", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      unifiedBilling: true,
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.headers.get("cf-aig-byok-alias"), null);
    assert.strictEqual(lastRequest!.headers.get("cf-aig-authorization"), null);
    // gateway-level auth still rides on Authorization
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer cf-token");
  });

  it("unifiedBilling wins even if a raw key is present (user opted into CF billing)", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      unifiedBilling: true,
      providerKeys: { anthropic: "sk-ant-ignored" },
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.headers.get("cf-aig-authorization"), null);
    assert.strictEqual(lastRequest!.headers.get("cf-aig-byok-alias"), null);
  });

  it("Moonshot K3: routes to Cloudflare's unified REST API with the gateway id header, no provider key", async () => {
    // Verified live 2026-08-19: moonshotai/kimi-k3 is a Cloudflare-catalog
    // model paid from AI Gateway credits (Unified Billing). It is reached via
    // api.cloudflare.com/.../ai/v1/chat/completions, not the gateway host, and
    // BYOK is not supported on that path — so no cf-aig-authorization / alias
    // headers even if the user has a Moonshot key lying around.
    for await (const _ of runKimi({
      ...baseOpts,
      model: "moonshotai/kimi-k3",
      providerKeys: { moonshotai: "sk-moonshot-test" },
      gateway: { id: "gw", cacheTtl: 60 },
    })) {
      /* drain */
    }
    assert.strictEqual(
      lastRequest!.url,
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
    );
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer cf-token");
    assert.strictEqual(lastRequest!.headers.get("cf-aig-gateway-id"), "gw");
    assert.strictEqual(lastRequest!.headers.get("cf-aig-cache-ttl"), "60");
    assert.strictEqual(lastRequest!.headers.get("cf-aig-authorization"), null);
    assert.strictEqual(lastRequest!.headers.get("cf-aig-byok-alias"), null);
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.strictEqual(body.model, "moonshotai/kimi-k3");
    // K3 fixes temperature=1.0 and 400s on anything else — must be omitted.
    assert.strictEqual("temperature" in body, false);
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
  });

  it("Moonshot K3: works without a configured gateway (Cloudflare uses the default gateway)", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      model: "moonshotai/kimi-k3",
      gateway: undefined,
    })) {
      /* drain */
    }
    assert.strictEqual(
      lastRequest!.url,
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
    );
    assert.strictEqual(lastRequest!.headers.get("cf-aig-gateway-id"), null);
  });
});

describe("runKimi: Workers AI plumbing routes through gateway when configured", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      lastRequest = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("routes @cf/* models through the Universal Endpoint with a workers-ai/ model prefix", async () => {
    for await (const _ of runKimi({
      accountId: "acct",
      apiToken: "cf-token",
      model: "@cf/meta/llama-3.2-3b-instruct",
      messages: [{ role: "user", content: "hi" }],
      gateway: { id: "my-gw", metadata: { feature: "extraction" } },
    })) {
      /* drain */
    }
    assert.ok(lastRequest);
    assert.strictEqual(
      lastRequest!.url,
      "https://gateway.ai.cloudflare.com/v1/acct/my-gw/compat/chat/completions",
    );
    const body = await lastRequest!.clone().json();
    assert.strictEqual(body.model, "workers-ai/@cf/meta/llama-3.2-3b-instruct");
    // Plumbing tags ride along via cf-aig-metadata so the dashboard can filter.
    const meta = lastRequest!.headers.get("cf-aig-metadata");
    assert.ok(meta && meta.includes("extraction"));
  });
});

describe("runKimi: OpenRouter routing (never Cloudflare)", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      lastRequest = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    // OpenRouter model ids share the "vendor/model" shape Cloudflare's gateway
    // path also uses (e.g. "anthropic/..."), so — just like in the real app,
    // where a model only becomes selectable once it comes from the fetched
    // OpenRouter catalog — these ids must be registered as openrouter-provider
    // entries first. Without this, getModelOrInfer()'s generic id-prefix guess
    // would misroute them to Cloudflare's AI Gateway instead.
    registerOpenRouterModels([
      {
        id: "anthropic/claude-sonnet-4-6",
        provider: "openrouter",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        pricing: { inputPerMtok: 3, outputPerMtok: 15 },
        supports: { tools: true, reasoning: true, streaming: true },
        billingMode: "byok",
      },
      {
        id: "deepseek/deepseek-r1:free",
        provider: "openrouter",
        contextWindow: 64_000,
        maxOutputTokens: 8_192,
        pricing: { inputPerMtok: 0, outputPerMtok: 0 },
        supports: { tools: false, reasoning: true, streaming: true },
        billingMode: "byok",
      },
    ]);
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerOpenRouterModels([]); // don't leak into other test files
  });
  beforeEach(() => {
    lastRequest = null;
  });

  const baseOpts = {
    accountId: "acct",
    apiToken: "cf-token",
    model: "anthropic/claude-sonnet-4-6",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  it("goes straight to openrouter.ai with a plain bearer, no account id, no gateway required", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      providerKeys: { openrouter: "sk-or-test" },
    })) {
      /* drain */
    }
    assert.ok(lastRequest);
    assert.strictEqual(lastRequest!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer sk-or-test");
    assert.strictEqual(lastRequest!.headers.get("cf-aig-authorization"), null);
    assert.strictEqual(lastRequest!.headers.get("cf-aig-byok-alias"), null);
    assert.strictEqual(lastRequest!.headers.get("cf-aig-gateway-id"), null);
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    // Model id passes through unchanged — no workers-ai/ prefix, no account routing.
    assert.strictEqual(body.model, "anthropic/claude-sonnet-4-6");
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
  });

  it("sends OpenRouter's attribution headers", async () => {
    for await (const _ of runKimi({ ...baseOpts, providerKeys: { openrouter: "sk-or-test" } })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.headers.get("HTTP-Referer"), "https://kimiflare.com");
    assert.strictEqual(lastRequest!.headers.get("X-Title"), "kimiflare");
  });

  it("works with no gateway configured at all — OpenRouter never needs one", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      providerKeys: { openrouter: "sk-or-test" },
      gateway: undefined,
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.url, "https://openrouter.ai/api/v1/chat/completions");
  });

  it("throws a clear, actionable error when no OpenRouter key is configured", async () => {
    await assert.rejects(
      async () => {
        for await (const _ of runKimi({ ...baseOpts, providerKeys: {} })) {
          /* drain */
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /OpenRouter API key/);
        assert.match(err.message, /\/keys set openrouter/);
        return true;
      },
    );
    // No request should have been attempted.
    assert.strictEqual(lastRequest, null);
  });

  it("accepts OpenRouter's colon-suffixed free/nitro model id variants", async () => {
    for await (const _ of runKimi({
      ...baseOpts,
      model: "deepseek/deepseek-r1:free",
      providerKeys: { openrouter: "sk-or-test" },
    })) {
      /* drain */
    }
    assert.ok(lastRequest);
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.strictEqual(body.model, "deepseek/deepseek-r1:free");
  });
});
