import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapRequestyModel,
  fetchRequestyCatalog,
  loadRequestyCatalog,
  ensureRequestyCatalog,
  type RequestyRawModel,
} from "./requesty-catalog.js";
import { featuredModels, getModel, registerRequestyModels } from "./registry.js";

const SAMPLE: RequestyRawModel = {
  id: "openai/gpt-4o-mini",
  api: "chat",
  context_window: 128_000,
  max_output_tokens: 16_384,
  input_price: 0.00000015,
  output_price: 0.0000006,
  cached_price: 0.000000075,
  supports_tool_calling: true,
  supports_vision: true,
};

const MANAGED: RequestyRawModel[] = [
  { id: "kimi-k2.6", api: "chat", context_window: 262_144, supports_tool_calling: true, supports_reasoning: true },
  { id: "gpt-5-mini@eu", api: "chat", supports_tool_calling: true },
];

/** Serves `managed` on /models/managed and `full` on /models; `null` makes that endpoint fail. */
function routedFetch(
  managed: RequestyRawModel[] | null,
  full: RequestyRawModel[] | null,
  seen?: string[],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen?.push(url);
    const data = url.endsWith("/models/managed") ? managed : full;
    if (!data) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ object: "list", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  throw new Error("network down");
}) as typeof fetch;

describe("mapRequestyModel: pure mapping from the Requesty API shape", () => {
  it("maps context, output limit, pricing (per-token -> per-Mtok), and capabilities", () => {
    const m = mapRequestyModel(SAMPLE);
    assert.strictEqual(m.id, "openai/gpt-4o-mini");
    assert.strictEqual(m.contextWindow, 128_000);
    assert.strictEqual(m.maxOutputTokens, 16_384);
    assert.ok(Math.abs(m.pricing.inputPerMtok - 0.15) < 1e-9);
    assert.ok(Math.abs(m.pricing.outputPerMtok - 0.6) < 1e-9);
    assert.ok(Math.abs((m.pricing.cachedInputPerMtok ?? 0) - 0.075) < 1e-9);
    assert.deepStrictEqual(m.supports, { tools: true, reasoning: false, streaming: true, vision: true });
  });
});

describe("Requesty catalog I/O", () => {
  let dir: string;
  let prevXdg: string | undefined;
  let prevBase: string | undefined;

  beforeEach(async () => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevBase = process.env.REQUESTY_BASE_URL;
    delete process.env.REQUESTY_BASE_URL;
    dir = await mkdtemp(join(tmpdir(), "kimiflare-requesty-catalog-test-"));
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(async () => {
    registerRequestyModels([]);
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevBase === undefined) delete process.env.REQUESTY_BASE_URL;
    else process.env.REQUESTY_BASE_URL = prevBase;
    await rm(dir, { recursive: true, force: true });
  });

  describe("fetchRequestyCatalog", () => {
    it("lists managed policies first, then the full catalog, and skips non-chat models", async () => {
      const seen: string[] = [];
      const embedding: RequestyRawModel = { id: "openai/text-embedding-3-small", api: "embedding" };
      const catalog = await fetchRequestyCatalog(routedFetch(MANAGED, [SAMPLE, embedding], seen));
      assert.deepStrictEqual(
        catalog.models.map((m) => m.id),
        ["kimi-k2.6", "gpt-5-mini@eu", "openai/gpt-4o-mini"],
      );
      assert.deepStrictEqual(catalog.featured, ["kimi-k2.6"]);
      assert.ok(seen.includes("https://router.requesty.ai/v1/models/managed"));
      assert.ok(seen.includes("https://router.requesty.ai/v1/models"));
    });

    it("still returns the other list when one endpoint fails", async () => {
      const onlyFull = await fetchRequestyCatalog(routedFetch(null, [SAMPLE]));
      assert.deepStrictEqual(onlyFull.models.map((m) => m.id), ["openai/gpt-4o-mini"]);
      assert.deepStrictEqual(onlyFull.featured, []);
      const onlyManaged = await fetchRequestyCatalog(routedFetch(MANAGED, null));
      assert.strictEqual(onlyManaged.models.length, 2);
    });

    it("throws when both endpoints fail", async () => {
      await assert.rejects(() => fetchRequestyCatalog(routedFetch(null, null)));
    });
  });

  describe("loadRequestyCatalog: cache-first with fetch fallback", () => {
    it("returns an empty list (not a throw) when offline with no cache", async () => {
      assert.deepStrictEqual(await loadRequestyCatalog({ fetchImpl: failingFetch }), { models: [], featured: [] });
    });

    it("falls back to a stale cache when a later fetch fails", async () => {
      await loadRequestyCatalog({ fetchImpl: routedFetch(MANAGED, [SAMPLE]) });
      const stale = await loadRequestyCatalog({ ttlMs: 0, fetchImpl: failingFetch });
      assert.strictEqual(stale.models.length, 3);
      assert.deepStrictEqual(stale.featured, ["kimi-k2.6"]);
    });
  });

  describe("ensureRequestyCatalog", () => {
    it("registers the catalog and features the managed tool-capable policies", async () => {
      const count = await ensureRequestyCatalog({ fetchImpl: routedFetch(MANAGED, [SAMPLE]) });
      assert.strictEqual(count, 3);
      assert.strictEqual(getModel("kimi-k2.6")?.contextWindow, 262_144);
      assert.strictEqual(getModel("openai/gpt-4o-mini")?.maxOutputTokens, 16_384);
      assert.deepStrictEqual(
        featuredModels().map((m) => m.id),
        ["kimi-k2.6"],
      );
    });

    it("never throws and registers nothing when offline with no cache", async () => {
      const count = await ensureRequestyCatalog({ fetchImpl: failingFetch });
      assert.strictEqual(count, 0);
      assert.strictEqual(getModel("gpt-5-mini@eu"), undefined);
    });
  });
});
