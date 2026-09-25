/**
 * runKimi request shape on the OpenRouter path: URL, auth/attribution
 * headers, and the body fields that decide routing, caching and cost.
 * Asserts on the real outgoing fetch (globalThis.fetch is stubbed).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runKimi, type RunKimiOpts } from "./client.js";
import { KimiApiError } from "../util/errors.js";

const KEY = "sk-or-test-key-123456";

describe("runKimi: OpenRouter request", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;
  const savedEnv = {
    base: process.env.OPENROUTER_BASE_URL,
    custom: process.env.KIMIFLARE_BASE_URL,
    customKey: process.env.KIMIFLARE_API_KEY,
  };

  before(() => {
    originalFetch = globalThis.fetch;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.KIMIFLARE_BASE_URL;
    delete process.env.KIMIFLARE_API_KEY;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      lastRequest = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of [
      ["OPENROUTER_BASE_URL", savedEnv.base],
      ["KIMIFLARE_BASE_URL", savedEnv.custom],
      ["KIMIFLARE_API_KEY", savedEnv.customKey],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    lastRequest = null;
  });

  const base: RunKimiOpts = {
    openrouterApiKey: KEY,
    model: "moonshotai/kimi-k2.6",
    messages: [{ role: "user", content: "hi" }],
  };

  async function send(opts: Partial<RunKimiOpts> = {}): Promise<{ req: Request; body: Record<string, unknown> }> {
    for await (const _ of runKimi({ ...base, ...opts })) {
      /* drain */
    }
    assert.ok(lastRequest, "expected a request");
    const body = (await lastRequest!.clone().json()) as Record<string, unknown>;
    return { req: lastRequest!, body };
  }

  it("posts to OpenRouter chat completions with the key as a bearer", async () => {
    const { req } = await send();
    assert.strictEqual(req.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.strictEqual(req.method, "POST");
    assert.strictEqual(req.headers.get("Authorization"), `Bearer ${KEY}`);
  });

  it("sends OpenRouter's app-attribution headers", async () => {
    const { req } = await send();
    assert.strictEqual(req.headers.get("HTTP-Referer"), "https://kimiflare.com");
    assert.strictEqual(req.headers.get("X-Title"), "kimiflare");
  });

  it("honours OPENROUTER_BASE_URL (tests, local mocks, proxies)", async () => {
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9999/api/v1/";
    try {
      const { req } = await send();
      assert.strictEqual(req.url, "http://127.0.0.1:9999/api/v1/chat/completions");
    } finally {
      delete process.env.OPENROUTER_BASE_URL;
    }
  });

  it("puts the model id in the body unchanged, with max_completion_tokens (not max_tokens)", async () => {
    const { body } = await send({ maxCompletionTokens: 1234 });
    assert.strictEqual(body.model, "moonshotai/kimi-k2.6");
    assert.strictEqual(body.max_completion_tokens, 1234);
    assert.ok(!("max_tokens" in body));
    assert.strictEqual(body.stream, true);
  });

  it("omits the deprecated usage/stream_options flags (OpenRouter always returns usage)", async () => {
    const { body } = await send();
    assert.ok(!("stream_options" in body));
    assert.ok(!("usage" in body));
  });

  it("sends reasoning_effort only for models that support reasoning", async () => {
    const withReasoning = await send({ reasoningEffort: "high" });
    assert.strictEqual(withReasoning.body.reasoning_effort, "high");
    // Unknown ids fall back to conservative capabilities (reasoning: false).
    const unknown = await send({ model: "someone/unknown-model", reasoningEffort: "high" });
    assert.ok(!("reasoning_effort" in unknown.body));
  });

  it("omits temperature for Kimi K3, which only accepts its default", async () => {
    const k3 = await send({ model: "moonshotai/kimi-k3", temperature: 0.2 });
    assert.ok(!("temperature" in k3.body));
    const k26 = await send({ temperature: 0.3 });
    assert.strictEqual(k26.body.temperature, 0.3);
  });

  it("uses sessionId as OpenRouter's sticky-routing session_id (and X-Session-ID header)", async () => {
    const { req, body } = await send({ sessionId: "sess-123" });
    assert.strictEqual(body.session_id, "sess-123");
    assert.strictEqual(req.headers.get("X-Session-ID"), "sess-123");
    const none = await send();
    assert.ok(!("session_id" in none.body));
    assert.strictEqual(none.req.headers.get("X-Session-ID"), null);
  });

  it("always requires providers to support every parameter, merged with configured prefs", async () => {
    const plain = await send();
    assert.deepStrictEqual(plain.body.provider, { require_parameters: true });
    const withPrefs = await send({ provider: { ignore: ["SlowCo"], quantizations: ["fp8"] } });
    assert.deepStrictEqual(withPrefs.body.provider, {
      require_parameters: true,
      ignore: ["SlowCo"],
      quantizations: ["fp8"],
    });
  });

  it("adds top-level cache_control only for anthropic/* models", async () => {
    const claude = await send({ model: "anthropic/claude-sonnet-4-6" });
    assert.deepStrictEqual(claude.body.cache_control, { type: "ephemeral" });
    const kimi = await send();
    assert.ok(!("cache_control" in kimi.body));
  });

  it("sends tools with auto tool choice and parallel calls", async () => {
    const { body } = await send({
      tools: [{ type: "function", function: { name: "read", description: "r", parameters: { type: "object" } } }],
    });
    assert.strictEqual(body.tool_choice, "auto");
    assert.strictEqual(body.parallel_tool_calls, true);
    assert.strictEqual((body.tools as unknown[]).length, 1);
  });

  it("accepts OpenRouter's :variant and ~alias model ids", async () => {
    const free = await send({ model: "deepseek/deepseek-r1:free" });
    assert.strictEqual(free.body.model, "deepseek/deepseek-r1:free");
    const alias = await send({ model: "~moonshotai/kimi-latest" });
    assert.strictEqual(alias.body.model, "~moonshotai/kimi-latest");
  });

  it("rejects malformed model ids before sending anything", async () => {
    await assert.rejects(async () => {
      for await (const _ of runKimi({ ...base, model: "../../etc/passwd" })) {
        /* drain */
      }
    }, /Invalid model ID/);
    assert.strictEqual(lastRequest, null);
  });

  it("throws a 401 KimiApiError pointing at /key set when no key is configured", async () => {
    await assert.rejects(
      async () => {
        for await (const _ of runKimi({ ...base, openrouterApiKey: undefined })) {
          /* drain */
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof KimiApiError);
        assert.strictEqual(err.httpStatus, 401);
        assert.match(err.message, /\/key set/);
        return true;
      },
    );
    assert.strictEqual(lastRequest, null);
  });
});

describe("runKimi: OpenRouter HTTP errors", () => {
  let originalFetch: typeof globalThis.fetch;
  let calls = 0;

  before(() => {
    originalFetch = globalThis.fetch;
    delete process.env.KIMIFLARE_BASE_URL;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  function respondWith(status: number, message: string, extra: Record<string, unknown> = {}) {
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: status, message, ...extra } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
  }

  async function failure(): Promise<KimiApiError> {
    try {
      for await (const _ of runKimi({
        openrouterApiKey: KEY,
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
    } catch (e) {
      assert.ok(e instanceof KimiApiError, `expected KimiApiError, got ${String(e)}`);
      return e;
    }
    assert.fail("expected runKimi to throw");
  }

  it("401 → bad key, fix with /key set; not retried", async () => {
    respondWith(401, "No auth credentials found");
    const err = await failure();
    assert.strictEqual(err.httpStatus, 401);
    assert.match(err.message, /rejected your API key/);
    assert.match(err.message, /\/key set/);
    assert.strictEqual(calls, 1);
  });

  it("402 → out of credits, points at credits page and free models; not retried", async () => {
    respondWith(402, "Insufficient credits");
    const err = await failure();
    assert.strictEqual(err.httpStatus, 402);
    assert.match(err.message, /out of credits/);
    assert.match(err.message, /openrouter\.ai\/settings\/credits/);
    assert.strictEqual(calls, 1);
  });

  it("403 → moderation/guardrail explanation; not retried", async () => {
    respondWith(403, "Input flagged");
    const err = await failure();
    assert.strictEqual(err.httpStatus, 403);
    assert.match(err.message, /refused the request/);
    assert.strictEqual(calls, 1);
  });

  it("includes the upstream provider's raw reason when OpenRouter supplies it", async () => {
    respondWith(400, "Provider returned error", { metadata: { raw: "context too long", provider_name: "Moonshot AI" } });
    const err = await failure();
    assert.match(err.message, /Moonshot AI: context too long/);
  });
});
