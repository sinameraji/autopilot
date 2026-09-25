/**
 * Terminal + JSON output for cost attribution reports.
 */

import type { CostAttributionReport, CategoryReportEntry, TaskCategory } from "./types.js";

function fmtCost(n: number): string {
  return n === 0 ? "$0.00" : `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function arrow(changePct: number): string {
  if (changePct > 5) return "↑";
  if (changePct < -5) return "↓";
  return "→";
}

function pad(str: string, width: number): string {
  return str.padEnd(width).slice(0, width);
}

function padLeft(str: string, width: number): string {
  return str.padStart(width).slice(-width);
}

function categoryLabel(cat: TaskCategory): string {
  return cat;
}

export function renderTerminal(report: CostAttributionReport): string {
  const lines: string[] = [];
  const catWidth = 22;
  const numWidth = 12;
  const arrWidth = 3;
  const totalWidth = catWidth + 1 + numWidth + 1 + numWidth + 1 + arrWidth;

  lines.push(`Period: ${report.period.start} → ${report.period.end}`);
  lines.push("");

  // Header
  lines.push(
    `${pad("Category", catWidth)} ${padLeft("This period", numWidth)} ${padLeft("Last period", numWidth)} ${pad("", arrWidth)}`,
  );
  lines.push("─".repeat(totalWidth));

  let totalThis = 0;
  let totalLast = 0;

  for (const entry of report.categories) {
    totalThis += entry.thisPeriod.cost;
    totalLast += entry.lastPeriod.cost;
    const label = pad(categoryLabel(entry.category), catWidth);
    const thisStr = padLeft(fmtCost(entry.thisPeriod.cost), numWidth);
    const lastStr = padLeft(fmtCost(entry.lastPeriod.cost), numWidth);
    const arr = pad(arrow(entry.changePct), arrWidth);
    lines.push(`${label} ${thisStr} ${lastStr} ${arr}`);
  }

  lines.push("─".repeat(totalWidth));
  lines.push(
    `${pad("Total", catWidth)} ${padLeft(fmtCost(totalThis), numWidth)} ${padLeft(fmtCost(totalLast), numWidth)} ${pad("", arrWidth)}`,
  );

  if (report.topSessions.length > 0) {
    lines.push("");
    lines.push("Top sessions this period:");
    for (const s of report.topSessions) {
      const day = new Date(s.date).toLocaleDateString("en-US", { weekday: "short" });
      const cat = s.category;
      const sum = s.summary ? ` — ${s.summary}` : "";
      const cur = s.isCurrentSession ? " (current)" : "";
      lines.push(`  ${fmtCost(s.cost).padStart(6)}  ${day}  ${cat}${sum}${cur}`);
    }
  }



  // Reconciliation line
  lines.push("");
  const rec = report.reconciliation;
  switch (rec.status) {
    case "verified":
      lines.push(`Verified against OpenRouter: ✓ (within ${rec.driftPct?.toFixed(1) ?? "0"}%)`);
      break;
    case "drift":
      lines.push(
        `Verified against OpenRouter: ✗ (drift ${rec.driftPct?.toFixed(1) ?? "?"}%)` +
          (rec.message ? ` — ${rec.message}` : ""),
      );
      break;
    case "error":
      lines.push(`OpenRouter reconciliation: ⚠ ${rec.message ?? "API error"}`);
      break;
    case "local-only":
      lines.push(`Local-only report (OpenRouter reconciliation skipped${rec.message ? `: ${rec.message}` : ""}).`);
      break;
  }
  if (typeof rec.keyAllTimeSpend === "number") {
    lines.push(`OpenRouter key spend (all time): ${fmtCost(rec.keyAllTimeSpend)}`);
  }

  return lines.join("\n");
}

export function renderJson(report: CostAttributionReport): string {
  return JSON.stringify(report, null, 2);
}
