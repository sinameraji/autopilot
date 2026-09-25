import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ChatMessage } from "./messages.js";

export interface JevContextEntry {
  source: string;
  content: string;
}

const MAX_CONTEXT_CHARS = 6_000;
const MAX_CONVERSATION_CHARS = 4_000;
const CURRENT_PROJECT_REFERENCE = /\b(?:this|that|our|current|local|working)\s+(?:repo(?:sitory)?|project|workspace|codebase|harness)\b/i;
const LICENSE_QUESTION = /\bopen[\s-]?source\b|\blicen[cs](?:e|ed|ing)?\b|\bspdx\b|\bcopyleft\b/i;
const CONVERSATION_REFERENCE =
  /\b(?:above|earlier|previous(?:ly)?|prior conversation|we\s+(?:said|discussed|decided)|you\s+(?:said|mentioned|recommended)|my\s+(?:last|earlier)|your\s+(?:last|earlier))\b|^\s*(?:(?:is|was|does|did|will|can|could|should|would)\s+)?(?:that|it|those)\b/i;

const SECRET_PATTERNS = [
  /\b(?:sk-or-v1-|sk-ant-|sk_live_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s,"'`]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function redactCommonSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED]"), text);
}

function projectRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
  } catch {
    return resolve(cwd);
  }
}

async function readPackageMetadata(root: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const pkg = parsed as Record<string, unknown>;
    const metadata: Record<string, string> = {};
    for (const key of ["name", "version", "description", "license"] as const) {
      const value = pkg[key];
      if (typeof value === "string" && value.trim()) metadata[key] = value.trim().slice(0, 500);
    }
    if (typeof pkg.private === "boolean") metadata.private = String(pkg.private);
    return metadata;
  } catch {
    return {};
  }
}

async function readLicenseEvidence(root: string): Promise<JevContextEntry | undefined> {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]) {
    try {
      const content = (await readFile(join(root, name), "utf8")).trim();
      if (content) return { source: `project license (${name})`, content: content.slice(0, 700) };
    } catch {
      // Try the next conventional license filename.
    }
  }
  return undefined;
}

/**
 * Select a small, explicit context bundle for Jev. Jev cannot inspect tools,
 * inherit the agent system prompt, or browse the web. Chat is included only
 * when the question clearly refers back to it; project metadata is included
 * only for questions that refer to the current project.
 */
export async function buildJevContext(
  question: string,
  messages: ChatMessage[],
  cwd = process.cwd(),
): Promise<JevContextEntry[]> {
  const entries: JevContextEntry[] = [];
  let remaining = MAX_CONTEXT_CHARS;

  const add = (source: string, content: string, limit = remaining): void => {
    if (remaining <= 0 || !content.trim()) return;
    const sourceText = source.slice(0, 160);
    const prefixLength = sourceText.length + 2;
    const available = Math.max(0, Math.min(limit, remaining - prefixLength));
    if (available <= 0) return;
    const clipped = content.trim().slice(0, available);
    entries.push({ source: sourceText, content: clipped });
    remaining -= prefixLength + clipped.length;
  };

  if (CONVERSATION_REFERENCE.test(question)) {
    const recent = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: redactCommonSecrets(messageText(message)) }))
      .filter((message) => message.content)
      .slice(-4);
    let conversationRemaining = MAX_CONVERSATION_CHARS;
    for (const message of recent) {
      if (conversationRemaining <= 0 || remaining <= 0) break;
      const source = `recent chat (${message.role})`;
      const available = Math.min(conversationRemaining, remaining - source.length - 2);
      if (available <= 0) break;
      const content = message.content.slice(0, available);
      add(source, content, available);
      conversationRemaining -= source.length + content.length + 2;
    }
  }

  const currentDirectory = basename(resolve(cwd));
  const escapedDirectory = currentDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namesCurrentDirectory =
    currentDirectory.length >= 5 &&
    !/^(?:agent|app|code|lib|project|repo|src|test|tests|workspace)$/i.test(currentDirectory) &&
    new RegExp(`\\b${escapedDirectory}\\b`, "i").test(question);

  if (CURRENT_PROJECT_REFERENCE.test(question) || namesCurrentDirectory) {
    const root = projectRoot(cwd);
    const metadata = await readPackageMetadata(root);
    if (!metadata.name) metadata.name = basename(root);
    add("project metadata (package.json or directory)", JSON.stringify(metadata));

    if (LICENSE_QUESTION.test(question)) {
      const license = await readLicenseEvidence(root);
      if (license) {
        add(license.source, license.content, 750);
      } else {
        add(
          "project license check",
          "No conventional LICENSE/LICENCE/COPYING file was found at the repository root. This does not establish whether the source is publicly accessible.",
          750,
        );
      }
      add(
        "verification limit",
        "Local package/license metadata does not prove that the repository is publicly accessible. Jev did not verify the remote repository or browse the web.",
        450,
      );
    }
  }

  return entries;
}

/** A concise receipt by default; opt in to displaying the exact sent excerpts. */
export function formatJevContextReceipt(entries: JevContextEntry[], includeContent = false): string {
  if (entries.length === 0) {
    return includeContent
      ? "Context sent: none. Jev received only the question; no chat, project files, tools, system prompt, or web sources."
      : "Context: question only · no chat, project files, or web sources";
  }
  if (!includeContent) {
    const sources = [...new Set(entries.map(({ source }) => source))];
    return `Context: ${entries.length} item${entries.length === 1 ? "" : "s"} · ${sources.join(", ")} · local only, no web verification`;
  }
  return [
    "Context sent:",
    ...entries.map(({ source, content }) => `  ${source}: ${content}`),
    "External sources: none (Jev did not browse the web).",
    "Chat/project context is reference data, not verified fact.",
  ].join("\n");
}
