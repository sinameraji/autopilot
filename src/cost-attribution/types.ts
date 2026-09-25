/**
 * Cost attribution types — literal task categories derived from observable actions.
 */

export type TaskCategory =
  | "reading-source-code"
  | "reading-documentation"
  | "reading-configuration"
  | "reading-web-content"
  | "reading-data"
  | "reading-logs-output"
  | "writing-source-code"
  | "writing-documentation"
  | "writing-configuration"
  | "writing-tests"
  | "editing-source-code"
  | "editing-documentation"
  | "editing-configuration"
  | "running-tests"
  | "running-git-commands"
  | "running-build-scripts"
  | "running-deploy-commands"
  | "running-shell-commands"
  | "searching-code"
  | "searching-web"
  | "exploring-codebase"
  | "other";

export const ALL_CATEGORIES: TaskCategory[] = [
  "reading-source-code",
  "reading-documentation",
  "reading-configuration",
  "reading-web-content",
  "reading-data",
  "reading-logs-output",
  "writing-source-code",
  "writing-documentation",
  "writing-configuration",
  "writing-tests",
  "editing-source-code",
  "editing-documentation",
  "editing-configuration",
  "running-tests",
  "running-git-commands",
  "running-build-scripts",
  "running-deploy-commands",
  "running-shell-commands",
  "searching-code",
  "searching-web",
  "exploring-codebase",
  "other",
];

export interface TaskCategorization {
  category: TaskCategory;
  confidence: number;
  classifiedBy: "heuristic" | "llm" | "user";
  summary?: string;
  tags?: string[];
}

export interface CategoryPeriod {
  cost: number;
  tokens: number;
  sessions: number;
}

export interface CategoryReportEntry {
  category: TaskCategory;
  thisPeriod: CategoryPeriod;
  lastPeriod: CategoryPeriod;
  changePct: number;
}

export interface TopSessionEntry {
  sessionId: string;
  date: string;
  cost: number;
  category: TaskCategory;
  summary?: string;
  isCurrentSession?: boolean;
}

export interface ReconciliationResult {
  status: "verified" | "drift" | "error" | "local-only";
  localCost: number;
  /** Sum of the turn costs OpenRouter confirmed in this range. */
  providerCost?: number;
  /** |estimate − confirmed| / confirmed, in percent, over confirmed turns. */
  driftPct?: number;
  message?: string;
  /** All-time USD spend on the OpenRouter key (GET /key), when fetched. */
  keyAllTimeSpend?: number;
}

export interface CostAttributionReport {
  period: { start: string; end: string };
  categories: CategoryReportEntry[];
  topSessions: TopSessionEntry[];
  reconciliation: ReconciliationResult;
}

export interface SignalEntry {
  category: TaskCategory;
  weight: number; // token usage or tool-call count for this turn
  confidence: number;
}
