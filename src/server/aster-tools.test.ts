import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertAsterWorkspacePath, containsLikelyProviderSecret, createAsterTools, redactLikelySecrets } from "./aster-tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Aster workspace tool policy", () => {
  it("rejects parent traversal, absolute paths, symlinks outside, and credential paths", async () => {
    const { root, outside } = await fixture();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "linked"));
    await assert.rejects(assertAsterWorkspacePath(root, "../secret.txt"), /workspace_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, join(outside, "secret.txt")), /workspace_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, "linked/secret.txt"), /workspace_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, ".env"), /workspace_sensitive_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, ".git/config"), /workspace_sensitive_path_forbidden/);
  });

  it("allows new files only below the workspace and wraps only safe file tools", async () => {
    const { root } = await fixture();
    assert.equal(await assertAsterWorkspacePath(root, "src/new.ts", true), join(root, "src", "new.ts"));
    const tools = createAsterTools(root);
    assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit"]);
  });

  it("detects and redacts common provider tokens", () => {
    const input = "do not log sk-or-v1-0123456789abcdefghijklmnop and ghp_0123456789abcdefghijklmnop";
    assert.equal(containsLikelyProviderSecret(input), true);
    assert.equal(redactLikelySecrets(input).includes("sk-or-v1-0123456789abcdefghijklmnop"), false);
    assert.equal(redactLikelySecrets(input).includes("ghp_0123456789abcdefghijklmnop"), false);
  });
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-tools-")));
  roots.push(temp);
  const root = join(temp, "workspace");
  const outside = join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}
