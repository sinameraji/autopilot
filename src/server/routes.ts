/**
 * HTTP route handlers for the KimiFlare headless server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { KimiConfig } from "../config.js";
import { DEFAULT_MODEL } from "../config.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { runAgentTurn } from "../agent/loop.js";
import type { AgentCallbacks } from "../agent/loop.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { ToolExecutor, ALL_TOOLS } from "../tools/executor.js";
import type { ChatMessage, ContentPart } from "../agent/messages.js";
import { saveSession, loadSession, listSessions, sessionsDir, type SessionFile } from "../sessions.js";
import { logger } from "../util/logger.js";
import { createSseStream, type SseClient } from "./sse.js";
import { getOpenApiSpec } from "./openapi.js";
import { evaluatePermissionRules } from "../permissions-evaluator.js";
import { readFile, unlink } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { encodeImageFile, isImagePath } from "../util/image.js";
import { glob } from "../util/glob.js";
import { RunStore } from "../runs/store.js";
import { RunWorktreeManager, type RunWorktree } from "../runs/worktrees.js";
import { RunWakeScheduler, type RunWakeEvent } from "../runs/wake-scheduler.js";
import type { RunRecord } from "../runs/store.js";

interface ActiveSession {
  sessionFile: SessionFile;
  messages: ChatMessage[];
  executor: ToolExecutor;
  sseClients: Set<SseClient>;
  runId?: string;
  allowedTools?: Set<string>;
  maxToolIterations?: number;
  maxRuntimeMs?: number;
  controller?: AbortController;
  running?: boolean;
}

const activeSessions = new Map<string, ActiveSession>();
const activeRuns = new Map<string, ActiveSession>();

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, 400, { error: message });
}

function notFound(res: ServerResponse, message: string): void {
  json(res, 404, { error: message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function resolveFiles(filePatterns: string[], cwd: string): Promise<string[]> {
  const resolved = new Set<string>();
  for (const pattern of filePatterns) {
    try {
      const stat = await import("node:fs/promises").then((m) => m.stat(resolve(cwd, pattern)));
      if (stat.isFile()) {
        resolved.add(resolve(cwd, pattern));
        continue;
      }
    } catch {
      // Not a literal file, try glob
    }
    const matches = await glob(pattern, { cwd, absolute: true });
    for (const m of matches) {
      resolved.add(m);
    }
  }
  return [...resolved];
}

async function buildUserMessage(prompt: string, files: string[], cwd: string): Promise<string | ContentPart[]> {
  let text = prompt;
  const imageParts: ContentPart[] = [];
  const fileContents: string[] = [];

  for (const filePath of files) {
    if (isImagePath(filePath)) {
      try {
        const img = await encodeImageFile(filePath);
        imageParts.push({ type: "image_url", image_url: { url: img.dataUrl } });
      } catch (e) {
        fileContents.push(`\n<!-- failed to attach image ${basename(filePath)}: ${(e as Error).message} -->\n`);
      }
    } else {
      try {
        const content = await readFile(filePath, "utf8");
        const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
        fileContents.push(`\n--- ${relPath} ---\n${content}\n--- end ${relPath} ---\n`);
      } catch (e) {
        fileContents.push(`\n<!-- failed to read ${basename(filePath)}: ${(e as Error).message} -->\n`);
      }
    }
  }

  if (fileContents.length > 0) {
    text += "\n\n" + fileContents.join("\n");
  }

  if (imageParts.length > 0) {
    const parts: ContentPart[] = [{ type: "text", text }];
    parts.push(...imageParts);
    return parts;
  }

  return text;
}

export function setupRoutes(config: KimiConfig) {
  const wakeScheduler = new RunWakeScheduler({
    onWake: async (event: RunWakeEvent) => {
      const store = new RunStore();
      let run: RunRecord | undefined;
      try { run = store.getRun(event.runId); } finally { store.close(); }
      if (!run || run.status !== "running" || !run.sessionId) {
        throw new Error(`Cannot restore active run ${event.runId}`);
      }
      let active = activeRuns.get(run.id) ?? activeSessions.get(run.sessionId);
      if (!active) {
        const sessionFile = await loadSession(resolve(sessionsDir(), `${run.sessionId}.json`));
        const allowedTools = new Set(run.allowedTools);
        allowedTools.add("wait_for");
        const tools = ALL_TOOLS.filter((tool) => allowedTools.has(tool.name));
        active = {
          sessionFile,
          messages: sessionFile.messages,
          executor: new ToolExecutor(tools),
          sseClients: new Set(),
          runId: run.id,
          allowedTools,
          maxToolIterations: run.maxToolIterations,
          maxRuntimeMs: run.maxRuntimeMs,
        };
        activeSessions.set(run.sessionId, active);
        activeRuns.set(run.id, active);
      }
      active.messages.push({
        role: "user",
        content: event.condition === "job"
          ? `The wait condition has been checked. Job ${event.jobId} is ${event.jobStatus ?? "unknown"}. Continue the task.`
          : `The scheduled wait has elapsed at ${new Date().toISOString()}. Continue the task.`,
      });
      launchAgentTurnForSession(active, config, false);
    },
    onError: (error, timer) => logger.error("server: run wake failed", { error: error.message, timerId: timer?.id }),
  });
  wakeScheduler.start();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    try {
      // Health check
      if (pathname === "/" && method === "GET") {
        json(res, 200, { status: "ok", version: process.env.npm_package_version ?? "dev" });
        return;
      }

      // OpenAPI docs
      if (pathname === "/doc" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getOpenApiSpec());
        return;
      }

      // Durable unattended runs are deliberately disabled without server auth.
      const runPathMatch = pathname.match(/^\/runs\/([^/]+)(?:\/(events|cancel))?$/);
      if (pathname === "/runs" && method === "GET") {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before accessing unattended runs" });
          return;
        }
        const store = new RunStore();
        try {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          json(res, 200, { runs: store.listRuns({ limit }) });
        } finally {
          store.close();
        }
        return;
      }
      if (pathname === "/runs" && method === "POST") {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before creating unattended runs" });
          return;
        }
        const parsedBody = await readBody(req);
        if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const body = parsedBody as Record<string, unknown>;
        const task = typeof body.task === "string" ? body.task.trim() : "";
        let cwd: string;
        try {
          cwd = typeof body.cwd === "string" ? resolve(body.cwd) : process.cwd();
        } catch {
          badRequest(res, "cwd must be a valid path");
          return;
        }
        const model = typeof body.model === "string" ? body.model : (config.model ?? DEFAULT_MODEL);
        if (!model.trim() || model.length > 200) {
          badRequest(res, "model must be a non-empty string of at most 200 characters");
          return;
        }
        if (body.allowedTools !== undefined && (!Array.isArray(body.allowedTools) || body.allowedTools.some((name) => typeof name !== "string"))) {
          badRequest(res, "allowedTools must be an array of tool names");
          return;
        }
        const allowedTools = Array.isArray(body.allowedTools)
          ? [...new Set(body.allowedTools as string[])]
          : [];
        if (body.worktree !== undefined && typeof body.worktree !== "boolean") {
          badRequest(res, "worktree must be a boolean");
          return;
        }
        const useWorktree = body.worktree !== false;
        if (body.cwd !== undefined && typeof body.cwd !== "string") {
          badRequest(res, "cwd must be a string");
          return;
        }
        if (useWorktree && typeof body.cwd !== "string") {
          badRequest(res, "cwd is required when worktree is enabled; provide a path in a Git repository or set worktree to false");
          return;
        }
        const maxToolIterations = body.maxToolIterations ?? 100;
        if (!Number.isInteger(maxToolIterations) || (maxToolIterations as number) < 1 || (maxToolIterations as number) > 5000) {
          badRequest(res, "maxToolIterations must be an integer from 1 through 5000");
          return;
        }
        const maxRuntimeMs = body.maxRuntimeMs ?? 8 * 60 * 60 * 1000;
        if (!Number.isInteger(maxRuntimeMs) || (maxRuntimeMs as number) < 1000 || (maxRuntimeMs as number) > 7 * 24 * 60 * 60 * 1000) {
          badRequest(res, "maxRuntimeMs must be an integer from 1000 through 604800000");
          return;
        }
        if (!task || task.length > 20_000) {
          badRequest(res, "task is required and must be at most 20000 characters");
          return;
        }
        if (allowedTools.some((name) => name !== "wait_for" && !ALL_TOOLS.some((tool) => tool.name === name))) {
          badRequest(res, "allowedTools contains an unknown tool");
          return;
        }
        let cwdStat;
        try {
          cwdStat = await import("node:fs/promises").then((m) => m.stat(cwd));
        } catch {
          badRequest(res, "cwd must be an existing directory");
          return;
        }
        if (!cwdStat.isDirectory()) {
          badRequest(res, "cwd must be an existing directory");
          return;
        }
        const toolNames = new Set(allowedTools);
        toolNames.add("wait_for");
        const tools = ALL_TOOLS.filter((tool) => toolNames.has(tool.name));
        const executor = new ToolExecutor(tools);
        const { makeSessionId } = await import("../sessions.js");
        const sessionId = makeSessionId(task);
        const runId = randomUUID();
        const worktreeManager = new RunWorktreeManager();
        let worktree: RunWorktree | undefined;
        if (useWorktree) {
          try {
            worktree = await worktreeManager.create(runId, cwd);
          } catch (error) {
            badRequest(res, error instanceof Error ? error.message : "Unable to create run worktree");
            return;
          }
        }
        const runCwd = worktree?.cwd ?? cwd;
        const sessionFile: SessionFile = {
          id: sessionId,
          cwd: runCwd,
          model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          title: task.slice(0, 80),
        };
        const messages: ChatMessage[] = [
          { role: "system", content: buildSystemPrompt({ cwd: runCwd, tools, model, preferPullRequests: config.preferPullRequests }) },
          { role: "system", content: `This is an unattended run. Only these tools are authorized: ${[...allowedTools, "wait_for"].join(", ")}. Do not request or attempt any other tool.` },
          { role: "user", content: task },
        ];
        sessionFile.messages = messages;
        let run: RunRecord;
        try {
          await saveSession(sessionFile);
          const store = new RunStore();
          try {
            run = store.createRun({
              id: runId,
              task,
              cwd: runCwd,
              sessionId,
              worktree,
              allowedTools,
              maxToolIterations: maxToolIterations as number,
              maxRuntimeMs: maxRuntimeMs as number,
            });
            store.transition(run.id, "running");
          } finally {
            store.close();
          }
        } catch (error) {
          await unlink(resolve(sessionsDir(), `${sessionId}.json`)).catch(() => {});
          if (worktree) {
            await worktreeManager.discard(worktree).catch((cleanupError) => {
              logger.warn("server: failed to clean up uninitialized run worktree", { error: String(cleanupError), runId });
            });
          }
          throw error;
        }
        const active: ActiveSession = {
          sessionFile,
          messages,
          executor,
          sseClients: new Set(),
          runId: run.id,
          allowedTools: toolNames,
          maxToolIterations: run.maxToolIterations,
          maxRuntimeMs: run.maxRuntimeMs,
        };
        activeSessions.set(sessionId, active);
        activeRuns.set(run.id, active);
        launchAgentTurnForSession(active, config, false);
        json(res, 202, {
          runId: run.id,
          sessionId,
          status: "running",
          ...(run.branch ? { branch: run.branch, worktreePath: run.worktreePath } : {}),
        });
        return;
      }
      if (runPathMatch) {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before accessing unattended runs" });
          return;
        }
        const runId = runPathMatch[1]!;
        const suffix = runPathMatch[2];
        const store = new RunStore();
        try {
          const run = store.getRun(runId);
          if (!run) {
            notFound(res, `run ${runId} not found`);
            return;
          }
          if (suffix === "events" && method === "GET") {
            json(res, 200, { events: store.listEvents(runId) });
            return;
          }
          if (suffix === "cancel" && method === "POST") {
            if (run.status === "queued" || run.status === "running" || run.status === "waiting") {
              activeRuns.get(runId)?.controller?.abort();
              store.transition(runId, "cancelled", "cancelled_by_client");
              store.cancelTimersForRun(runId);
            }
            json(res, 200, { run: store.getRun(runId) });
            return;
          }
          if (!suffix && method === "GET") {
            json(res, 200, { run });
            return;
          }
        } finally {
          store.close();
        }
      }

      // SSE event stream
      if (pathname === "/event" && method === "GET") {
        const client = createSseStream(res);
        client.send("server.connected", { timestamp: Date.now() });
        // Client is kept alive; cleanup happens on disconnect
        return;
      }

      // List sessions
      if (pathname === "/session" && method === "GET") {
        const cwd = url.searchParams.get("cwd") ?? undefined;
        const sessions = await listSessions(30, cwd);
        json(res, 200, { sessions });
        return;
      }

      // Get session
      const sessionMatch = pathname.match(/^\/session\/([^/]+)$/);
      if (sessionMatch && method === "GET") {
        const sessionId = sessionMatch[1]!;
        const active = activeSessions.get(sessionId);
        if (active) {
          json(res, 200, {
            id: active.sessionFile.id,
            cwd: active.sessionFile.cwd,
            model: active.sessionFile.model,
            messages: active.messages,
            title: active.sessionFile.title,
            updatedAt: active.sessionFile.updatedAt,
          });
          return;
        }
        try {
          const file = await loadSession(resolve(sessionsDir(), `${sessionId}.json`));
          json(res, 200, {
            id: file.id,
            cwd: file.cwd,
            model: file.model,
            messages: file.messages,
            title: file.title,
            updatedAt: file.updatedAt,
          });
          return;
        } catch {
          notFound(res, `session ${sessionId} not found`);
          return;
        }
      }

      // Delete session
      if (sessionMatch && method === "DELETE") {
        const sessionId = sessionMatch[1]!;
        activeSessions.delete(sessionId);
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(resolve(sessionsDir(), `${sessionId}.json`));
        } catch {
          // ignore
        }
        json(res, 200, { deleted: sessionId });
        return;
      }

      // Prompt (new session)
      if (pathname === "/prompt" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        const model = typeof body.model === "string" ? body.model : (config.model ?? DEFAULT_MODEL);
        const cwd = typeof body.cwd === "string" ? body.cwd : process.cwd();
        const title = typeof body.title === "string" ? body.title : undefined;
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
        const allowAll = body.allowAll === true;

        if (!prompt) {
          badRequest(res, "prompt is required");
          return;
        }

        const { makeSessionId } = await import("../sessions.js");
        const sessionId = makeSessionId(prompt);
        const sessionFile: SessionFile = {
          id: sessionId,
          cwd,
          model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          title,
        };

        const executor = new ToolExecutor(ALL_TOOLS);
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt({ cwd, tools: ALL_TOOLS, model, preferPullRequests: config.preferPullRequests }),
          },
        ];

        const resolvedFiles = await resolveFiles(files, cwd);
        const userContent = await buildUserMessage(prompt, resolvedFiles, cwd);
        messages.push({ role: "user", content: userContent });

        const active: ActiveSession = {
          sessionFile,
          messages,
          executor,
          sseClients: new Set(),
        };
        activeSessions.set(sessionId, active);

        // Start agent turn in background
        launchAgentTurnForSession(active, config, allowAll);

        json(res, 202, { sessionId, status: "started" });
        return;
      }

      // Follow-up prompt to existing session
      if (pathname === "/session/:id/prompt" && method === "POST") {
        // Actually the regex below handles this
      }

      const sessionPromptMatch = pathname.match(/^\/session\/([^/]+)\/prompt$/);
      if (sessionPromptMatch && method === "POST") {
        const sessionId = sessionPromptMatch[1]!;
        const active = activeSessions.get(sessionId);
        if (!active) {
          notFound(res, `session ${sessionId} not found or expired`);
          return;
        }

        const body = (await readBody(req)) as Record<string, unknown>;
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
        const allowAll = body.allowAll === true;

        if (!prompt) {
          badRequest(res, "prompt is required");
          return;
        }

        const resolvedFiles = await resolveFiles(files, active.sessionFile.cwd);
        const userContent = await buildUserMessage(prompt, resolvedFiles, active.sessionFile.cwd);
        active.messages.push({ role: "user", content: userContent });

        launchAgentTurnForSession(active, config, allowAll);

        json(res, 202, { sessionId, status: "started" });
        return;
      }

      // Not found
      notFound(res, `unknown endpoint: ${method} ${pathname}`);
    } catch (err) {
      logger.error("server: request error", { error: (err as Error).message, path: pathname });
      json(res, 500, { error: (err as Error).message });
    }
  }

  function cleanup(): void {
    wakeScheduler.dispose();
    for (const [, active] of activeSessions) {
      active.controller?.abort();
      for (const client of active.sseClients) {
        client.close();
      }
    }
    activeRuns.clear();
    activeSessions.clear();
  }

  return { handleRequest, cleanup };
}

function launchAgentTurnForSession(active: ActiveSession, config: KimiConfig, allowAll: boolean): void {
  void runAgentTurnForSession(active, config, allowAll).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("server: agent turn startup failed", { sessionId: active.sessionFile.id, error: message });
    active.running = false;
    active.controller = undefined;
    if (!active.runId) return;
    try {
      const store = new RunStore();
      try {
        const run = store.getRun(active.runId);
        if (run && ["queued", "running", "waiting"].includes(run.status)) {
          store.transition(run.id, "failed", `server_turn_start_failed:${message}`.slice(0, 500));
          store.cancelTimersForRun(run.id);
        }
      } finally {
        store.close();
      }
    } catch (storeError) {
      logger.error("server: failed to record agent startup failure", {
        runId: active.runId,
        error: storeError instanceof Error ? storeError.message : String(storeError),
      });
    }
  });
}

async function runAgentTurnForSession(active: ActiveSession, config: KimiConfig, allowAll: boolean): Promise<void> {
  if (active.running) return;
  active.running = true;
  const controller = new AbortController();
  active.controller = controller;
  const { sessionFile, messages, executor } = active;
  let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
  let yielded = false;
  let runStore: RunStore | undefined;
  let run: RunRecord | undefined;
  if (active.runId) {
    runStore = new RunStore();
    run = runStore.getRun(active.runId);
    if (!run || run.status !== "running") {
      runStore.close();
      active.running = false;
      return;
    }
    const elapsed = run.startedAt ? Date.now() - run.startedAt : 0;
    const remainingMs = Math.max(1, run.maxRuntimeMs - elapsed);
    runtimeTimer = setTimeout(() => controller.abort(new Error("max_runtime_exceeded")), remainingMs);
    runtimeTimer.unref();
  }

  const callbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      for (const client of active.sseClients) {
        client.send("assistant.delta", { delta });
      }
    },
    onToolCallFinalized: (call) => {
      for (const client of active.sseClients) {
        client.send("tool.call", {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    },
    onToolResult: (result) => {
      for (const client of active.sseClients) {
        client.send("tool.result", {
          toolCallId: result.tool_call_id,
          name: result.name,
          content: result.content,
          ok: result.ok,
        });
      }
    },
    onUsage: (usage) => {
      for (const client of active.sseClients) {
        client.send("usage.update", {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        });
      }
    },
    onWarning: (msg) => {
      for (const client of active.sseClients) {
        client.send("warning", { message: msg });
      }
    },
    onRunYield: (request) => {
      if (!runStore || !active.runId || request.runId !== active.runId) return;
      runStore.transition(active.runId, "waiting", `timer:${request.timerId}`);
      yielded = true;
    },
    askPermission: async ({ tool, args }) => {
      if (active.runId) {
        if (active.allowedTools?.has(tool.name)) return "allow";
        return "deny";
      }
      if (allowAll) return "allow";

      // Evaluate config-based permission rules
      if (config.permissions) {
        const rule = evaluatePermissionRules({ tool: tool.name, args, cwd: sessionFile.cwd }, config.permissions);
        if (rule === "allow") return "allow";
        if (rule === "deny") {
          for (const client of active.sseClients) {
            client.send("permission.denied", { tool: tool.name, args, reason: "config_rule" });
          }
          return "deny";
        }
      }

      for (const client of active.sseClients) {
        client.send("permission.request", { tool: tool.name, args });
      }
      // In server mode without allowAll, we auto-deny after a brief wait
      // since there's no interactive user. Future: support async permission
      // approval via a separate endpoint.
      return "deny";
    },
  };

  try {
    if (run && runStore) {
      const remainingIterations = run.maxToolIterations - runStore.countToolIterations(run.id);
      if (remainingIterations <= 0) {
        runStore.transition(run.id, "failed", "max_tool_iterations_exceeded");
        return;
      }
      const tools = ALL_TOOLS.filter((tool) => active.allowedTools?.has(tool.name));
      await runAgentTurn({
        ...llmAuthFromConfig(config),
        model: sessionFile.model,
        reasoningEffort: config.reasoningEffort,
        sessionId: sessionFile.id,
        runId: run.id,
        runsDbPath: process.env.AUTOPILOT_RUNS_DB,
        messages,
        tools,
        executor,
        cwd: sessionFile.cwd,
        signal: controller.signal,
        maxToolIterations: remainingIterations,
        maxTotalToolIterations: remainingIterations,
        toolLimitBehavior: "stop",
        codeMode: false,
        allowDirectPush: config.allowDirectPush,
        preferPullRequests: config.preferPullRequests,
        callbacks,
        onIterationEnd: async (updatedMessages) => {
          sessionFile.messages = updatedMessages;
          sessionFile.updatedAt = new Date().toISOString();
          await saveSession(sessionFile);
          return updatedMessages;
        },
      });
    } else {
      await runAgentTurn({
        ...llmAuthFromConfig(config),
        model: sessionFile.model,
        reasoningEffort: config.reasoningEffort,
        sessionId: sessionFile.id,
        messages,
        tools: ALL_TOOLS,
        executor,
        cwd: sessionFile.cwd,
        signal: controller.signal,
        codeMode: config.codeMode,
        allowDirectPush: config.allowDirectPush,
        preferPullRequests: config.preferPullRequests,
        callbacks,
      });
    }

    sessionFile.messages = messages;
    sessionFile.updatedAt = new Date().toISOString();
    await saveSession(sessionFile);
    if (runStore && active.runId) {
      const current = runStore.getRun(active.runId);
      if (current?.status === "running" && !yielded) runStore.transition(active.runId, "completed");
    }

    for (const client of active.sseClients) {
      client.send("session.completed", { sessionId: sessionFile.id });
    }
  } catch (err) {
    const message = (err as Error).message;
    logger.error("server: agent turn failed", { sessionId: sessionFile.id, error: message });
    if (runStore && active.runId) {
      const current = runStore.getRun(active.runId);
      if (current?.status === "running") {
        const reason = controller.signal.aborted && Date.now() - (run?.startedAt ?? Date.now()) >= (run?.maxRuntimeMs ?? Infinity)
          ? "max_runtime_exceeded"
          : message;
        runStore.transition(active.runId, "failed", reason);
      }
    }
    for (const client of active.sseClients) {
      client.send("error", { message, sessionId: sessionFile.id });
    }
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    active.controller = undefined;
    active.running = false;
    runStore?.close();
  }
}
