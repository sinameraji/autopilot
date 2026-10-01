/**
 * The contract between the App (all of autopilot's interactive logic) and an
 * alternative view such as the Camouflage renderer.
 *
 * With a bridge, App runs exactly as it does under Ink (same state, managers,
 * slash commands, turn handling) but renders nothing itself. After every
 * render it reports a snapshot of what's on screen via `sync`, and it hands
 * the view a set of actions (submit text, interrupt, answer a picker) via
 * `connect`. The view decides how to draw the snapshot and when to call the
 * actions. Anything added to App later reaches the view without changes here.
 */

import type { ChatEvent } from "./chat.js";
import type { Mode } from "../mode.js";
import type { Usage } from "../agent/messages.js";
import type { DailyUsage } from "../usage-tracker.js";
import type { Task } from "../tools/registry.js";
import type { ModelEntry } from "../models/registry.js";
import type { SessionSummary, Checkpoint } from "../sessions.js";
import type { PlanOption } from "../tools/registry.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";
import type { PlanCompleteChoice } from "./plan-complete-picker.js";

/** Which Ink dialog App currently wants open. */
export type AppModal =
  | "model"
  | "mode"
  | "theme"
  | "ui"
  | "help"
  | "memory"
  | "skills"
  | "shell"
  | "planComplete"
  | "commandList"
  | "commandWizard"
  | "commandPicker"
  | "lspWizard"
  | "remoteDashboard"
  | "inbox"
  | "multiAgent"
  | "hooksDashboard"
  | "changelogImage";

export interface AppSnapshot {
  events: ChatEvent[];
  busy: boolean;
  mode: Mode;
  model: string;
  usage: Usage | null;
  sessionUsage: DailyUsage | null;
  tasks: Task[];
  /** A tool waiting for the user's permission. */
  permission: { tool: PermissionRequest["tool"]; args: Record<string, unknown> } | null;
  /** Open dialogs, in App's own terms. */
  modals: AppModal[];
  resumeSessions: SessionSummary[] | null;
  checkpoints: { session: SessionSummary; list: Checkpoint[] } | null;
  planOptions: PlanOption[] | null;
  /** The user's custom slash commands, for the `/` picker. */
  customCommands: { name: string; description?: string }[];
}

export interface AppActions {
  /** Submit typed text exactly as the Ink prompt would (slash commands,
   *  `!` commands, queueing while busy, custom commands). */
  submit: (text: string) => void;
  /** Esc: interrupt the running turn. */
  interrupt: () => void;
  /** Shift+Tab. */
  cycleMode: () => void;
  decidePermission: (decision: PermissionDecision) => void;
  pickModel: (model: ModelEntry | null) => void;
  pickMode: (mode: Mode | null) => void;
  pickResume: (session: SessionSummary | null) => void;
  pickCheckpoint: (checkpointId: string | null) => void;
  pickPlanOption: (option: PlanOption | null) => void;
  pickPlanComplete: (choice: PlanCompleteChoice | null) => void;
  /** Close a dialog the view can't show. */
  closeModal: (modal: AppModal) => void;
  /** Run a slash command (e.g. from a dialog). */
  runCommand: (command: string) => void;
  exit: () => void;
}

export interface AppBridge {
  sync(snapshot: AppSnapshot): void;
  connect(actions: AppActions): void;
}
