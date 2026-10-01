import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMentionDir, modelOptions, toolRow, toolSummary } from "./camouflage-view.js";
import { listModels } from "./models/registry.js";

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

describe("modelOptions", () => {
  it("matches the Ink picker: current, then best & latest, then the rest, with columns", () => {
    const models = listModels().filter((m) => m.supports.tools);
    const current = models[models.length - 1]!.id;
    const opts = modelOptions(models, current);
    assert.equal(opts.length, models.length, "every model is reachable");
    assert.ok(opts.every((o) => o.columns?.length === 2), "context and price columns");
    const sections = [...new Set(opts.map((o) => o.section))];
    assert.ok(sections.some((x) => x?.startsWith("Best & latest")));
    if (sections[0] === "Current") assert.equal(opts[0]!.value, current);
  });
});
