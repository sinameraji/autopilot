import { describe, it, afterEach, before, beforeEach, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWorkerEndpoint, spawnWorkerTool } from "./spawn-worker.js";
import type { WorkerResultMessage } from "../agent/messages.js";

const realFetch = globalThis.fetch;

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const sample: WorkerResultMessage = {
  workerId: "w1",
  status: "completed",
  task: "research",
  findings: [],
  recommendations: [],
  filesRead: [],
  webSources: [],
  costUsd: 0,
  tokensUsed: 0,
  reasoning: "",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callWorkerEndpoint", () => {
  it("parses a successful response", async () => {
    globalThis.fetch = (async () => mockResponse(200, sample)) as typeof fetch;
    const out = await callWorkerEndpoint("http://x", undefined, { task: "research" });
    assert.strictEqual(out.workerId, "w1");
  });

  it("retries once on 5xx and succeeds on the second attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? mockResponse(503, "down") : mockResponse(200, sample);
    }) as typeof fetch;
    const out = await callWorkerEndpoint("http://x", undefined, {});
    assert.strictEqual(calls, 2);
    assert.strictEqual(out.workerId, "w1");
  });

  it("throws when both attempts return 5xx", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return mockResponse(500, "boom");
    }) as typeof fetch;
    await assert.rejects(() => callWorkerEndpoint("http://x", undefined, {}), /500/);
    assert.strictEqual(calls, 2);
  });

  it("does not retry on a 4xx error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return mockResponse(400, "bad request");
    }) as typeof fetch;
    await assert.rejects(() => callWorkerEndpoint("http://x", undefined, {}), /400/);
    assert.strictEqual(calls, 1);
  });

  it("sends the API key header when provided", async () => {
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return mockResponse(200, sample);
    }) as unknown as typeof fetch;
    await callWorkerEndpoint("http://x", "secret-key", {});
    assert.strictEqual(seenHeaders["X-Worker-Api-Key"], "secret-key");
  });
});

describe("spawnWorkerTool on a Requesty-only session", () => {
  const ENV_KEYS = [
    "OPENROUTER_API_KEY",
    "KIMIFLARE_OPENROUTER_KEY",
    "KIMIFLARE_BASE_URL",
    "KIMIFLARE_API_KEY",
    "REQUESTY_API_KEY",
    "KIMIFLARE_WORKER_BACKEND",
    "KIMIFLARE_WORKER_ENDPOINT",
    "KIMI_MODEL",
    "XDG_CONFIG_HOME",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let configHome: string;

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    configHome = await mkdtemp(join(tmpdir(), "kimiflare-spawn-worker-test-"));
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.REQUESTY_API_KEY = "rq-test";
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(configHome, { recursive: true, force: true });
  });

  it("refuses Hotcell workers before launching one", async () => {
    process.env.KIMIFLARE_WORKER_BACKEND = "hotcell";
    const out = await spawnWorkerTool.run({ mode: "plan", task: "research" }, { cwd: process.cwd() });
    const text = typeof out === "string" ? out : out.content;
    assert.strictEqual(
      text,
      "Hotcell workers currently require an OpenRouter-backed session; custom model endpoints and Requesty sessions cannot be routed through the Hotcell gateway.",
    );
  });

  it("refuses unprefixed Requesty model ids for remote workers without calling the endpoint", async () => {
    process.env.KIMIFLARE_WORKER_ENDPOINT = "http://worker.test";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return mockResponse(200, sample);
    }) as typeof fetch;
    const out = await spawnWorkerTool.run({ mode: "plan", task: "research" }, { cwd: process.cwd() });
    const text = typeof out === "string" ? out : out.content;
    assert.match(text, /Remote workers require an OpenRouter-compatible model ID/);
    assert.strictEqual(calls, 0);
  });

  it("forwards a vendor-prefixed model id to the remote worker", async () => {
    process.env.KIMIFLARE_WORKER_ENDPOINT = "http://worker.test";
    let seenModel: unknown;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenModel = (JSON.parse(String(init.body)) as { model?: unknown }).model;
      return mockResponse(200, sample);
    }) as unknown as typeof fetch;
    await spawnWorkerTool.run({ mode: "plan", task: "research", model: "openai/gpt-4o-mini" }, { cwd: process.cwd() });
    assert.strictEqual(seenModel, "openai/gpt-4o-mini");
  });
});
