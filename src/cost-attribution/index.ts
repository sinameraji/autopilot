/**
 * Public API for cost attribution.
 */

export { classifySession, classifyTurn, needsLlmFallback } from "./heuristic.js";
export { buildReport } from "./report.js";
export { renderTerminal, renderJson } from "./renderer.js";
export { gitDiffSummary } from "./git-diff.js";
export { classifyWithLlm } from "./llm-classifier.js";
export { reconcileWithOpenRouter } from "./reconcile.js";
export type {
  TaskCategory,
  TaskCategorization,
  CategoryPeriod,
  CategoryReportEntry,
  TopSessionEntry,
  ReconciliationResult,
  CostAttributionReport,
  SignalEntry,
} from "./types.js";
export { ALL_CATEGORIES } from "./types.js";
