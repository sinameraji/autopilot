import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMentionDir, toolRow, toolSummary } from "./camouflage-view.js";

describe("listMentionDir", () => {
  it("lists the folder being typed, folders first, prefixed as typed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-"));
    await mkdir(join(root, "proj"));
    await mkdir(join(root, "zeta"));
    await writeFile(join(root, "a.md"), "");
    await writeFile(join(root, ".hidden"), "");
    const cwd = join(root, "proj");
    assert.deepEqual(await listMentionDir(cwd, "../"), { dir: "../", entries: ["../proj/", "../zeta/", "../a.md"] });
    assert.deepEqual((await listMentionDir(cwd, "..")).dir, "../");
    assert.deepEqual((await listMentionDir(cwd, "../ze")).entries[0], "../proj/");
    assert.deepEqual(await listMentionDir(cwd, "../nope/x"), { dir: "../nope/", entries: [] });
  });
});

describe("tool rows", () => {
  it("splits a render title into name and arguments", () => {
    assert.deepEqual(toolRow("read", "read src/a.ts", "{}"), { label: "Read", args: "src/a.ts" });
    assert.deepEqual(toolRow("mcp_x_y", undefined, '{"q":1}'), { label: "mcp_x_y", args: '{"q":1}' });
  });
  it("summarizes results", () => {
    assert.equal(toolSummary("read", true, false, "a\nb\nc\n"), "3 lines");
    assert.equal(toolSummary("grep", true, false, ""), "No matches");
    assert.equal(toolSummary("bash", false, false, "\nboom: failed\n"), "boom: failed");
    assert.match(toolSummary("edit", false, true, "Permission denied"), /declined/);
  });
});
