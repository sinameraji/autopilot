import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWorkerResult, spawnWorkerTool } from "./spawn-worker.js";

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "KIMIFLARE_OPENROUTER_KEY",
  "KIMIFLARE_BASE_URL",
  "KIMIFLARE_API_KEY",
  "REQUESTY_API_KEY",
  "KIMIFLARE_WORKER_BACKEND",
  "KIMIFLARE_WORKER_ENDPOINT",
  "KIMIFLARE_WORKER_API_KEY",
  "KIMI_MODEL",
  "XDG_CONFIG_HOME",
] as const;
const saved: Record<string, string | undefined> = {};
let configHome = "";

before(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  configHome = await mkdtemp(join(tmpdir(), "autopilot-hotcell-tool-test-"));
});

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.XDG_CONFIG_HOME = configHome;
  await rm(join(configHome, "kimiflare"), { recursive: true, force: true });
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(configHome, { recursive: true, force: true });
});

describe("spawnWorkerTool local Hotcell routing", () => {
  it("exposes only read-only plan workers and no remote execution controls", () => {
    const parameters = spawnWorkerTool.parameters as {
      properties: Record<string, { enum?: string[] }>;
    };
    assert.deepEqual(parameters.properties.mode?.enum, ["plan"]);
    assert.ok(!("branchName" in parameters.properties));
    assert.ok(!("tools" in parameters.properties));
  });

  it("ignores legacy remote endpoint settings and reports a provider error", async () => {
    process.env.REQUESTY_API_KEY = "rq-test";
    process.env.KIMIFLARE_WORKER_ENDPOINT = "https://remote-worker.invalid";
    process.env.KIMIFLARE_WORKER_API_KEY = "must-not-be-sent";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("remote worker must never be called");
    }) as typeof fetch;

    await assert.rejects(
      () => spawnWorkerTool.run({ mode: "plan", task: "research" }, { cwd: process.cwd(), model: "openai/gpt-4o-mini" }),
      /Local Hotcell workers require an OpenRouter-backed session/,
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects custom model endpoints rather than falling back to remote workers", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.KIMIFLARE_BASE_URL = "https://custom-model.invalid/v1";
    process.env.KIMIFLARE_API_KEY = "custom-key";
    process.env.KIMIFLARE_WORKER_ENDPOINT = "https://remote-worker.invalid";

    await assert.rejects(
      () => spawnWorkerTool.run({ mode: "plan", task: "research" }, { cwd: process.cwd(), model: "openai/gpt-4o-mini" }),
      /Local Hotcell workers do not support custom model endpoints/,
    );
  });
});

describe("formatWorkerResult", () => {
  const base = {
    workerId: "w1", status: "completed" as const, task: "t", recommendations: [], webSources: [],
    costUsd: 0.0123, tokensUsed: 4567, reasoning: "", model: "openai/gpt-6-luna",
  };

  it("renders cited, structured findings and open questions", () => {
    const text = formatWorkerResult({
      ...base,
      structured: true,
      findings: [{ topic: "Auth", summary: "Refresh in auth.ts", confidence: "high", sources: ["src/auth.ts:42"], relevance: "high" }],
      openQuestions: ["Is the cache shared?"],
      filesRead: ["src/auth.ts"],
    }, "openai/gpt-6-luna");
    assert.match(text, /## Auth \(high confidence\)\nRefresh in auth.ts\nFiles: src\/auth.ts:42/);
    assert.match(text, /## Open questions\n- Is the cache shared\?/);
    assert.match(text, /Files read: src\/auth.ts/);
    assert.doesNotMatch(text, /unverified/);
  });

  it("flags unstructured raw answers", () => {
    const text = formatWorkerResult({
      ...base,
      findings: [{ topic: "Research findings", summary: "raw", confidence: "medium", sources: [], relevance: "high" }],
      filesRead: [],
    }, "openai/gpt-6-luna");
    assert.match(text, /did not return a structured report/);
  });
});
