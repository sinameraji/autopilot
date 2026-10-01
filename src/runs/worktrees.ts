import { execFile } from "node:child_process";
import { access, chmod, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RunWorktree {
  runId: string;
  repositoryRoot: string;
  sourceCwd: string;
  worktreePath: string;
  cwd: string;
  branch: string;
}

/** Creates one branch/worktree per run outside the source repository. */
export class RunWorktreeManager {
  constructor(private readonly rootDir = defaultWorktreesDir()) {}

  async create(runId: string, sourceCwd: string): Promise<RunWorktree> {
    if (runId === "." || runId === ".." || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) {
      throw new Error("runId must contain only letters, numbers, dots, underscores, or hyphens");
    }

    const source = await realpath(sourceCwd);
    const repositoryRoot = (await runGit(["rev-parse", "--show-toplevel"], source)).trim();
    const repository = await realpath(repositoryRoot);
    const sourceRelativePath = relative(repository, source);
    if (isOutside(sourceRelativePath)) {
      throw new Error("sourceCwd must be inside the Git repository");
    }

    const configuredRoot = resolve(this.rootDir);
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    await chmod(configuredRoot, 0o700);
    const worktreesRoot = await realpath(configuredRoot);
    if (isWithin(repository, worktreesRoot)) {
      throw new Error("worktree root must be outside the source repository");
    }

    const worktreePath = join(worktreesRoot, runId);
    try {
      await access(worktreePath);
      throw new Error(`worktree path already exists for run ${runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const branch = `autopilot/run/${runId}`;
    await runGit(["worktree", "add", "--quiet", "-b", branch, worktreePath, "HEAD"], repository);

    return {
      runId,
      repositoryRoot: repository,
      sourceCwd: source,
      worktreePath,
      cwd: resolve(worktreePath, sourceRelativePath),
      branch,
    };
  }
}

function defaultWorktreesDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "autopilot", "worktrees");
}

function isOutside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || !isOutside(path);
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim();
        reject(new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`, { cause: error }));
        return;
      }
      resolveOutput(stdout.trimEnd());
    });
  });
}
