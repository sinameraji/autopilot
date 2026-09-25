import type { KimiConfig } from "../config.js";
import { saveRemoteSession, type RemoteSession } from "./session-store.js";
import { readSSE } from "../util/sse.js";

export interface StartRemoteSessionOpts {
  prompt: string;
  repo: { owner: string; name: string };
  cfg: KimiConfig;
  ttlMinutes?: number;
  tokensBudget?: number;
}

export async function startRemoteSession(opts: StartRemoteSessionOpts): Promise<{
  sessionId: string;
  streamUrl: string;
}> {
  const workerUrl = opts.cfg.remoteWorkerUrl;
  if (!workerUrl) {
    throw new Error("Remote worker URL not configured. Set remoteWorkerUrl in config.");
  }

  const githubToken = opts.cfg.githubOAuthToken;
  if (!githubToken) {
    throw new Error("GitHub token not found. Run `autopilot auth github` first.");
  }

  const res = await fetch(`${workerUrl}/remote/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.cfg.remoteAuthSecret ?? ""}`,
    },
    body: JSON.stringify({
      prompt: opts.prompt,
      repo: opts.repo,
      githubToken,
      accountId: opts.cfg.accountId,
      apiToken: opts.cfg.apiToken,
      model: opts.cfg.model,
      reasoningEffort: opts.cfg.reasoningEffort,
      ttlMinutes: opts.ttlMinutes ?? opts.cfg.remoteTtlMinutes,
      tokensBudget: opts.tokensBudget ?? opts.cfg.remoteMaxInputTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to start remote session: ${res.status} ${text}`);
  }

  const data = await res.json() as { sessionId: string; streamUrl: string };

  await saveRemoteSession({
    sessionId: data.sessionId,
    prompt: opts.prompt,
    repo: `${opts.repo.owner}/${opts.repo.name}`,
    workerUrl,
    status: "running",
    branch: `kimiflare/remote/${data.sessionId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return data;
}

export async function* streamRemoteProgress(
  workerUrl: string,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const res = await fetch(`${workerUrl}/remote/stream/${sessionId}`, { signal });
  if (!res.ok) {
    throw new Error(`Failed to connect to stream: ${res.status}`);
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  for await (const line of readSSE(res.body, signal)) {
    try {
      yield JSON.parse(line);
    } catch {
      // ignore malformed lines
    }
  }
}

export interface RemoteStatus {
  sessionId: string;
  status: "pending" | "running" | "paused" | "done" | "error" | "cancelled";
  prompt: string;
  repo: { owner: string; name: string };
  branch: string;
  prUrl?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  maxTurns: number;
  currentTurn: number;
  tokensUsed?: number;
  tokensBudget?: number;
}

export async function getRemoteStatus(workerUrl: string, sessionId: string, authSecret?: string): Promise<RemoteStatus> {
  const res = await fetch(`${workerUrl}/remote/status/${sessionId}`, {
    headers: authSecret ? { Authorization: `Bearer ${authSecret}` } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get status: ${res.status} ${text}`);
  }
  return res.json() as Promise<RemoteStatus>;
}

export async function cancelRemoteSession(workerUrl: string, sessionId: string, authSecret?: string): Promise<void> {
  const res = await fetch(`${workerUrl}/remote/cancel/${sessionId}`, {
    method: "POST",
    headers: authSecret ? { Authorization: `Bearer ${authSecret}` } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to cancel session: ${res.status} ${text}`);
  }
}
