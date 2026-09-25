import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  getModel,
  getModelOrInfer,
  isFreeModel,
  listModels,
  migrateLegacyModelId,
  featuredModels,
  registerOpenRouterModels,
  registerUserModels,
  vendorOf,
  type ModelEntry,
} from "./registry.js";
import { DEFAULT_MODEL, DEFAULT_PLUMBING_MODEL } from "../config.js";

function entry(id: string, over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMtok: 1, outputPerMtok: 2 },
    supports: { tools: true, reasoning: false, streaming: true },
    ...over,
  };
}

afterEach(() => {
  registerOpenRouterModels([]);
  registerUserModels([]);
});

describe("seed models (offline fallback)", () => {
  it("covers the default and plumbing models with real context windows", () => {
    for (const id of [DEFAULT_MODEL, DEFAULT_PLUMBING_MODEL]) {
      const m = getModel(id);
      assert.ok(m, `${id} should be seeded`);
      assert.strictEqual(m.contextWindow, 262_144);
      assert.ok(m.supports.tools);
    }
  });

  it("marks Kimi K3 as not accepting temperature", () => {
    assert.strictEqual(getModel("moonshotai/kimi-k3")?.supports.temperature, false);
  });
});

describe("live catalog registration", () => {
  it("merges the catalog into lookups and listModels, user overrides winning", () => {
    registerOpenRouterModels([entry("deepseek/deepseek-r1"), entry("moonshotai/kimi-k2.6", { contextWindow: 1 })]);
    registerUserModels([entry("deepseek/deepseek-r1", { contextWindow: 42 })]);
    assert.strictEqual(getModel("moonshotai/kimi-k2.6")?.contextWindow, 1, "catalog beats seed");
    assert.strictEqual(getModel("deepseek/deepseek-r1")?.contextWindow, 42, "user override beats catalog");
    const ids = listModels().map((m) => m.id);
    assert.ok(ids.includes("deepseek/deepseek-r1"));
    assert.ok(ids.includes("moonshotai/kimi-k3"), "seed entries not in the catalog remain");
    assert.strictEqual(ids.filter((i) => i === "moonshotai/kimi-k2.6").length, 1);
  });

  it("keeps the seed's hand-verified temperature=false for Kimi K3", () => {
    registerOpenRouterModels([entry("moonshotai/kimi-k3", { supports: { tools: true, reasoning: true, streaming: true, temperature: true } })]);
    assert.strictEqual(getModel("moonshotai/kimi-k3")?.supports.temperature, false);
  });
});

describe("getModelOrInfer", () => {
  it("returns conservative defaults for ids not in any catalog", () => {
    const m = getModelOrInfer("someone/unknown-model");
    assert.strictEqual(m.contextWindow, 128_000);
    assert.strictEqual(m.pricing.inputPerMtok, 0);
    assert.strictEqual(m.supports.tools, true);
  });
});

describe("vendorOf", () => {
  it("takes the segment before the slash, dropping OpenRouter's ~ alias prefix", () => {
    assert.strictEqual(vendorOf("moonshotai/kimi-k2.6"), "moonshotai");
    assert.strictEqual(vendorOf("~moonshotai/kimi-latest"), "moonshotai");
    assert.strictEqual(vendorOf("openrouter/auto"), "openrouter");
  });
});

describe("isFreeModel", () => {
  it("is true for zero-priced catalog models and :free ids", () => {
    registerOpenRouterModels([entry("z-ai/glm-4.5-air", { pricing: { inputPerMtok: 0, outputPerMtok: 0 } })]);
    assert.strictEqual(isFreeModel(getModel("z-ai/glm-4.5-air")!), true);
    assert.strictEqual(isFreeModel(getModelOrInfer("x/y:free")), true);
  });

  it("is false for unknown ids, whose zero pricing means 'unknown', not free", () => {
    assert.strictEqual(isFreeModel(getModelOrInfer("someone/unknown-model")), false);
    assert.strictEqual(isFreeModel(getModel(DEFAULT_MODEL)!), false);
  });
});

describe("migrateLegacyModelId", () => {
  it("maps the Cloudflare-era Kimi and GLM ids to OpenRouter's", () => {
    assert.strictEqual(migrateLegacyModelId("@cf/moonshotai/kimi-k2.6"), "moonshotai/kimi-k2.6");
    assert.strictEqual(migrateLegacyModelId("@cf/moonshotai/kimi-k2.7-code"), "moonshotai/kimi-k2.7-code");
    assert.strictEqual(migrateLegacyModelId("@cf/zai-org/glm-5.2"), "z-ai/glm-5.2");
    assert.strictEqual(migrateLegacyModelId("@cf/baai/bge-base-en-v1.5"), "baai/bge-base-en-v1.5");
  });

  it("strips other @cf/ and workers-ai/ prefixes and renames google-ai-studio", () => {
    assert.strictEqual(migrateLegacyModelId("@cf/meta/llama-4-scout"), "meta/llama-4-scout");
    assert.strictEqual(migrateLegacyModelId("workers-ai/@cf/moonshotai/kimi-k2.5"), "moonshotai/kimi-k2.5");
    assert.strictEqual(migrateLegacyModelId("google-ai-studio/gemini-3-pro"), "google/gemini-3-pro");
  });

  it("passes OpenRouter ids and undefined through unchanged", () => {
    assert.strictEqual(migrateLegacyModelId("moonshotai/kimi-k3"), "moonshotai/kimi-k3");
    assert.strictEqual(migrateLegacyModelId("anthropic/claude-sonnet-4.6"), "anthropic/claude-sonnet-4.6");
    assert.strictEqual(migrateLegacyModelId(undefined), undefined);
  });
});

describe("featuredModels", () => {
  const now = Date.UTC(2026, 8, 25);
  const day = 86_400;
  const q = (agentic: number, coding: number) => ({ agentic, coding });
  const nowSec = now / 1000;

  it("ranks recent tool-capable models by agentic + coding score, capped per vendor", () => {
    const models = [
      entry("a/top", { quality: q(58, 82), created: nowSec - 20 * day }),
      entry("a/second", { quality: q(56, 78), created: nowSec - 60 * day }),
      entry("a/third", { quality: q(55, 77), created: nowSec - 30 * day }),
      entry("b/good", { quality: q(50, 76), created: nowSec - 70 * day }),
      entry("c/cheap", { quality: q(41, 69), created: nowSec - 50 * day }),
    ];
    const ids = featuredModels(models, { now, perVendor: 2 }).map((m) => m.id);
    assert.deepStrictEqual(ids, ["a/top", "a/second", "b/good", "c/cheap"]);
  });

  it("drops stale models, models without tools or benchmarks, and variant/alias duplicates", () => {
    const models = [
      entry("a/fresh", { quality: q(50, 70), created: nowSec - 10 * day }),
      entry("a/old", { quality: q(60, 90), created: nowSec - 400 * day }),
      entry("b/no-tools", { quality: q(60, 90), created: nowSec, supports: { tools: false, reasoning: false, streaming: true } }),
      entry("c/unscored", { created: nowSec }),
      entry("a/fresh:batch", { quality: q(50, 70), created: nowSec }),
      entry("~a/latest", { quality: q(50, 70), created: nowSec }),
    ];
    assert.deepStrictEqual(featuredModels(models, { now }).map((m) => m.id), ["a/fresh"]);
  });

  it("respects the limit", () => {
    const models = Array.from({ length: 30 }, (_, i) => entry(`v${i}/m`, { quality: q(40 + i, 60), created: nowSec }));
    assert.strictEqual(featuredModels(models, { now, limit: 12 }).length, 12);
  });

  it("falls back to the seed models when nothing has benchmark data (offline)", () => {
    const ids = featuredModels(listModels(), { now }).map((m) => m.id);
    assert.ok(ids.includes(DEFAULT_MODEL));
  });
});
