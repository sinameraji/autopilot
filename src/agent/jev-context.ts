import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface JevProjectContext {
  /** Whitelisted local facts sent as reference data, never as instructions. */
  evidence: string;
  /** Compact receipt shown in the TUI; does not include raw file contents. */
  summary: string;
  sources: string[];
}

const LOCAL_PROJECT_QUESTION = /\b(?:this|current|our|my)\s+(?:project|repo(?:sitory)?|codebase|harness|app|package)\b|\b(?:project|repo(?:sitory)?|codebase|harness|app)\s+(?:here|in this directory)\b/i;
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt"] as const;
const MAX_FILE_BYTES = 16_384;
const MAX_LICENSE_CHARS = 1_200;

async function readSmallRegularFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function packageFacts(raw: string): { facts: string[]; summary: string[] } {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const facts: string[] = [];
    const summary: string[] = [];
    for (const key of ["name", "description", "license"] as const) {
      const value = pkg[key];
      if (typeof value !== "string" || !value.trim()) continue;
      const clean = value.trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").slice(0, key === "description" ? 300 : 120);
      facts.push(`${key}: ${clean}`);
      if (key !== "description") summary.push(clean);
    }
    return { facts, summary };
  } catch {
    return { facts: [], summary: [] };
  }
}

/**
 * Collect only a tiny, explicit set of local project facts when the question
 * refers to the current project. No chat history, environment variables, git
 * remotes, or arbitrary repository files are read or sent.
 */
export async function buildJevProjectContext(
  prompt: string,
  cwd: string = process.cwd(),
): Promise<JevProjectContext | undefined> {
  if (!LOCAL_PROJECT_QUESTION.test(prompt)) return undefined;

  const sources: string[] = [];
  const facts: string[] = [];
  const packageRaw = await readSmallRegularFile(join(cwd, "package.json"));
  if (packageRaw !== undefined) {
    const parsed = packageFacts(packageRaw);
    if (parsed.facts.length) {
      facts.push(...parsed.facts);
      sources.push("package.json");
    }
  }

  let licenseText: string | undefined;
  let licenseSource: string | undefined;
  for (const filename of LICENSE_FILES) {
    licenseText = await readSmallRegularFile(join(cwd, filename));
    if (licenseText !== undefined) {
      licenseSource = filename;
      break;
    }
  }
  if (licenseText?.trim()) {
    facts.push(`license file excerpt (${licenseSource}):\n${licenseText.trim().slice(0, MAX_LICENSE_CHARS)}`);
    sources.push(licenseSource!);
  }

  if (!facts.length) return undefined;
  const summary = packageFacts(packageRaw ?? "{}").summary;
  if (!summary.length && licenseSource) summary.push(`license file: ${licenseSource}`);

  return {
    evidence: facts.join("\n"),
    summary: summary.slice(0, 2).join(" · "),
    sources,
  };
}
