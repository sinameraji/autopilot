import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Largest local-changes patch carried into a subagent's sandbox. Above this
 *  the subagent sees the pushed base only, and the coordinator is told so. */
export const MAX_SNAPSHOT_PATCH_BYTES = 4 * 1024 * 1024;

/** Never copied into a sandbox, even when untracked and not gitignored. */
const SECRET_EXCLUDES = [
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
  ".npmrc", ".netrc", ".git-credentials", ".pypirc",
].map((glob) => `:(exclude,glob)**/${glob}`);

export interface RepositorySnapshot {
  /** Credential-free origin URL the Hotcell daemon clones. */
  url: string;
  /** Remote branch (without `origin/`) that contains `commit`, for `hotcell create --ref`. */
  ref: string;
  /** Newest commit of yours that is already on origin; the sandbox checks it out. */
  commit: string;
  /** Binary patch (base64) from `commit` to your working tree: unpushed commits,
   *  staged and unstaged edits, and untracked files that aren't ignored. */
  patch: string | null;
  /** Files changed by `patch`. */
  changedFiles: number;
  /** Set when local changes could not be included. */
  note?: string;
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout.toString("utf8");
}

async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  return stdout;
}

/** Remote-tracking branches on origin that contain `commit` (e.g. `main`). */
async function originBranchesContaining(commit: string, cwd: string): Promise<string[]> {
  const out = await git(["branch", "-r", "--contains", commit, "--format=%(refname:short)"], cwd).catch(() => "");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith("origin/") && name !== "origin/HEAD" && !name.includes(" -> "))
    .map((name) => name.slice("origin/".length));
}

/**
 * Describe what a subagent should see: the newest pushed commit plus a patch
 * of everything local on top of it. Subagents are research-only, so seeing
 * your current work (not just what's pushed) is what makes them useful.
 * Uses a temporary index, so your staging area is never touched.
 */
export async function getRepositorySnapshot(cwd: string): Promise<RepositorySnapshot> {
  const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  const url = (await git(["config", "--get", "remote.origin.url"], root).catch(() => "")).trim();
  if (!/^(https:\/\/|git@|ssh:\/\/)/i.test(url) || /:\/\/[^/]*@/.test(url)) {
    throw new Error("Subagents need a credential-free HTTPS or SSH `origin` remote that the Hotcell daemon can clone.");
  }
  const head = (await git(["rev-parse", "HEAD"], root)).trim();

  // Newest pushed ancestor: HEAD itself, else its merge-base with the
  // upstream or origin's default branch, else with any origin branch.
  let commit: string | null = (await originBranchesContaining(head, root)).length > 0 ? head : null;
  if (!commit) {
    const candidates = [
      (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root).catch(() => "")).trim(),
      (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root).catch(() => "")).trim(),
      ...(await git(["branch", "-r", "--format=%(refname:short)"], root).catch(() => ""))
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.startsWith("origin/") && name !== "origin/HEAD"),
    ].filter((name, index, all) => name.startsWith("origin/") && all.indexOf(name) === index);
    for (const candidate of candidates) {
      const base = (await git(["merge-base", "HEAD", candidate], root).catch(() => "")).trim();
      if (base) {
        commit = base;
        break;
      }
    }
  }
  if (!commit) {
    throw new Error("Subagents clone your repository from origin, but none of your history is on origin yet. Push a branch (git push -u origin HEAD), then retry.");
  }
  const ref = (await originBranchesContaining(commit, root))[0];
  if (!ref) {
    throw new Error("Could not find an origin branch containing the base commit. Run git fetch, then retry.");
  }

  // Snapshot the working tree into a throwaway index: tracked edits plus
  // untracked, non-ignored files, minus secrets.
  const scratch = await mkdtemp(join(tmpdir(), "autopilot-snapshot-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await git(["read-tree", "HEAD"], root, env);
    await git(["add", "-A", "--", ".", ...SECRET_EXCLUDES], root, env);
    // Secrets that are already tracked stay at their committed contents.
    const tree = (await git(["write-tree"], root, env)).trim();
    const names = (await git(["diff", "--name-only", commit, tree], root)).split("\n").filter(Boolean);
    if (names.length === 0) return { url, ref, commit, patch: null, changedFiles: 0 };
    const patch = await gitBuffer(["diff", "--binary", "--no-color", "--no-ext-diff", commit, tree], root);
    if (patch.byteLength > MAX_SNAPSHOT_PATCH_BYTES) {
      return {
        url, ref, commit, patch: null, changedFiles: names.length,
        note: `Your local changes (${names.length} files, ${(patch.byteLength / 1024 / 1024).toFixed(1)} MB) were too large to copy; the subagent saw origin's ${ref} at ${commit.slice(0, 8)} instead.`,
      };
    }
    return { url, ref, commit, patch: patch.toString("base64"), changedFiles: names.length };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Split a base64 payload into argv-safe chunks for `hotcell files write`. */
export function chunkPayload(base64: string, chunkSize = 192 * 1024): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += chunkSize) chunks.push(base64.slice(i, i + chunkSize));
  return chunks;
}
