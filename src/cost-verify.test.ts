import { describe, it } from "node:test";
import assert from "node:assert";
import { formatVerifyReport, verifySession } from "./cost-verify.js";
import type { SessionUsage } from "./usage-tracker.js";

const session: SessionUsage = {
  id: "s1",
  date: "2026-09-25",
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cost: 0,
  turns: [
    { turnId: "a", logId: "gen-a", promptTokens: 1200, completionTokens: 40, cachedTokens: 1000, estimatedCost: 0.001, confirmedCost: 0.00123 },
    { turnId: "b", logId: "gen-b", promptTokens: 900, completionTokens: 10, cachedTokens: 0, estimatedCost: 0.0005, confirmedCost: 0.0005 },
    { turnId: "c", estimatedCost: 0.0001 }, // custom endpoint: no generation id
  ],
};

/** OpenRouter /generation stub: gen-a matches exactly; gen-b reports different output tokens. */
function stub(records: Record<string, object | null>): typeof fetch {
  return (async (url: string) => {
    const id = new URL(url).searchParams.get("id")!;
    const rec = records[id];
    if (!rec) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ data: rec }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("verifySession", () => {
  it("passes generations whose tokens and cost match OpenRouter, flags the ones that don't", async () => {
    const r = await verifySession(
      session,
      "k",
      stub({
        "gen-a": { total_cost: 0.00123, native_tokens_prompt: 1200, native_tokens_completion: 40, native_tokens_cached: 1000 },
        "gen-b": { total_cost: 0.0005, native_tokens_prompt: 900, native_tokens_completion: 12, native_tokens_cached: 0 },
      }),
    );
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.skipped, 1);
    assert.ok(r.rows[0]!.fields.every((f) => f.ok));
    const out = r.rows[1]!.fields.find((f) => f.name === "output")!;
    assert.deepStrictEqual([out.ok, out.ours, out.openrouter], [false, 10, 12]);
    const report = formatVerifyReport(r);
    assert.match(report, /✗ 1 of 2 generations differ/);
    assert.match(report, /output 10 ≠ 12/);
  });

  it("tolerates float rounding in cost but not real differences", async () => {
    const one = { ...session, turns: [session.turns![0]!] };
    const close = await verifySession(one, "k", stub({ "gen-a": { total_cost: 0.00123000000001, native_tokens_prompt: 1200, native_tokens_completion: 40, native_tokens_cached: 1000 } }));
    assert.ok(close.rows[0]!.fields.every((f) => f.ok));
    const off = await verifySession(one, "k", stub({ "gen-a": { total_cost: 0.0013, native_tokens_prompt: 1200, native_tokens_completion: 40, native_tokens_cached: 1000 } }));
    assert.strictEqual(off.rows[0]!.fields.find((f) => f.name === "cost")!.ok, false);
  });

  it("reports generations OpenRouter has no record of as missing, not as mismatches", async () => {
    const r = await verifySession({ ...session, turns: [session.turns![0]!] }, "k", stub({}));
    assert.strictEqual(r.rows[0]!.missing, true);
    assert.match(formatVerifyReport(r), /no record \(yet\)/);
  });

  it("says so when everything matches", async () => {
    const r = await verifySession(
      { ...session, turns: [session.turns![0]!] },
      "k",
      stub({ "gen-a": { total_cost: 0.00123, native_tokens_prompt: 1200, native_tokens_completion: 40, native_tokens_cached: 1000 } }),
    );
    assert.match(formatVerifyReport(r), /✓ All 1 generation match OpenRouter exactly/);
  });
});
