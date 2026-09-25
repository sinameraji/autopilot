import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  getModel,
  getModelOrInfer,
  isFreeModel,
  listModels,
  migrateLegacyModelId,
  RECOMMENDED_MODEL_IDS,
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

  it("recommends the seeded Kimi models, default included", () => {
    assert.ok(RECOMMENDED_MODEL_IDS.includes(DEFAULT_MODEL));
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
