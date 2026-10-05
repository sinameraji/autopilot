import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Sandbox } from "@hotcell/sdk";
import { getAppVersion } from "../util/version.js";
import type { AsterApiRuntime, AsterTurnStart } from "./aster-api.js";
import type { HotcellProvider } from "./hotcell-provider.js";
import { redactLikelySecrets } from "./aster-tools.js";

const execFileAsync = promisify(execFile);

const CELL_WORKSPACE = "/workspace";
const CELL_STATE_DIR = "/workspace/.aster";
const CHECKPOINT_MESSAGE_FILE = `${CELL_STATE_DIR}/checkpoint-message`;
const INSTALLED_RUNTIME_PACKAGE = "/opt/autopilot/node_modules/autopilot-ai/package.json";
// Fixed identity and no signing so commits never depend on cell-local git config.
const GIT = `git -C ${CELL_WORKSPACE} -c user.name=Autopilot -c user.email=autopilot@aster.invalid -c commit.gpgsign=false`;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 2_000;
const MAX_CHECKPOINTS = 100;
const CELL_CONTROL_DIR = `${CELL_STATE_DIR}/control`;
const BRIDGE_MARKER = "startAsterCellBridge";
const CONTROL_RUNNER =
  `node --input-type=module -e ` +
  `'import { executeAsterCellControl } from "/opt/autopilot/node_modules/autopilot-ai/dist/sdk/index.js";` +
  `const r = await executeAsterCellControl(process.argv[1]);` +
  `process.stdout.write(JSON.stringify(r) + "\\n");'`;
const BRIDGE_RUNNER =
  `node --input-type=module -e ` +
  `'import { startAsterCellBridge } from "/opt/autopilot/node_modules/autopilot-ai/dist/sdk/index.js"; void startAsterCellBridge()'`;

const HEALTH_TIMEOUT_MS = 30_000;
const EVENT_POLL_MS = 400;

export interface AsterHotcellRuntimeOptions {
  /** npm spec installed inside the cell; defaults to the currently running server version. */
  autopilotPackageSpec?: string;
  /** Injected for tests: archive a workspace Git tree as base64 tar. */
  archiveWorkspace?: (workspaceRoot: string) => Promise<string>;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
}

export interface AsterCheckpoint {
  id: string;
  message: string;
  createdAt: string;
}

/**
 * AsterApiRuntime backed by one Hotcell per conversation. The provider credentials
 * never enter the cell: model egress goes through Hotcell's OpenRouter credential
 * gateway, scoped to the conversation's model. Only structured SDK events and
 * bounded control payloads leave the cell; prompts and file contents never appear
 * in exec commands or Hotcell logs.
 */
export class AsterHotcellRuntime implements AsterApiRuntime {
  private readonly packageSpec: string;
  private readonly archiveWorkspace: (workspaceRoot: string) => Promise<string>;
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly activeRuns = new Map<string, { cellId: string; stop: () => void }>();
  /** One-shot notes for the agent's next prompt, e.g. after the user restored a checkpoint. */
  private readonly pendingNotes = new Map<string, string>();

  constructor(
    private readonly provider: HotcellProvider,
    options: AsterHotcellRuntimeOptions = {},
  ) {
    this.packageSpec = options.autopilotPackageSpec ?? `autopilot-ai@${getAppVersion()}`;
    this.archiveWorkspace = options.archiveWorkspace ?? defaultArchiveWorkspace;
    this.pollIntervalMs = options.pollIntervalMs ?? EVENT_POLL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  }

  async provisionConversation(input: {
    conversationId: string;
    sessionId: string;
    cellName: string;
    workspaceId: string;
    workspaceRoot: string;
    model: string;
    allowCreate: boolean;
    onCellCreated: (cellId: string) => void;
  }): Promise<{ cellId: string }> {
    let cell = await this.provider.findConversationCell(input.conversationId);
    if (!cell) {
      if (!input.allowCreate) throw new Error("hotcell_create_uncertain");
      cell = await this.provider.createConversationCell({
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        model: input.model,
      });
    }
    input.onCellCreated(cell.getInfo().id);

    await this.seedWorkspace(cell, input.workspaceRoot);
    await this.ensureRepository(cell);
    await this.installRuntime(cell);
    await this.ensureBridge(cell);
    await this.control(cell, "POST", "/rpc", {
      id: randomUUID(),
      type: "new_session",
      sessionId: input.sessionId,
      config: { model: input.model, cwd: CELL_WORKSPACE },
    });
    return { cellId: cell.getInfo().id };
  }

  async destroyCell(cellId: string): Promise<void> {
    await this.provider.destroyConversationCell(cellId);
  }

  async pauseCell(cellId: string): Promise<void> {
    await this.provider.pauseConversationCell(cellId);
  }

  async resumeCell(cellId: string): Promise<void> {
    await this.provider.resumeConversationCell(cellId);
  }

  /** Switch the cell session's model between turns. The bridge persists it for session restore. */
  async setModel(cellId: string, model: string): Promise<void> {
    await this.ensureReady(cellId);
    await this.controlById(cellId, "POST", "/rpc", { id: randomUUID(), type: "set_model", modelId: model });
  }

  /** Reinstall the runtime if the cell's image lost it and restart the bridge if it isn't running. */
  private async ensureReady(cellId: string): Promise<void> {
    const cell = await this.provider.getCell(cellId);
    await this.installRuntime(cell);
    await this.ensureBridge(cell);
  }

  /** Newest-first git history of the cell workspace; one commit per completed turn. */
  async listCheckpoints(cellId: string): Promise<AsterCheckpoint[]> {
    const cell = await this.provider.getCell(cellId);
    if (!(await this.ensureRepository(cell))) return [];
    const result = await cell.exec(`${GIT} log -n ${MAX_CHECKPOINTS} --format=%H%x1f%cI%x1f%s`);
    if (result.exitCode !== 0) return [];
    return result.stdout.split("\n").filter(Boolean).map((line) => {
      const [id = "", createdAt = "", message = ""] = line.split("\x1f");
      return { id, createdAt, message };
    });
  }

  /**
   * Make the workspace match a checkpoint, recorded as a new commit so the restore
   * itself can be undone. Ignored files (node_modules, .aster state) are untouched.
   */
  async restoreCheckpoint(cellId: string, conversationId: string, checkpointId: string): Promise<AsterCheckpoint> {
    if (!COMMIT_SHA_RE.test(checkpointId)) throw new Error("invalid_checkpoint");
    const cell = await this.provider.getCell(cellId);
    if (!(await this.ensureRepository(cell))) throw new Error("checkpoints_unavailable");
    const exists = await cell.exec(`${GIT} cat-file -e ${checkpointId}^{commit}`);
    if (exists.exitCode !== 0) throw new Error("checkpoint_not_found");
    const short = checkpointId.slice(0, 7);
    await cell.writeFile(CHECKPOINT_MESSAGE_FILE, `Restore checkpoint ${short}\n`);
    const restore = await cell.exec(
      `${GIT} restore --source=${checkpointId} --staged --worktree -- :/ && ${GIT} clean -fdq && ` +
      `${GIT} commit -q --allow-empty -F ${CHECKPOINT_MESSAGE_FILE}`,
    );
    if (restore.exitCode !== 0) throw new Error("checkpoint_restore_failed");
    this.pendingNotes.set(
      conversationId,
      `[The user restored the workspace to checkpoint ${short}. Files changed after that point were reverted; re-read files before relying on earlier observations.]`,
    );
    const [head] = await this.listCheckpoints(cellId);
    if (!head) throw new Error("checkpoint_restore_failed");
    return head;
  }

  startTurn(turn: AsterTurnStart): void {
    void this.runTurn(turn).catch(() => {
      turn.finish("failed", "cell_runtime_error");
    });
  }

  cancelRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.stop();
    void this.controlById(active.cellId, "POST", "/rpc", { id: randomUUID(), type: "abort" }).catch(() => {});
  }

  private async runTurn(turn: AsterTurnStart): Promise<void> {
    const { cellId, runId } = turn;
    let cursor = turn.cellEventCursor;
    let stopped = false;
    let finished = false;
    this.activeRuns.set(runId, { cellId, stop: () => { stopped = true; } });

    const finish = (status: "completed" | "failed" | "cancelled", reason?: string) => {
      if (finished) return;
      finished = true;
      stopped = true;
      this.activeRuns.delete(runId);
      turn.finish(status, reason);
    };
    let outcome: { status: "completed" | "failed" | "cancelled"; reason: string } | undefined;

    const note = this.pendingNotes.get(turn.conversation.id);
    const message = note ? `${note}\n\n${turn.userText}` : turn.userText;
    try {
      // An idle cell may have been paused (cold-stopped on the container driver):
      // make sure the runtime and bridge are back before prompting.
      await this.ensureReady(cellId);
      await this.controlById(cellId, "POST", "/rpc", { id: runId, type: "prompt", message });
      this.pendingNotes.delete(turn.conversation.id);
    } catch {
      finish("failed", "cell_prompt_rejected");
      return;
    }

    while (!stopped) {
      await sleep(this.pollIntervalMs);
      if (stopped) break;
      let events: Array<{ cursor: number; runId: string | null; event: Record<string, unknown> }>;
      try {
        const page = await this.controlById(cellId, "GET", `/events?after=${cursor}`) as {
          events?: Array<{ cursor: number; runId: string | null; event: Record<string, unknown> }>;
        };
        events = page.events ?? [];
      } catch {
        continue; // transient cell-control failure; keep polling until stopped or finished
      }
      for (const entry of events) {
        cursor = Math.max(cursor, entry.cursor);
        turn.onCellCursor?.(cursor);
        const event = entry.event;
        switch (event.type) {
          case "message.delta":
            if (typeof event.text === "string") turn.publishEvent("assistant.delta", { text: event.text });
            break;
          case "message.reasoning":
            if (typeof event.text === "string") turn.publishEvent("assistant.reasoning", { text: event.text });
            break;
          case "tool.start":
            turn.publishEvent("tool.activity", {
              tool: event.toolName,
              toolCallId: event.toolCallId,
              activity: "started",
              input: summarizeToolInput(event.toolName, event.args),
            });
            break;
          case "tool.result":
            turn.publishEvent("tool.activity", {
              tool: event.toolName,
              toolCallId: event.toolCallId,
              activity: event.isError === true ? "failed" : "completed",
              output: boundedToolText(typeof event.result === "string" ? event.result : "", MAX_TOOL_OUTPUT_CHARS),
            });
            break;
          case "permission.request": {
            // Cells run in auto mode, so this only fires if a prompt somehow ran in another mode.
            const decision = await turn.askPermission({
              tool: { name: event.toolName },
              args: (event.args as Record<string, unknown>) ?? {},
            } as never);
            await this.controlById(cellId, "POST", "/rpc", {
              id: randomUUID(),
              type: "resolve_permission",
              requestId: event.requestId,
              decision,
            }).catch(() => {});
            turn.publishEvent("tool.activity", { tool: event.toolName, activity: decision === "allow" ? "approved" : "rejected" });
            break;
          }
          case "usage":
            turn.publishEvent("usage", { usage: event.usage });
            break;
          case "session.end":
            outcome = {
              status: event.reason === "aborted" ? "cancelled" : event.reason === "complete" ? "completed" : "failed",
              // Surface the agent's actual error (redacted, bounded) instead of a bare "error".
              reason: event.reason === "error" && typeof event.error === "string" && event.error.trim()
                ? boundedToolText(event.error.trim(), 500)
                : String(event.reason ?? "cell_session_ended"),
            };
            stopped = true;
            break;
          default:
            break;
        }
        if (outcome) break;
      }
    }
    // Checkpoint whatever the turn left behind (even partial work from a cancel or
    // failure) before reporting the terminal state, so the client can roll back.
    await this.checkpoint(cellId, turn.userText)
      .then((checkpoint) => { if (checkpoint) turn.publishEvent("checkpoint.created", { ...checkpoint }); })
      .catch(() => {});
    finish(outcome?.status ?? "cancelled", outcome?.reason ?? "cell_turn_stopped");
  }

  private async seedWorkspace(cell: Sandbox, workspaceRoot: string): Promise<void> {
    const seeded = await cell.exec(`test -f ${CELL_STATE_DIR}/.seeded`);
    if (seeded.exitCode === 0) return;
    await cell.mkdir(CELL_STATE_DIR, { parents: true });
    const archive = await this.archiveWorkspace(workspaceRoot);
    await cell.writeFile(`${CELL_STATE_DIR}/workspace.tar.b64`, archive);
    const extract = await cell.exec(`base64 -d ${CELL_STATE_DIR}/workspace.tar.b64 | tar -x -C ${CELL_WORKSPACE}`);
    if (extract.exitCode !== 0) throw new Error("workspace_seed_failed");
    await cell.exec(`rm -f ${CELL_STATE_DIR}/workspace.tar.b64 && touch ${CELL_STATE_DIR}/.seeded`);
  }

  /**
   * Make /workspace a git repository with an initial commit (idempotent), excluding the
   * bridge's private .aster state. Returns false when the cell image has no git, in
   * which case checkpoints are skipped rather than failing the conversation.
   */
  private async ensureRepository(cell: Sandbox): Promise<boolean> {
    const result = await cell.exec(
      `command -v git >/dev/null || exit 3; ` +
      `if [ ! -d ${CELL_WORKSPACE}/.git ]; then git init -q ${CELL_WORKSPACE} || exit 1; fi; ` +
      `grep -qx '.aster/' ${CELL_WORKSPACE}/.git/info/exclude 2>/dev/null || printf '.aster/\\n' >> ${CELL_WORKSPACE}/.git/info/exclude; ` +
      `${GIT} rev-parse -q --verify HEAD >/dev/null || { ${GIT} add -A && ${GIT} commit -q --allow-empty -m 'Workspace created'; }`,
    );
    return result.exitCode === 0;
  }

  /** Commit all workspace changes; returns the new checkpoint, or undefined when nothing changed. */
  private async checkpoint(cellId: string, userText: string): Promise<AsterCheckpoint | undefined> {
    const cell = await this.provider.getCell(cellId);
    if (!(await this.ensureRepository(cell))) return undefined;
    // The prompt goes through a 0600 file, never the exec command line.
    await cell.writeFile(CHECKPOINT_MESSAGE_FILE, checkpointMessage(userText), { mode: "0600" });
    const commit = await cell.exec(
      `${GIT} add -A && if ${GIT} diff --cached --quiet; then exit 4; fi && ${GIT} commit -q -F ${CHECKPOINT_MESSAGE_FILE}`,
    );
    if (commit.exitCode !== 0) return undefined;
    const [head] = await this.listCheckpoints(cellId);
    return head;
  }

  /**
   * Install the Autopilot runtime unless the cell already has the expected version. This
   * checks the installed package itself rather than a marker on the persistent volume:
   * /opt lives in the cell's root filesystem, which a container-driver pause discards,
   * while an image with the runtime baked in skips the install entirely.
   */
  private async installRuntime(cell: Sandbox): Promise<void> {
    const expectedVersion = /@(\d[^@/]*)$/.exec(this.packageSpec)?.[1];
    try {
      const installed = JSON.parse(await cell.readFile(INSTALLED_RUNTIME_PACKAGE)) as { version?: string };
      if (!expectedVersion || installed.version === expectedVersion) return;
    } catch { /* not installed in this root filesystem */ }
    const install = await cell.exec(`mkdir -p /opt/autopilot && npm install --prefix /opt/autopilot --no-audit --no-fund ${this.packageSpec}`);
    if (install.exitCode !== 0) throw new Error("cell_runtime_install_failed");
  }

  private async ensureBridge(cell: Sandbox): Promise<void> {
    const processes = await cell.listProcesses().catch(() => []);
    const running = processes.find((proc) => proc.status === "running" && proc.command.includes(BRIDGE_MARKER));
    if (!running) {
      await cell.mkdir(CELL_CONTROL_DIR, { parents: true });
      await cell.startProcess(BRIDGE_RUNNER, { cwd: "/opt/autopilot", env: { HOME: `${CELL_STATE_DIR}/home` } });
    }
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      try {
        const health = await this.control(cell, "GET", "/health") as { ok?: boolean; initialized?: boolean; sessionId?: string | null };
        // A restarted bridge restores its saved session asynchronously; wait for that
        // so the next prompt isn't rejected as session_not_ready.
        if (health.ok === true && (!health.sessionId || health.initialized === true)) return;
      } catch { /* bridge not listening yet */ }
      if (Date.now() > deadline) throw new Error("cell_bridge_unhealthy");
      await sleep(250);
    }
  }

  private async control(cell: Sandbox, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const requestId = randomUUID();
    await cell.mkdir(CELL_CONTROL_DIR, { parents: true });
    await cell.writeFile(`${CELL_CONTROL_DIR}/${requestId}.json`, JSON.stringify({ method, path, body }), { mode: "0600" });
    const result = await cell.exec(`${CONTROL_RUNNER} ${requestId}`);
    if (result.exitCode !== 0) throw new Error("cell_control_failed");
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as { error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  }

  private async controlById(cellId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const cell = await this.provider.getCell(cellId);
    return this.control(cell, method, path, body);
  }
}

async function defaultArchiveWorkspace(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "archive", "--format=tar", "HEAD"], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  return Buffer.from(stdout).toString("base64");
}

function checkpointMessage(userText: string): string {
  const firstLine = redactLikelySecrets(userText).split("\n").find((line) => line.trim())?.trim() ?? "Turn";
  const subject = firstLine.length > 72 ? firstLine.slice(0, 71) + "…" : firstLine;
  return `${subject}\n`;
}

/** A short, redacted description of what a tool was asked to do (the shell command, the file path, …). */
function summarizeToolInput(toolName: unknown, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const preferred = toolName === "bash" ? record.command : record.path ?? record.pattern ?? record.url ?? record.query;
  const text = typeof preferred === "string" ? preferred : JSON.stringify(args ?? {});
  return boundedToolText(text, MAX_TOOL_INPUT_CHARS);
}

/** Redact and bound tool text, keeping the head and tail (where errors usually are). */
function boundedToolText(text: string, limit: number): string {
  const redacted = redactLikelySecrets(text);
  if (redacted.length <= limit) return redacted;
  const half = Math.floor((limit - 40) / 2);
  return `${redacted.slice(0, half)}\n… [${redacted.length - 2 * half} characters omitted] …\n${redacted.slice(-half)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
