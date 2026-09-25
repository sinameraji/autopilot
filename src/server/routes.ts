/**
 * HTTP route handlers for the KimiFlare headless server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
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
import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { encodeImageFile, isImagePath } from "../util/image.js";
import { glob } from "../util/glob.js";

interface ActiveSession {
  sessionFile: SessionFile;
  messages: ChatMessage[];
  executor: ToolExecutor;
  sseClients: Set<SseClient>;
}

const activeSessions = new Map<string, ActiveSession>();

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
        runAgentTurnForSession(active, config, allowAll);

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

        runAgentTurnForSession(active, config, allowAll);

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
    for (const [, active] of activeSessions) {
      for (const client of active.sseClients) {
        client.close();
      }
    }
    activeSessions.clear();
  }

  return { handleRequest, cleanup };
}

async function runAgentTurnForSession(active: ActiveSession, config: KimiConfig, allowAll: boolean): Promise<void> {
  const controller = new AbortController();
  const { sessionFile, messages, executor } = active;

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
    askPermission: async ({ tool, args }) => {
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

    sessionFile.messages = messages;
    sessionFile.updatedAt = new Date().toISOString();
    await saveSession(sessionFile);

    for (const client of active.sseClients) {
      client.send("session.completed", { sessionId: sessionFile.id });
    }
  } catch (err) {
    const message = (err as Error).message;
    logger.error("server: agent turn failed", { sessionId: sessionFile.id, error: message });
    for (const client of active.sseClients) {
      client.send("error", { message, sessionId: sessionFile.id });
    }
  }
}
