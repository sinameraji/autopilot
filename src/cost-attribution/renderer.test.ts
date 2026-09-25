import { describe, it } from "node:test";
import assert from "node:assert";
import { renderTerminal, renderJson } from "./renderer.js";
import type { CostAttributionReport } from "./types.js";

describe("renderTerminal", () => {
  const baseReport: CostAttributionReport = {
    period: { start: "2026-04-22", end: "2026-04-29" },
    categories: [
      {
        category: "editing-source-code",
        thisPeriod: { cost: 32.1, tokens: 45000, sessions: 12 },
        lastPeriod: { cost: 28.4, tokens: 39000, sessions: 10 },
        changePct: 13.0,
      },
      {
        category: "reading-source-code",
        thisPeriod: { cost: 8.2, tokens: 12000, sessions: 5 },
        lastPeriod: { cost: 14.1, tokens: 21000, sessions: 8 },
        changePct: -41.8,
      },
    ],
    topSessions: [
      { sessionId: "abc", date: "2026-04-28", cost: 5.2, category: "editing-source-code", summary: "cache fix" },
    ],
    reconciliation: { status: "verified", localCost: 40.3, providerCost: 40.5, driftPct: 0.5 },
  };

  it("renders category rows", () => {
    const out = renderTerminal(baseReport);
    assert.ok(out.includes("editing-source-code"));
    assert.ok(out.includes("$32.10"));
    assert.ok(out.includes("↑"));
    assert.ok(out.includes("reading-source-code"));
    assert.ok(out.includes("↓"));
  });

  it("renders total row", () => {
    const out = renderTerminal(baseReport);
    assert.ok(out.includes("Total"));
    assert.ok(out.includes("$40.30"));
  });

  it("renders top sessions", () => {
    const out = renderTerminal(baseReport);
    assert.ok(out.includes("Top sessions"));
    assert.ok(out.includes("cache fix"));
  });

  it("renders reconciliation verified", () => {
    const out = renderTerminal(baseReport);
    assert.ok(out.includes("Verified against OpenRouter: ✓"));
  });

  it("renders reconciliation drift", () => {
    const report: CostAttributionReport = {
      ...baseReport,
      reconciliation: { status: "drift", localCost: 40.3, providerCost: 41.0, driftPct: 1.7 },
    };
    const out = renderTerminal(report);
    assert.ok(out.includes("✗"));
  });

  it("renders reconciliation error", () => {
    const report: CostAttributionReport = {
      ...baseReport,
      reconciliation: { status: "error", localCost: 40.3, message: "timeout" },
    };
    const out = renderTerminal(report);
    assert.ok(out.includes("⚠"));
  });

  it("renders local-only", () => {
    const report: CostAttributionReport = {
      ...baseReport,
      reconciliation: { status: "local-only", localCost: 40.3 },
    };
    const out = renderTerminal(report);
    assert.ok(out.includes("Local-only"));
  });
});

describe("renderJson", () => {
  it("produces valid JSON", () => {
    const report: CostAttributionReport = {
      period: { start: "2026-04-22", end: "2026-04-29" },
      categories: [],
      topSessions: [],
      reconciliation: { status: "local-only", localCost: 0 },
    };
    const out = renderJson(report);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.period.start, "2026-04-22");
  });
});
