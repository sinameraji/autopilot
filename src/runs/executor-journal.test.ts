import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./store.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";

const allow = async () => "allow" as const;

describe("run tool-boundary journal", () => {
  it("writes an intent before execution and a result afterward", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-run-journal-"));
    const dbPath = join(dir, "runs.db");
    const store = new RunStore(dbPath);
    try {
      const run = store.createRun({ task: "Test a journaled tool", cwd: dir });
      store.transition(run.id, "running");
      const tool: ToolSpec = {
        name: "fake_action",
        description: "test action",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        needsPermission: false,
        run: async () => "private tool output",
      };
      const executor = new ToolExecutor([tool]);
      const result = await executor.run(
        { id: "call-1", name: tool.name, arguments: '{"secret":"private input"}' },
        allow,
        { cwd: dir, runId: run.id, runsDbPath: dbPath },
      );

      assert.equal(result.ok, true);
      const events = store.listEvents(run.id);
      assert.deepEqual(events.map((event) => event.type), ["state", "state", "tool_intent", "tool_result"]);
      assert.equal(events[2]!.toolCallId, "call-1");
      assert.equal(events[3]!.metadata.ok, true);
      assert.equal(JSON.stringify(events).includes("private input"), false);
      assert.equal(JSON.stringify(events).includes("private tool output"), false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a failure result when an executed tool throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-run-journal-"));
    const dbPath = join(dir, "runs.db");
    const store = new RunStore(dbPath);
    try {
      const run = store.createRun({ task: "Test a failing tool", cwd: dir });
      store.transition(run.id, "running");
      const tool: ToolSpec = {
        name: "fake_failure",
        description: "test failure",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        needsPermission: false,
        run: async () => { throw new Error("expected tool failure"); },
      };
      const executor = new ToolExecutor([tool]);
      const result = await executor.run(
        { id: "call-fail", name: tool.name, arguments: "{}" },
        allow,
        { cwd: dir, runId: run.id, runsDbPath: dbPath },
      );

      assert.equal(result.ok, false);
      const events = store.listEvents(run.id);
      assert.equal(events.at(-1)?.type, "tool_result");
      assert.equal(events.at(-1)?.metadata.ok, false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
