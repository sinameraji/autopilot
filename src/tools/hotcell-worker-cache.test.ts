import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetWorkerCacheForTests, ensureWorkerBackup, parseBackupId, workerCachePath } from "./hotcell-worker-cache.js";
import type { HotcellProcessRunner } from "./hotcell-worker.js";

let home = "";
let savedXdg: string | undefined;
before(async () => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  home = await mkdtemp(join(tmpdir(), "autopilot-worker-cache-"));
  process.env.XDG_CONFIG_HOME = home;
});
after(async () => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  _resetWorkerCacheForTests();
  await rm(workerCachePath(), { force: true });
});

function runner(opts: { backups?: string; installCode?: number; onBuild?: () => Promise<void> } = {}) {
  const calls: string[][] = [];
  const execute: HotcellProcessRunner = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", aborted: false });
    switch (args[0]) {
      case "backups": return ok(opts.backups ?? "");
      case "create": await opts.onBuild?.(); return ok("Created sandbox aaaabbbbcccc\n");
      case "exec": return { ...ok("1.16.0"), code: opts.installCode ?? 0 };
      case "backup": return ok("Backed up aaaabbbbcccc -> bk123456789 (100 bytes).\n");
      case "rm": return ok();
      default: return { code: 1, stdout: "", stderr: "unexpected", aborted: false };
    }
  };
  return { calls, execute };
}

const base = { packageSpec: "autopilot-ai@1.16.0", command: "hotcell", cwd: "/tmp" };

describe("ensureWorkerBackup", () => {
  it("builds the runtime once, backs it up, records it, and removes the build sandbox", async () => {
    const { calls, execute } = runner();
    assert.equal(await ensureWorkerBackup({ ...base, execute }), "bk123456789");
    assert.deepEqual(calls.map((c) => c[0]), ["create", "exec", "backup", "rm"]);
    assert.match(calls[1]![2]!, /npm install --prefix \/workspace\/.autopilot-worker .*'autopilot-ai@1\.16\.0'/);
    const cache = JSON.parse(await readFile(workerCachePath(), "utf8"));
    assert.equal(cache["autopilot-ai@1.16.0"].backupId, "bk123456789");
  });

  it("reuses a recorded backup that still exists, and rebuilds one that doesn't", async () => {
    await ensureWorkerBackup({ ...base, execute: runner().execute });
    _resetWorkerCacheForTests();
    const present = runner({ backups: "ID  SANDBOX\nbk123456789  aaaabbbbcccc" });
    assert.equal(await ensureWorkerBackup({ ...base, execute: present.execute }), "bk123456789");
    assert.deepEqual(present.calls.map((c) => c[0]), ["backups"]);
    const gone = runner({ backups: "ID  SANDBOX\n" });
    assert.equal(await ensureWorkerBackup({ ...base, execute: gone.execute }), "bk123456789");
    assert.deepEqual(gone.calls.map((c) => c[0]), ["backups", "create", "exec", "backup", "rm"]);
  });

  it("shares one build between parallel subagents", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { calls, execute } = runner({ onBuild: () => gate });
    const all = Promise.all([1, 2, 3].map(() => ensureWorkerBackup({ ...base, execute })));
    release();
    assert.deepEqual(await all, ["bk123456789", "bk123456789", "bk123456789"]);
    assert.equal(calls.filter((c) => c[0] === "create").length, 1);
  });

  it("returns null (so callers install directly) when the build fails, and still cleans up", async () => {
    const { calls, execute } = runner({ installCode: 1 });
    assert.equal(await ensureWorkerBackup({ ...base, execute }), null);
    assert.deepEqual(calls.at(-1), ["rm", "aaaabbbbcccc"]);
  });

  it("parses backup ids", () => {
    assert.equal(parseBackupId("Backed up 9d5aeee3e4b5 -> 7df7bbde79d3 (116834304 bytes)."), "7df7bbde79d3");
    assert.equal(parseBackupId("error"), undefined);
  });
});
