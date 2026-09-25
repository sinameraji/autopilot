import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deterministicTopicKey, pickTopicKey, MemoryManager } from "./manager.js";

describe("deterministicTopicKey", () => {
  it("lowercases and snake_cases a simple phrase", () => {
    assert.strictEqual(deterministicTopicKey("Project uses tsup"), "project_uses_tsup");
  });

  it("strips non-alphanumeric characters", () => {
    assert.strictEqual(
      deterministicTopicKey("User prefers single-quotes & semicolons!"),
      "user_prefers_singlequotes_semicolons"
    );
  });

  it("collapses multiple spaces into a single underscore", () => {
    assert.strictEqual(deterministicTopicKey("  lots   of    spaces  "), "lots_of_spaces");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    const result = deterministicTopicKey(long);
    assert.strictEqual(result.length, 60);
  });

  it("returns empty string for empty input", () => {
    assert.strictEqual(deterministicTopicKey(""), "");
  });

  it("returns empty string for input with only special chars", () => {
    assert.strictEqual(deterministicTopicKey("!!!@@@###"), "");
  });
});

describe("pickTopicKey", () => {
  it("returns a new key when no existing keys match", () => {
    const result = pickTopicKey("new topic here", ["old_topic"]);
    assert.strictEqual(result, "new_topic_here");
  });

  it("reuses an existing key when it is a substring of the new key", () => {
    const result = pickTopicKey("project uses tsup for bundling", ["project_uses_tsup"]);
    assert.strictEqual(result, "project_uses_tsup");
  });

  it("reuses an existing key when the new key is a substring of it", () => {
    const result = pickTopicKey("project uses", ["project_uses_tsup"]);
    assert.strictEqual(result, "project_uses_tsup");
  });

  it("returns null for empty content", () => {
    const result = pickTopicKey("", ["existing"]);
    assert.strictEqual(result, null);
  });

  it("picks the first matching existing key", () => {
    const result = pickTopicKey("project uses tsup", ["project", "project_uses_tsup"]);
    assert.strictEqual(result, "project");
  });
});

describe("MemoryManager plan storage", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-memory-test-"));
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

  it("rememberPlan stores a plan under the default topic key", async () => {
    const result = await manager.rememberPlan("Build a login page", "/repo", "session-1");
    assert.ok(result.id);

    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored?.content, "Build a login page");
    assert.strictEqual(stored?.topicKey, "current_dev_plan");
    assert.strictEqual(stored?.category, "task");
  });

  it("rememberPlan supersedes the previous plan under the same key", async () => {
    await manager.rememberPlan("Old plan", "/repo", "session-1");
    const result = await manager.rememberPlan("New plan", "/repo", "session-2");

    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored?.content, "New plan");
    assert.ok(result.superseded);
    assert.strictEqual(result.superseded?.length, 1);
  });

  it("rememberPlan supports a custom topic key", async () => {
    await manager.rememberPlan("Custom plan", "/repo", "session-1", "my_topic");
    const stored = manager.getByTopicKey("/repo", "my_topic");
    assert.strictEqual(stored?.content, "Custom plan");
  });

  it("getByTopicKey returns null when no memory exists", () => {
    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored, null);
  });

  it("getByTopicKey returns the latest memory for the key", async () => {
    await manager.rememberPlan("First", "/repo", "session-1");
    await manager.rememberPlan("Second", "/repo", "session-2");
    await manager.rememberPlan("Third", "/repo", "session-3");

    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored?.content, "Third");
  });
});
