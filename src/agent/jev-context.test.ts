import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./messages.js";
import { buildJevContext, formatJevContextReceipt } from "./jev-context.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autopilot-jev-context-"));
  tempDirs.push(root);
  await mkdir(join(root, "nested"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "autopilot-ai", version: "1.0.0", description: "A terminal coding agent", license: "MIT", private: false }),
  );
  await writeFile(join(root, "LICENSE"), "MIT License\n\nCopyright (c) 2026");
  await writeFile(join(root, ".env"), "OPENROUTER_API_KEY=do-not-send");
  return root;
}

const message = (role: ChatMessage["role"], content: ChatMessage["content"]): ChatMessage => ({ role, content });

describe("buildJevContext", () => {
  it("sends project metadata and license evidence only for project/license questions", async () => {
    const cwd = await makeProject();
    const context = await buildJevContext("Is this harness open source?", [], cwd);

    assert.strictEqual(context.length, 3);
    assert.match(context[0]!.content, /autopilot-ai/);
    assert.match(context[0]!.content, /MIT/);
    assert.match(context[0]!.content, /"private":"false"/);
    assert.strictEqual(context[1]!.source, "project license (LICENSE)");
    assert.match(context[1]!.content, /^MIT License/);
    assert.match(context[2]!.content, /does not prove that the repository is publicly accessible/);
    assert.ok(!context.some((entry) => entry.content.includes("do-not-send")));
  });

  it("includes recent user-facing chat only when the question refers back to it", async () => {
    const messages: ChatMessage[] = [
      message("system", "Never send this system prompt"),
      message("user", "We decided to use the MIT license."),
      message("assistant", "That matches the repository metadata."),
      message("tool", "secret tool output"),
      message("assistant", [{ type: "text", text: "Use the package license field as evidence." }]),
    ];

    const context = await buildJevContext("Is that really open source?", messages, await makeProject());
    const conversation = context.filter((entry) => entry.source.startsWith("recent chat"));

    assert.strictEqual(conversation.length, 3);
    assert.ok(conversation.some((entry) => entry.content.includes("MIT license")));
    assert.ok(conversation.some((entry) => entry.content.includes("package license field")));
    assert.ok(!context.some((entry) => /system prompt|secret tool output/.test(entry.content)));
  });

  it("does not add project or conversation context to a self-contained generic question", async () => {
    const context = await buildJevContext("Should I choose tea or coffee?", [message("user", "Sensitive earlier turn")]);
    assert.deepStrictEqual(context, []);
  });

  it("keeps the default context receipt concise and supports an explicit full receipt", () => {
    const context = [{ source: "package.json", content: '{"license":"MIT"}' }];
    assert.strictEqual(
      formatJevContextReceipt(context),
      "Context: 1 item · package.json · local only, no web verification",
    );
    assert.ok(formatJevContextReceipt(context, true).includes('package.json: {"license":"MIT"}'));
    assert.match(formatJevContextReceipt([]), /Context: question only/);
  });

  it("redacts common secrets from selected chat excerpts", async () => {
    const context = await buildJevContext(
      "Is that accurate?",
      [message("user", "My temporary key is ghp_1234567890abcdefghij and the decision was MIT.")],
      await makeProject(),
    );

    const chat = context.find((entry) => entry.source.startsWith("recent chat"));
    assert.ok(chat);
    assert.ok(chat.content.includes("[REDACTED]"));
    assert.ok(!chat.content.includes("ghp_1234567890abcdefghij"));
  });
});
