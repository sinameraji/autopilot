import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePlanForFresh, PLAN_MEMORY_TOPIC_KEY } from "./plan-resolver.js";
import { MemoryManager } from "../memory/manager.js";
import type { ChatMessage } from "./messages.js";

describe("resolvePlanForFresh", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-plan-resolver-test-"));
    manager = new MemoryManager({
      dbPath: join(tmpDir, "memory.db"),
      openrouterApiKey: "sk-or-test",
      model: "moonshotai/kimi-k2.7-code",
      plumbingModel: "moonshotai/kimi-k2.5",
      embeddingModel: "baai/bge-base-en-v1.5",
    });
    manager.open();
  });

  afterEach(async () => {
    manager.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-plan modes", () => {
    const messages: ChatMessage[] = [];
    const result = resolvePlanForFresh({
      mode: "edit",
      messages,
      sessionPlan: "A plan",
      memoryManager: manager,
      memoryEnabled: true,
      repoPath: "/repo",
    });
    assert.strictEqual(result, null);
  });

  it("prefers the in-session plan for plan mode", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "This is the follow-up reply, not the plan." },
    ];
    const result = resolvePlanForFresh({
      mode: "plan",
      messages,
      sessionPlan: "Original dev plan",
      memoryManager: manager,
      memoryEnabled: true,
      repoPath: "/repo",
    });
    assert.strictEqual(result, "Original dev plan");
  });

  it("falls back to the durable memory topic key when sessionPlan is empty", async () => {
    await manager.rememberPlan("Stored plan", "/repo", "session-1");

    const messages: ChatMessage[] = [];
    const result = resolvePlanForFresh({
      mode: "plan",
      messages,
      sessionPlan: null,
      memoryManager: manager,
      memoryEnabled: true,
      repoPath: "/repo",
    });
    assert.strictEqual(result, "Stored plan");
  });

  it("falls back to distilling messages when no session or memory plan exists", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "This is the original development plan with enough detail." },
    ];
    const result = resolvePlanForFresh({
      mode: "plan",
      messages,
      sessionPlan: null,
      memoryManager: manager,
      memoryEnabled: true,
      repoPath: "/repo",
    });
    assert.strictEqual(result, "This is the original development plan with enough detail.");
  });

  it("returns null for plan mode when nothing is available", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
    ];
    const result = resolvePlanForFresh({
      mode: "plan",
      messages,
      sessionPlan: null,
      memoryManager: manager,
      memoryEnabled: true,
      repoPath: "/repo",
    });
    assert.strictEqual(result, null);
  });

  it("skips memory lookup when memory is disabled", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Distilled plan from message history." },
    ];
    const result = resolvePlanForFresh({
      mode: "plan",
      messages,
      sessionPlan: null,
      memoryManager: manager,
      memoryEnabled: false,
      repoPath: "/repo",
    });
    assert.strictEqual(result, "Distilled plan from message history.");
  });

  it("uses the exact topic key constant", async () => {
    await manager.rememberPlan("Plan under exact key", "/repo", "session-1", PLAN_MEMORY_TOPIC_KEY);

    const result = resolvePlanForFresh({
      mode: "plan",
      messages: [],
      sessionPlan: null,
      memoryManager: manager,
      memoryEnabled: true,
      repoPath: "/repo",
    });
    assert.strictEqual(result, "Plan under exact key");
  });
});
