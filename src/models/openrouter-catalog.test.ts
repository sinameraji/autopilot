import { describe, it } from "node:test";
import assert from "node:assert";
import { mapOpenRouterModel, fetchOpenRouterCatalog, loadOpenRouterCatalog, type OpenRouterRawModel } from "./openrouter-catalog.js";

const SAMPLE: OpenRouterRawModel = {
  id: "anthropic/claude-sonnet-4-6",
  context_length: 200_000,
  top_provider: { max_completion_tokens: 8_192 },
  pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
  architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
  supported_parameters: ["tools", "reasoning", "temperature"],
};

describe("mapOpenRouterModel: pure mapping from the OpenRouter API shape", () => {
  it("maps id, context, pricing (per-token -> per-Mtok), and capabilities", () => {
    const entry = mapOpenRouterModel(SAMPLE);
    assert.strictEqual(entry.id, "anthropic/claude-sonnet-4-6");
    assert.strictEqual(entry.provider, "openrouter");
    assert.strictEqual(entry.contextWindow, 200_000);
    assert.strictEqual(entry.maxOutputTokens, 8_192);
    // $0.000003/token -> $3.00/Mtok
    assert.strictEqual(entry.pricing.inputPerMtok, 3.0);
    assert.strictEqual(entry.pricing.outputPerMtok, 15.0);
    assert.strictEqual(entry.pricing.cachedInputPerMtok, 0.3);
    assert.strictEqual(entry.supports.tools, true);
    assert.strictEqual(entry.supports.reasoning, true);
    assert.strictEqual(entry.supports.vision, true);
    assert.strictEqual(entry.supports.streaming, true);
    assert.strictEqual(entry.billingMode, "byok");
  });

  it("a model with no supported_parameters gets tools:false, reasoning:false, no vision", () => {
    const entry = mapOpenRouterModel({ id: "some/plain-model" });
    assert.strictEqual(entry.supports.tools, false);
    assert.strictEqual(entry.supports.reasoning, false);
    assert.strictEqual(entry.supports.vision, false);
    // Conservative fallbacks when the API omits fields.
    assert.strictEqual(entry.contextWindow, 128_000);
    assert.strictEqual(entry.maxOutputTokens, 4_096);
    assert.strictEqual(entry.pricing.inputPerMtok, 0);
  });

  it("a model that does not accept temperature omits the field rather than setting it false-negative", () => {
    const entry = mapOpenRouterModel({ id: "x/y", supported_parameters: ["tools"] });
    assert.strictEqual(entry.supports.temperature, undefined);
  });
});

describe("fetchOpenRouterCatalog: network call + mapping, with a mocked fetch", () => {
  it("hits GET /api/v1/models with no auth and maps every entry", async () => {
    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    const mockFetch = (async (url: string | URL, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
      return new Response(JSON.stringify({ data: [SAMPLE, { id: "openai/gpt-5-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const models = await fetchOpenRouterCatalog(mockFetch);
    assert.strictEqual(calledUrl, "https://openrouter.ai/api/v1/models");
    // No Authorization header — listing models needs no key.
    const headers = new Headers(calledInit?.headers);
    assert.strictEqual(headers.get("Authorization"), null);
    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0]?.id, "anthropic/claude-sonnet-4-6");
    assert.strictEqual(models[1]?.id, "openai/gpt-5-mini");
  });

  it("throws on a non-OK response", async () => {
    const mockFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(() => fetchOpenRouterCatalog(mockFetch));
  });
});

describe("loadOpenRouterCatalog: cache-first with fetch fallback", () => {
  it("returns an empty list (not a throw) when the fetch fails and there is no cache", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    // A fresh XDG_CONFIG_HOME with nothing cached yet.
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = `/tmp/kimiflare-test-${Date.now()}-${Math.random()}`;
    try {
      const models = await loadOpenRouterCatalog({ fetchImpl: failing });
      assert.deepStrictEqual(models, []);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  it("fetches, caches, then reuses the cache on the next call without a second fetch", async () => {
    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [SAMPLE] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = `/tmp/kimiflare-test-${Date.now()}-${Math.random()}`;
    try {
      const first = await loadOpenRouterCatalog({ fetchImpl: mockFetch });
      const second = await loadOpenRouterCatalog({ fetchImpl: mockFetch });
      assert.strictEqual(calls, 1, "second call should reuse the disk cache, not refetch");
      assert.strictEqual(first.length, 1);
      assert.deepStrictEqual(second, first);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  it("falls back to a stale cache when a later fetch fails", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ data: [SAMPLE] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const failing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = `/tmp/kimiflare-test-${Date.now()}-${Math.random()}`;
    try {
      await loadOpenRouterCatalog({ fetchImpl: ok }); // populates the cache
      // ttlMs: 0 forces "the cache is stale" so it must attempt a refetch, which fails.
      const fallback = await loadOpenRouterCatalog({ fetchImpl: failing, ttlMs: 0 });
      assert.strictEqual(fallback.length, 1);
      assert.strictEqual(fallback[0]?.id, "anthropic/claude-sonnet-4-6");
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});
