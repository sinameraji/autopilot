import { describe, it } from "node:test";
import assert from "node:assert";
import { buildRightParts, formatProviderTag, formatUsd, shortenModelId } from "./status.js";

const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 50 },
};

describe("status bar right parts", () => {
  it("prefers OpenRouter's inline billed cost over the price table", () => {
    const parts = buildRightParts({ ...usage, cost: 0.1234 }, 1_000, null, null, "moonshotai/kimi-k2.6");
    assert.deepStrictEqual(parts, ["in 100 (50 cached)", "out 20", "ctx 10%", "$0.123"]);
  });

  it("appends the upstream provider that served the turn", () => {
    const parts = buildRightParts({ ...usage, cost: 0 }, 1_000, null, { provider: "Moonshot AI" });
    assert.strictEqual(parts.at(-1), "via Moonshot AI");
  });

  it("marks a session cost as an estimate until OpenRouter confirms it", () => {
    const session = { date: "2026-09-25", promptTokens: 100, completionTokens: 20, cachedTokens: 0, cost: 0.5, reconcilePending: true };
    assert.ok(buildRightParts(usage, 1_000, session).includes("≈$0.500"));
    assert.ok(buildRightParts(usage, 1_000, { ...session, reconcilePending: false }).includes("$0.500"));
  });
});

describe("formatProviderTag", () => {
  it("is null without a provider", () => {
    assert.strictEqual(formatProviderTag(null), null);
    assert.strictEqual(formatProviderTag({ generationId: "gen-1" }), null);
  });
});

describe("shortenModelId", () => {
  it("drops the vendor prefix", () => {
    assert.strictEqual(shortenModelId("moonshotai/kimi-k2.7-code"), "kimi-k2.7-code");
  });
});

describe("formatUsd", () => {
  it("keeps sub-cent costs visible instead of rounding them to $0.00", () => {
    assert.strictEqual(formatUsd(0), "$0");
    assert.strictEqual(formatUsd(0.00214), "$0.0021");
    assert.strictEqual(formatUsd(0.000123), "$0.00012");
    assert.strictEqual(formatUsd(0.05), "$0.05");
    assert.strictEqual(formatUsd(0.1234), "$0.123");
    assert.strictEqual(formatUsd(12.5), "$12.50");
  });
});
