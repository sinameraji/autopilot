import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chunkPayload, getRepositorySnapshot, getWorkingTreeArchive, MAX_SNAPSHOT_PATCH_BYTES } from "./hotcell-snapshot.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repo whose first commit is "pushed" (on origin/main). */
async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "autopilot-snapshot-"));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "t@example.com");
  git(cwd, "config", "user.name", "T");
  await writeFile(join(cwd, "a.txt"), "one\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.log\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "base");
  git(cwd, "remote", "add", "origin", "https://github.com/example/project.git");
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  return cwd;
}

describe("getRepositorySnapshot", () => {
  it("has no patch for a clean, pushed checkout", async () => {
    const cwd = await makeRepo();
    const snap = await getRepositorySnapshot(cwd);
    assert.equal(snap.commit, git(cwd, "rev-parse", "HEAD"));
    assert.equal(snap.ref, "main");
    assert.equal(snap.patch, null);
    assert.equal(snap.changedFiles, 0);
  });

  it("carries unpushed commits, staged, unstaged and untracked work — but not secrets or ignored files", async () => {
    const cwd = await makeRepo();
    const base = git(cwd, "rev-parse", "HEAD");
    await writeFile(join(cwd, "committed.txt"), "unpushed commit\n");
    git(cwd, "add", "committed.txt");
    git(cwd, "commit", "-qm", "local only");
    await writeFile(join(cwd, "a.txt"), "one\ntwo (unstaged)\n");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");
    await writeFile(join(cwd, "bin.dat"), randomBytes(64));
    await writeFile(join(cwd, ".env"), "SECRET=do-not-copy\n");
    await writeFile(join(cwd, "id_rsa"), "private key\n");
    await writeFile(join(cwd, "ignored.log"), "ignored\n");
    const indexBefore = git(cwd, "diff", "--cached", "--name-only");

    const snap = await getRepositorySnapshot(cwd);
    assert.equal(snap.commit, base, "base is the newest pushed commit");
    assert.ok(snap.patch);
    assert.equal(snap.changedFiles, 5);
    assert.equal(git(cwd, "diff", "--cached", "--name-only"), indexBefore, "the user's index is untouched");

    // Apply to a clean checkout of the base, as the sandbox does.
    const clone = await mkdtemp(join(tmpdir(), "autopilot-snapshot-apply-"));
    dirs.push(clone);
    git(cwd, "worktree", "add", "-q", "--detach", clone, base);
    const patchFile = join(clone, "..", `${clone.split("/").pop()}.patch`);
    await writeFile(patchFile, Buffer.from(snap.patch!, "base64"));
    dirs.push(patchFile);
    git(clone, "apply", "--binary", "--whitespace=nowarn", patchFile);
    assert.equal(await readFile(join(clone, "a.txt"), "utf8"), "one\ntwo (unstaged)\n");
    assert.equal(await readFile(join(clone, "committed.txt"), "utf8"), "unpushed commit\n");
    assert.equal(await readFile(join(clone, "staged.txt"), "utf8"), "staged\n");
    assert.equal(await readFile(join(clone, "untracked.txt"), "utf8"), "untracked\n");
    assert.deepEqual(await readFile(join(clone, "bin.dat")), await readFile(join(cwd, "bin.dat")));
    for (const secret of [".env", "id_rsa", "ignored.log"]) {
      await assert.rejects(readFile(join(clone, secret)), `${secret} must not be copied`);
    }
  });

  it("falls back to the pushed base with a note when local changes are too large", async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, "big.bin"), randomBytes(MAX_SNAPSHOT_PATCH_BYTES));
    const snap = await getRepositorySnapshot(cwd);
    assert.equal(snap.patch, null);
    assert.match(snap.note ?? "", /too large to copy; the subagent saw origin's main/);
  });

  it("explains what to do when nothing is on origin yet", async () => {
    const cwd = await makeRepo();
    git(cwd, "update-ref", "-d", "refs/remotes/origin/main");
    await assert.rejects(() => getRepositorySnapshot(cwd), /Push a branch/);
  });

  it("splits payloads into argv-safe chunks", () => {
    assert.deepEqual(chunkPayload("abcdefg", 3), ["abc", "def", "g"]);
    assert.deepEqual(chunkPayload("", 3), []);
    assert.ok(chunkPayload("x".repeat(1_000_000)).every((c) => c.length <= 64 * 1024), "each chunk stays under Hotcell's measured ~96 KiB write limit");
  });
});

describe("getWorkingTreeArchive", () => {
  async function extract(base64: string): Promise<string> {
    const out = await mkdtemp(join(tmpdir(), "autopilot-archive-out-"));
    dirs.push(out);
    const tarPath = join(out, "..", `${out.split("/").pop()}.tgz`);
    dirs.push(tarPath);
    await writeFile(tarPath, Buffer.from(base64, "base64"));
    execFileSync("tar", ["-xzf", tarPath, "-C", out]);
    return out;
  }

  it("packs your working tree for private repos: edits and untracked files, never secrets or ignored files", async () => {
    const cwd = await makeRepo();
    git(cwd, "remote", "set-url", "origin", "https://github.com/example/private.git");
    git(cwd, "update-ref", "-d", "refs/remotes/origin/main"); // nothing pushed at all
    await writeFile(join(cwd, ".env"), "TRACKED_SECRET=1\n");
    git(cwd, "add", "-f", ".env");
    git(cwd, "commit", "-qm", "oops, tracked a secret");
    await writeFile(join(cwd, "a.txt"), "edited\n");
    await writeFile(join(cwd, "new.txt"), "untracked\n");
    await writeFile(join(cwd, "server.pem"), "key\n");
    await writeFile(join(cwd, "ignored.log"), "ignored\n");
    const indexBefore = git(cwd, "diff", "--cached", "--name-only");

    const packed = await getWorkingTreeArchive(cwd);
    assert.ok(packed.archive);
    assert.equal(git(cwd, "diff", "--cached", "--name-only"), indexBefore, "the user's index is untouched");
    const out = await extract(packed.archive!);
    assert.equal(await readFile(join(out, "a.txt"), "utf8"), "edited\n");
    assert.equal(await readFile(join(out, "new.txt"), "utf8"), "untracked\n");
    assert.equal(await readFile(join(out, ".gitignore"), "utf8"), "ignored.log\n");
    for (const secret of [".env", "server.pem", "ignored.log"]) {
      await assert.rejects(readFile(join(out, secret)), `${secret} must not be packed`);
    }
    assert.equal(packed.files, 3);
  });

  it("works in a repository with no commits, and reports oversize trees", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "autopilot-archive-empty-"));
    dirs.push(cwd);
    git(cwd, "init", "-q");
    await writeFile(join(cwd, "draft.md"), "hello\n");
    const packed = await getWorkingTreeArchive(cwd);
    assert.equal(packed.files, 1);
    const tooBig = await getWorkingTreeArchive(cwd, 10);
    assert.equal(tooBig.archive, null);
    assert.ok(tooBig.bytes > 10);
  });

  it("requires a Git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "autopilot-archive-nogit-"));
    dirs.push(cwd);
    await assert.rejects(() => getWorkingTreeArchive(cwd), /inside a Git repository/);
  });
});
