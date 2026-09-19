import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getModel,
  getModelOrInfer,
  inferProvider,
  isUnifiedEligible,
  registerOpenRouterModels,
  routeFor,
  type ModelEntry,
} from "./registry.js";
import { decideNextStep } from "./next-step.js";

describe("registry: Moonshot K3", () => {
  it("infers moonshotai provider from moonshotai/kimi-k3", () => {
    assert.strictEqual(inferProvider("moonshotai/kimi-k3"), "moonshotai");
  });

  it("seeds moonshotai/kimi-k3 as a Cloudflare-catalog model paid via Unified Billing", () => {
    const model = getModel("moonshotai/kimi-k3");
    assert.ok(model, "expected moonshotai/kimi-k3 to be seeded");
    assert.strictEqual(model!.provider, "moonshotai");
    assert.strictEqual(model!.billingMode, "unified");
    assert.strictEqual(routeFor(model!), "cf-catalog");
    assert.strictEqual(isUnifiedEligible(model!), true);
    // K3 rejects any temperature other than 1.0 — the client must omit it.
    assert.strictEqual(model!.supports.temperature, false);
    assert.strictEqual(model!.contextWindow, 1_048_576);
    assert.deepStrictEqual(model!.pricing, { inputPerMtok: 3.0, cachedInputPerMtok: 0.3, outputPerMtok: 15.0 });
  });

  it("K3 needs no provider key and no gateway: next step is ready", () => {
    const model = getModel("moonshotai/kimi-k3")!;
    assert.deepStrictEqual(decideNextStep(null, model), { kind: "ready" });
    assert.deepStrictEqual(
      decideNextStep({ accountId: "a", apiToken: "t", model: model.id }, model),
      { kind: "ready" },
    );
  });

  it("unknown moonshotai/* ids infer the cf-catalog route with unified billing", () => {
    const inferred = getModelOrInfer("moonshotai/kimi-k3-future");
    assert.strictEqual(inferred.provider, "moonshotai");
    assert.strictEqual(inferred.billingMode, "unified");
    assert.strictEqual(routeFor(inferred), "cf-catalog");
  });

  it("keeps Workers AI Kimi models on the workers-ai provider", () => {
    assert.strictEqual(inferProvider("@cf/moonshotai/kimi-k2.7-code"), "workers-ai");
    assert.strictEqual(inferProvider("@cf/moonshotai/kimi-k2.6"), "workers-ai");
    assert.strictEqual(inferProvider("@cf/moonshotai/kimi-k2.5"), "workers-ai");
  });
});

describe("registry: OpenRouter provider", () => {
  const orModel: ModelEntry = {
    id: "anthropic/claude-sonnet-4-6",
    provider: "openrouter",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    pricing: { inputPerMtok: 3.0, outputPerMtok: 15.0 },
    supports: { tools: true, reasoning: true, streaming: true },
    billingMode: "byok",
  };

  it("routes to the dedicated openrouter transport, never gateway/cf-catalog", () => {
    assert.strictEqual(routeFor(orModel), "openrouter");
  });

  it("is never Unified-Billing-eligible, even though its id prefix matches a CF Unified Billing provider", () => {
    // Regression guard: "anthropic/..." would match UNIFIED_BILLING_PROVIDERS by prefix if the
    // openrouter check didn't come first — OpenRouter has no Cloudflare Unified Billing at all.
    assert.strictEqual(isUnifiedEligible(orModel), false);
  });

  it("registerOpenRouterModels() makes fetched models visible via getModel(), without touching seed/user models", () => {
    registerOpenRouterModels([orModel]);
    try {
      const hit = getModel("anthropic/claude-sonnet-4-6");
      assert.ok(hit);
      assert.strictEqual(hit!.provider, "openrouter");
      // A seeded model is still there too.
      assert.ok(getModel("@cf/moonshotai/kimi-k2.7-code"));
    } finally {
      registerOpenRouterModels([]); // don't leak state into other tests
    }
  });

  it("an OpenRouter model needs no gateway and no Cloudflare key: next step is ready as soon as a provider key exists", () => {
    assert.deepStrictEqual(
      decideNextStep({ accountId: "a", apiToken: "t", model: orModel.id, providerKeys: { openrouter: "sk-or-x" } }, orModel),
      { kind: "ready" },
    );
  });

  it("an OpenRouter model with no stored key needs one — never needs-gateway (that's Cloudflare-only)", () => {
    assert.deepStrictEqual(
      decideNextStep({ accountId: "a", apiToken: "t", model: orModel.id }, orModel),
      { kind: "needs-key" },
    );
    // Even with no config loaded at all.
    assert.deepStrictEqual(decideNextStep(null, orModel), { kind: "needs-key" });
  });
});
