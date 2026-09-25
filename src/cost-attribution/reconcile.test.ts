import { describe, it } from "node:test";
import assert from "node:assert";
import { reconcileWithOpenRouter, summarizeConfirmation } from "./reconcile.js";
import type { SessionUsage } from "../usage-tracker.js";

function session(turns: SessionUsage["turns"]): SessionUsage {
  return { id: "s", date: "2026-09-25", promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, turns };
}

describe("summarizeConfirmation", () => {
  it("sums confirmed cost and the matching estimates, counting unconfirmed turns", () => {
    const out = summarizeConfirmation([
      session([
        { turnId: "a", estimatedCost: 0.01, confirmedCost: 0.011 },
        { turnId: "b", estimatedCost: 0.02 },
      ]),
      session([{ turnId: "c", estimatedCost: 0.03, confirmedCost: 0.029 }]),
    ]);
    assert.strictEqual(out.turns, 3);
    assert.strictEqual(out.confirmedTurns, 2);
    assert.ok(Math.abs(out.confirmedCost - 0.04) < 1e-9);
    assert.ok(Math.abs(out.estimateForConfirmed - 0.04) < 1e-9);
  });
});

describe("reconcileWithOpenRouter", () => {
  it("is verified when every turn is confirmed and the estimate is close", async () => {
    const r = await reconcileWithOpenRouter({
      localCost: 0.1,
      sessions: [session([{ turnId: "a", estimatedCost: 0.1, confirmedCost: 0.1005 }])],
    });
    assert.strictEqual(r.status, "verified");
    assert.strictEqual(r.providerCost, 0.1005);
  });

  it("reports drift when some turns were never confirmed", async () => {
    const r = await reconcileWithOpenRouter({
      localCost: 0.2,
      sessions: [session([{ turnId: "a", estimatedCost: 0.1, confirmedCost: 0.1 }, { turnId: "b", estimatedCost: 0.1 }])],
    });
    assert.strictEqual(r.status, "drift");
    assert.match(r.message ?? "", /1 of 2 turns/);
  });

  it("is local-only when nothing was confirmed", async () => {
    const r = await reconcileWithOpenRouter({ localCost: 0.1, sessions: [session([{ turnId: "a", estimatedCost: 0.1 }])] });
    assert.strictEqual(r.status, "local-only");
  });

  it("attaches the key's all-time spend from GET /key", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { usage: 12.5, limit: null } }), { status: 200 })) as unknown as typeof fetch;
    const r = await reconcileWithOpenRouter({
      localCost: 0.1,
      sessions: [session([{ turnId: "a", estimatedCost: 0.1, confirmedCost: 0.1 }])],
      apiKey: "sk-or-test-key-123456",
      fetchImpl,
    });
    assert.strictEqual(r.keyAllTimeSpend, 12.5);
  });
});
