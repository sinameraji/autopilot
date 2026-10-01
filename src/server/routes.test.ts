import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KimiConfig } from "../config.js";
import { setupRoutes } from "./routes.js";

describe("unattended run HTTP routes", () => {
  it("requires server auth configuration and validates run options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autopilot-run-routes-"));
    const oldRunsDb = process.env.AUTOPILOT_RUNS_DB;
    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldPassword = process.env.KIMIFLARE_SERVER_PASSWORD;
    process.env.AUTOPILOT_RUNS_DB = join(dir, "runs.db");
    process.env.XDG_DATA_HOME = join(dir, "data");
    delete process.env.KIMIFLARE_SERVER_PASSWORD;

    const routes = setupRoutes({} as KimiConfig);
    const server = createServer((req, res) => { void routes.handleRequest(req, res); });
    try {
      const address = await listen(server);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const disabled = await fetch(`${baseUrl}/runs`, { method: "POST", body: "{}" });
      assert.equal(disabled.status, 503);

      process.env.KIMIFLARE_SERVER_PASSWORD = "test-only-password";
      const malformed = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      assert.equal(malformed.status, 400);

      const invalidWorktree = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", worktree: "yes" }),
      });
      assert.equal(invalidWorktree.status, 400);

      const missingWorktreeCwd = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect" }),
      });
      assert.equal(missingWorktreeCwd.status, 400);

      const nonGitCwd = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir }),
      });
      assert.equal(nonGitCwd.status, 400);

      const unknownTool = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, allowedTools: ["unknown_tool"] }),
      });
      assert.equal(unknownTool.status, 400);

      const invalidLimit = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, maxToolIterations: 0 }),
      });
      assert.equal(invalidLimit.status, 400);

      const invalidTokenBudget = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, maxTotalTokens: 0 }),
      });
      assert.equal(invalidTokenBudget.status, 400);

      const invalidCostBudget = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, maxCostUsd: 0 }),
      });
      assert.equal(invalidCostBudget.status, 400);
    } finally {
      routes.cleanup();
      await close(server);
      restoreEnv("AUTOPILOT_RUNS_DB", oldRunsDb);
      restoreEnv("XDG_DATA_HOME", oldDataHome);
      restoreEnv("KIMIFLARE_SERVER_PASSWORD", oldPassword);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function listen(server: Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP server address"));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
