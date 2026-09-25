import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { buildJevProjectContext } from "./jev-context.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jev-context-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name: "sample-app",
    description: "A local test project",
    license: "MIT",
    private: true,
    scripts: { test: "secret-command" },
  }));
  await writeFile(join(dir, "LICENSE"), "MIT License\n\nCopyright (c) Example\n");
  await writeFile(join(dir, "README.md"), "Do not include this arbitrary file.");
  return dir;
}

describe("buildJevProjectContext", () => {
  it("includes only allowlisted local project facts for project-referential questions", async () => {
    const dir = await fixture();
    const context = await buildJevProjectContext("Is this harness open source?", dir);

    assert.ok(context);
    assert.deepStrictEqual(context.sources, ["package.json", "LICENSE"]);
    assert.strictEqual(context.summary, "sample-app · MIT");
    assert.match(context.evidence, /name: sample-app/);
    assert.match(context.evidence, /license: MIT/);
    assert.match(context.evidence, /MIT License/);
    assert.doesNotMatch(context.evidence, /secret-command|README|private/);
  });

  it("does not read project files for generic questions", async () => {
    const dir = await fixture();
    assert.strictEqual(await buildJevProjectContext("Is water wet?", dir), undefined);
  });

  it("does not follow symlinks when reading project files", async () => {
    const dir = await fixture();
    const outside = join(dir, "outside.json");
    await writeFile(outside, await readFile(join(dir, "package.json"), "utf8"));
    await rm(join(dir, "package.json"));
    await (await import("node:fs/promises")).symlink(outside, join(dir, "package.json"));

    const context = await buildJevProjectContext("Is this project open source?", dir);
    assert.ok(context);
    assert.deepStrictEqual(context.sources, ["LICENSE"]);
    assert.doesNotMatch(context.evidence, /sample-app/);
  });
});
