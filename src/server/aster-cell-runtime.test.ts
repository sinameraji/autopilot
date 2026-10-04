import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsterHotcellRuntime } from "./aster-cell-runtime.js";
import type { HotcellProvider } from "./hotcell-provider.js";
import type { AsterTurnStart } from "./aster-api.js";

const CONTROL_PREFIX = "node --input-type=module";

interface FakeCellState {
  id: string;
  files: Map<string, string>;
  processes: Array<{ command: string; status: string }>;
  sessions: string[];
  prompts: Array<{ id: string; message: string }>;
  aborts: number;
  events: Array<{ cursor: number; runId: string | null; event: Record<string, unknown> }>;
  destroyed: boolean;
  paused: number;
  started: number;
}

function fakeSandbox(state: FakeCellState) {
  const exec = async (command: string) => {
    if (command.startsWith("test -f ")) {
      return { exitCode: state.files.has(command.slice("test -f ".length)) ? 0 : 1, stdout: "", stderr: "", success: true };
    }
    if (command.startsWith(CONTROL_PREFIX)) {
      const requestId = command.trim().split(" ").pop()!;
      const raw = state.files.get(`/workspace/.aster/control/${requestId}.json`);
      state.files.delete(`/workspace/.aster/control/${requestId}.json`);
      if (!raw) return { exitCode: 1, stdout: JSON.stringify({ error: "missing_request" }), stderr: "", success: false };
      const request = JSON.parse(raw) as { method: string; path: string; body?: Record<string, unknown> };
      const respond = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) + "\n", stderr: "", success: true });
      if (request.method === "GET" && request.path === "/health") {
        return respond(state.processes.some((proc) => proc.status === "running") ? { ok: true } : { error: "not_ready" });
      }
      if (request.method === "GET" && request.path.startsWith("/events?after=")) {
        const after = Number(request.path.slice("/events?after=".length));
        return respond({ events: state.events.filter((entry) => entry.cursor > after), cursor: state.events.at(-1)?.cursor ?? 0, hasMore: false });
      }
      if (request.method === "POST" && request.path === "/rpc") {
        const body = request.body!;
        if (body.type === "new_session") { state.sessions.push(String(body.sessionId)); return respond({ type: "ok", id: body.id }); }
        if (body.type === "prompt") {
          state.prompts.push({ id: String(body.id), message: String(body.message) });
          queueMicrotask(() => {
            state.events.push({ cursor: state.events.length + 1, runId: String(body.id), event: { type: "message.delta", text: "cell reply" } });
            state.events.push({ cursor: state.events.length + 1, runId: String(body.id), event: { type: "session.end", reason: "complete" } });
          });
          return respond({ type: "ok", id: body.id });
        }
        if (body.type === "abort") {
          state.aborts++;
          state.events.push({ cursor: state.events.length + 1, runId: null, event: { type: "session.end", reason: "aborted" } });
          return respond({ type: "ok", id: body.id });
        }
      }
      return { exitCode: 1, stdout: JSON.stringify({ error: "unsupported" }), stderr: "", success: false };
    }
    if (command.startsWith("base64 -d ")) return { exitCode: 0, stdout: "", stderr: "", success: true };
    if (command.startsWith("rm -f ")) {
      state.files.set("/workspace/.aster/.seeded", "1");
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    }
    if (command.startsWith("mkdir -p ") || command.startsWith("npm install ")) {
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    }
    return { exitCode: 0, stdout: "", stderr: "", success: true };
  };
  return {
    getInfo: () => ({ id: state.id }),
    exec,
    writeFile: async (path: string, content: string) => { state.files.set(path, content); },
    readFile: async (path: string) => {
      const value = state.files.get(path);
      if (value === undefined) throw new Error("not found");
      return value;
    },
    mkdir: async () => {},
    listProcesses: async () => state.processes.map((proc, index) => ({ ...proc, procId: `proc-${index}`, pid: 1, exitCode: null, startedAt: "", logPath: "" })),
    startProcess: async (command: string) => {
      state.processes.push({ command, status: "running" });
      return { procId: `proc-${state.processes.length}`, pid: 1, command, status: "running" as const, exitCode: null, startedAt: "", logPath: "" };
    },
    destroy: async () => { state.destroyed = true; },
    pause: async () => { state.paused++; },
    start: async () => { state.started++; },
    listEgressTokens: async () => ({ tokens: [], providers: [] }),
    revokeEgressToken: async () => {},
  };
}

function fakeProvider(cells: Map<string, FakeCellState>): HotcellProvider {
  let next = 0;
  return {
    findConversationCell: async (conversationId: string) => {
      const state = cells.get(conversationId);
      return state ? fakeSandbox(state) : undefined;
    },
    createConversationCell: async (input: { conversationId: string }) => {
      const existing = cells.get(input.conversationId);
      if (existing) return fakeSandbox(existing);
      const state: FakeCellState = {
        id: `fake-cell-${++next}`,
        files: new Map(), processes: [], sessions: [], prompts: [], aborts: 0, events: [],
        destroyed: false, paused: 0, started: 0,
      };
      cells.set(input.conversationId, state);
      return fakeSandbox(state);
    },
    getCell: async (cellId: string) => {
      for (const state of cells.values()) if (state.id === cellId) return fakeSandbox(state) as never;
      throw new Error("cell not found");
    },
    destroyConversationCell: async (cellId: string) => {
      for (const [key, state] of cells) if (state.id === cellId) { state.destroyed = true; cells.delete(key); }
    },
    pauseConversationCell: async (cellId: string) => {
      for (const state of cells.values()) if (state.id === cellId) state.paused++;
    },
    resumeConversationCell: async (cellId: string) => {
      for (const state of cells.values()) if (state.id === cellId) state.started++;
    },
  } as unknown as HotcellProvider;
}

function fakeTurn(overrides: Partial<AsterTurnStart>): AsterTurnStart & { events: Array<{ type: string }>; finished: string[]; cursors: number[] } {
  const events: Array<{ type: string }> = [];
  const finished: string[] = [];
  const cursors: number[] = [];
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    conversation: { id: "conv", sessionId: "session" } as never,
    cellId: "cell",
    cellEventCursor: 0,
    userText: "hello cell",
    sessionFile: { messages: [] } as never,
    messages: [],
    executor: {} as never,
    allowedTools: new Set(),
    maxToolIterations: null,
    maxRuntimeMs: null,
    askPermission: async () => "deny",
    publishEvent: (type) => { events.push({ type }); },
    onCellCursor: (cursor) => { cursors.push(cursor); },
    finish: (status) => { finished.push(status); },
    events,
    finished,
    cursors,
    ...overrides,
  };
}

describe("Aster Hotcell runtime", () => {
  it("provisions distinct cells per conversation, adopts on retry, and reuses the seeded workspace", async () => {
    const cells = new Map<string, FakeCellState>();
    const runtime = new AsterHotcellRuntime(fakeProvider(cells), { archiveWorkspace: async () => "QUJD" });

    const base = { sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo", model: "test/model", allowCreate: true, onCellCreated: () => {} };
    const first = await runtime.provisionConversation({ conversationId: crypto.randomUUID(), ...base });
    const second = await runtime.provisionConversation({ conversationId: crypto.randomUUID(), ...base });
    assert.notEqual(first.cellId, second.cellId);

    const conversationId = crypto.randomUUID();
    let recordedId: string | undefined;
    const created = await runtime.provisionConversation({ conversationId, ...base, onCellCreated: (id) => { recordedId = id; } });
    assert.equal(recordedId, created.cellId);
    const state = [...cells.values()].find((cell) => cell.id === created.cellId)!;
    assert.deepEqual(state.sessions, ["s-1"]);
    assert.equal(state.processes.filter((proc) => proc.command.includes("startAsterCellBridge")).length, 1);

    // A retry after a create attempt adopts by label and never starts a second bridge or reseeds.
    const retried = await runtime.provisionConversation({ conversationId, ...base, allowCreate: false, onCellCreated: () => {} });
    assert.equal(retried.cellId, created.cellId);
    assert.deepEqual(state.sessions, ["s-1", "s-1"]); // new_session is idempotent in the bridge
    assert.equal(state.processes.length, 1);
    assert.ok(!state.prompts.some((prompt) => prompt.message.length > 0)); // provisioning never sends prompts
  });

  it("maps cell events to Aster events, advances the cursor, and finishes completed turns", async () => {
    const cells = new Map<string, FakeCellState>();
    const provider = fakeProvider(cells);
    const runtime = new AsterHotcellRuntime(provider, { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const conversationId = crypto.randomUUID();
    const { cellId } = await runtime.provisionConversation({
      conversationId, sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    const turn = fakeTurn({ cellId });
    runtime.startTurn(turn);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = [...cells.values()][0]!;
    assert.deepEqual(state.prompts, [{ id: turn.runId, message: "hello cell" }]);
    assert.ok(turn.events.some((event) => event.type === "assistant.delta"));
    assert.deepEqual(turn.finished, ["completed"]);
    assert.deepEqual(turn.cursors, [1, 2]);
  });

  it("cancels an active turn with an in-cell abort and completes pause/resume/destroy through the provider", async () => {
    const cells = new Map<string, FakeCellState>();
    const provider = fakeProvider(cells);
    const runtime = new AsterHotcellRuntime(provider, { archiveWorkspace: async () => "QUJD", pollIntervalMs: 5 });
    const conversationId = crypto.randomUUID();
    const { cellId } = await runtime.provisionConversation({
      conversationId, sessionId: "s-1", cellName: "aster-1", workspaceId: "default", workspaceRoot: "/tmp/repo",
      model: "test/model", allowCreate: true, onCellCreated: () => {},
    });
    const turn = fakeTurn({ cellId, runId: crypto.randomUUID() });
    runtime.startTurn(turn);
    runtime.cancelRun(turn.runId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = [...cells.values()][0]!;
    assert.equal(state.aborts, 1);
    assert.deepEqual(turn.finished, ["cancelled"]);

    await runtime.pauseCell(cellId);
    await runtime.resumeCell(cellId);
    assert.equal(state.paused, 1);
    assert.equal(state.started, 1);
    await runtime.destroyCell(cellId);
    assert.equal(state.destroyed, true);
  });
});
