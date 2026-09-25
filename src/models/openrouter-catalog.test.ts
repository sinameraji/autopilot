import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapOpenRouterModel,
  fetchOpenRouterCatalog,
  loadOpenRouterCatalog,
  ensureOpenRouterCatalog,
  type OpenRouterRawModel,
} from "./openrouter-catalog.js";
import { getModel, registerOpenRouterModels } from "./registry.js";

const SAMPLE: OpenRouterRawModel = {
  id: "anthropic/claude-sonnet-4-6",
  name: "Anthropic: Claude Sonnet 4.6",
  context_length: 200_000,
  top_provider: { max_completion_tokens: 8_192 },
  pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
  architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
  supported_parameters: ["tools", "reasoning", "temperature"],
};

function okFetch(data: OpenRouterRawModel[], counter?: { calls: number }): typeof fetch {
  return (async () => {
    if (counter) counter.calls++;
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  throw new Error("network down");
}) as typeof fetch;

describe("mapOpenRouterModel: pure mapping from the OpenRouter API shape", () => {
  it("maps id, name, context, pricing (per-token -> per-Mtok), and capabilities", () => {
    const entry = mapOpenRouterModel(SAMPLE);
    assert.strictEqual(entry.id, "anthropic/claude-sonnet-4-6");
    assert.strictEqual(entry.name, "Anthropic: Claude Sonnet 4.6");
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
    // The single-provider ModelEntry carries no provider/billing fields.
    assert.ok(!("provider" in entry));
    assert.ok(!("billingMode" in entry));
  });

  it("a model with no supported_parameters gets tools:false, reasoning:false, no vision, no name", () => {
    const entry = mapOpenRouterModel({ id: "some/plain-model" });
    assert.strictEqual(entry.supports.tools, false);
    assert.strictEqual(entry.supports.reasoning, false);
    assert.strictEqual(entry.supports.vision, false);
    assert.ok(!("name" in entry));
    // Conservative fallbacks when the API omits fields.
    assert.strictEqual(entry.contextWindow, 128_000);
    assert.strictEqual(entry.maxOutputTokens, 4_096);
    assert.strictEqual(entry.pricing.inputPerMtok, 0);
    assert.strictEqual(entry.pricing.cachedInputPerMtok, undefined);
  });

  it("a model that does not list temperature leaves the field undefined (default: accepted)", () => {
    const entry = mapOpenRouterModel({ id: "x/y", supported_parameters: ["tools"] });
    assert.strictEqual(entry.supports.temperature, undefined);
  });
});

describe("catalog I/O", () => {
  let dir: string;
  let prevXdg: string | undefined;
  let prevBase: string | undefined;

  beforeEach(async () => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevBase = process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_BASE_URL;
    dir = await mkdtemp(join(tmpdir(), "kimiflare-catalog-test-"));
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevBase === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = prevBase;
    await rm(dir, { recursive: true, force: true });
  });

  describe("fetchOpenRouterCatalog", () => {
    it("hits GET /api/v1/models with no auth and maps every entry", async () => {
      let calledUrl: string | undefined;
      let calledInit: RequestInit | undefined;
      const mockFetch = (async (url: string | URL, init?: RequestInit) => {
        calledUrl = String(url);
        calledInit = init;
        return new Response(JSON.stringify({ data: [SAMPLE, { id: "openai/gpt-5-mini" }] }), { status: 200 });
      }) as typeof fetch;

      const models = await fetchOpenRouterCatalog(mockFetch);
      assert.strictEqual(calledUrl, "https://openrouter.ai/api/v1/models");
      // No Authorization header — listing models needs no key.
      assert.strictEqual(new Headers(calledInit?.headers).get("Authorization"), null);
      assert.deepStrictEqual(
        models.map((m) => m.id),
        ["anthropic/claude-sonnet-4-6", "openai/gpt-5-mini"],
      );
    });

    it("honors OPENROUTER_BASE_URL", async () => {
      process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9999/api/v1/";
      let calledUrl: string | undefined;
      const mockFetch = (async (url: string | URL) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch;
      await fetchOpenRouterCatalog(mockFetch);
      assert.strictEqual(calledUrl, "http://127.0.0.1:9999/api/v1/models");
    });

    it("throws on a non-OK response", async () => {
      const mockFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
      await assert.rejects(() => fetchOpenRouterCatalog(mockFetch));
    });
  });

  describe("loadOpenRouterCatalog: cache-first with fetch fallback", () => {
    it("returns an empty list (not a throw) when the fetch fails and there is no cache", async () => {
      assert.deepStrictEqual(await loadOpenRouterCatalog({ fetchImpl: failingFetch }), []);
    });

    it("fetches, caches, then reuses the cache without a second fetch", async () => {
      const counter = { calls: 0 };
      const first = await loadOpenRouterCatalog({ fetchImpl: okFetch([SAMPLE], counter) });
      const second = await loadOpenRouterCatalog({ fetchImpl: okFetch([SAMPLE], counter) });
      assert.strictEqual(counter.calls, 1, "second call should reuse the disk cache, not refetch");
      assert.strictEqual(first.length, 1);
      assert.deepStrictEqual(second, first);
    });

    it("falls back to a stale cache when a later fetch fails", async () => {
      await loadOpenRouterCatalog({ fetchImpl: okFetch([SAMPLE]) }); // populates the cache
      // ttlMs: 0 forces "the cache is stale" so it must attempt a refetch, which fails.
      const fallback = await loadOpenRouterCatalog({ fetchImpl: failingFetch, ttlMs: 0 });
      assert.strictEqual(fallback.length, 1);
      assert.strictEqual(fallback[0]?.id, "anthropic/claude-sonnet-4-6");
    });

    it("ignores a cache written by an older build (no version / old ModelEntry shape)", async () => {
      await mkdir(join(dir, "kimiflare"), { recursive: true });
      await writeFile(
        join(dir, "kimiflare", "openrouter-models.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          models: [{ id: "old/model", provider: "openrouter", billingMode: "byok" }],
        }),
      );
      const counter = { calls: 0 };
      const models = await loadOpenRouterCatalog({ fetchImpl: okFetch([SAMPLE], counter) });
      assert.strictEqual(counter.calls, 1, "a fresh-but-unversioned cache must not be trusted");
      assert.deepStrictEqual(models.map((m) => m.id), ["anthropic/claude-sonnet-4-6"]);
      // …and with no network, the old cache is not used as a fallback either.
      await writeFile(
        join(dir, "kimiflare", "openrouter-models.json"),
        JSON.stringify({ fetchedAt: new Date().toISOString(), models: [{ id: "old/model" }] }),
      );
      assert.deepStrictEqual(await loadOpenRouterCatalog({ fetchImpl: failingFetch }), []);
    });
  });

  describe("ensureOpenRouterCatalog", () => {
    afterEach(() => registerOpenRouterModels([]));

    it("registers the loaded catalog with the model registry", async () => {
      const count = await ensureOpenRouterCatalog({ fetchImpl: okFetch([{ ...SAMPLE, id: "vendor/registered-model" }]) });
      assert.strictEqual(count, 1);
      assert.strictEqual(getModel("vendor/registered-model")?.contextWindow, 200_000);
    });

    it("never throws and registers nothing when offline with no cache", async () => {
      registerOpenRouterModels([]);
      const count = await ensureOpenRouterCatalog({ fetchImpl: failingFetch });
      assert.strictEqual(count, 0);
      assert.strictEqual(getModel("vendor/registered-model"), undefined);
    });
  });
});
