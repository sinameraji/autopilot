import { readSSE } from "../util/sse.js";
import { KimiApiError } from "../util/errors.js";
import { getUserAgent } from "../util/version.js";
import { jsonReplacer, sanitizeString, stableStringify } from "./messages.js";
import type { ChatMessage, ReasoningDetail, ToolDef, Usage } from "./messages.js";
import { logger } from "../util/logger.js";
import { getLogSessionId, getLogTurnId } from "../util/log-sink.js";
import {
  isLlmDumpEnabled,
  writeLlmDump,
  computeBreakdown,
  type LlmDumpRecord,
  type LlmDumpResponse,
} from "../util/llm-dump.js";
import { getModelOrInfer, vendorOf } from "../models/registry.js";
import { openRouterHeaders, openRouterUrl, OPENROUTER_KEYS_URL } from "../models/openrouter.js";
import { resolveCustomEndpoint, customChatCompletionsUrl, type CustomEndpoint } from "./custom-endpoint.js";

export type KimiEvent =
  | { type: "response_meta"; meta: ResponseMeta }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_details"; details: ReasoningDetail[] }
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; argsDelta: string }
  | { type: "tool_call_complete"; index: number; id: string; name: string; arguments: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null; usage: Usage | null };

export interface RunKimiOpts {
  /**
   * The user's OpenRouter API key, sent as `Authorization: Bearer`. Required
   * unless a custom endpoint is in effect. Build it (with `customEndpoint`
   * and `provider`) from config via `llmAuthFromConfig()`.
   */
  openrouterApiKey?: string;
  /** Extra OpenRouter provider-routing preferences (config: openrouterProvider). */
  provider?: OpenRouterProviderPrefs;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  sessionId?: string;
  requestId?: string;
  /** Abort the stream if no data arrives for this many milliseconds. Default 60000. */
  idleTimeoutMs?: number;
  /** Once the first byte arrives, tighten the idle timeout to this value.
   *  Default 30000 — a live stream stalling mid-flight should surface fast. */
  postFirstByteIdleTimeoutMs?: number;
  /**
   * Custom OpenAI-compatible endpoint (see src/agent/custom-endpoint.ts).
   * When set — or when KIMIFLARE_BASE_URL is in the environment — the request
   * goes to `<baseUrl>/chat/completions` with `Authorization: Bearer <apiKey>`
   * instead of OpenRouter. Model ids pass through in the body unchanged.
   */
  customEndpoint?: CustomEndpoint;
}

/**
 * OpenRouter `provider` routing object (subset we pass through). See
 * https://openrouter.ai/docs/guides/routing/provider-selection. Setting
 * `order` or `sort` disables sticky routing (prompt-cache locality) and
 * load balancing, so they're opt-in only.
 */
export interface OpenRouterProviderPrefs {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  quantizations?: string[];
  sort?: "price" | "throughput" | "latency";
  max_price?: Record<string, number>;
}

/**
 * Per-response metadata OpenRouter reports in the stream. `generationId` is
 * the key for the authoritative cost lookup (GET /generation?id=…, see
 * usage-tracker.ts); `provider` is the upstream OpenRouter routed to.
 */
export interface ResponseMeta {
  generationId?: string;
  model?: string;
  provider?: string;
}

const MAX_ATTEMPTS = 5;

function isRetryable(err: KimiApiError, attempt: number): boolean {
  if (attempt >= MAX_ATTEMPTS - 1) return false;
  if (err.httpStatus === 408 || err.httpStatus === 429) return true;
  // 402 "in-flight budget" is transient (a concurrent request is holding the
  // key's remaining credit); a plain out-of-credits 402 is not.
  if (err.httpStatus === 402 && /in.?flight/i.test(err.message)) return true;
  if (err.httpStatus !== undefined && err.httpStatus >= 500 && err.httpStatus < 600) return true;
  if (err.message.includes("Internal server error")) return true;
  return false;
}

export async function* runKimi(opts: RunKimiOpts): AsyncGenerator<KimiEvent, void, void> {
  // Custom endpoint wins over OpenRouter. The env fallback means side-call
  // paths (memory extraction, summarization, …) are rerouted too.
  const customEndpoint = opts.customEndpoint ?? resolveCustomEndpoint();
  const requestId = opts.requestId ?? crypto.randomUUID();
  const { url, headers: targetHeaders } = buildKimiRequestTarget(opts, customEndpoint);
  // Per-model capability gates, from the OpenRouter catalog. OpenRouter drops
  // params a model doesn't support, but a few models reject a supported param
  // outright for non-default values (Kimi K3 only allows temperature=1).
  const entry = getModelOrInfer(opts.model);
  const supportsTemperature = entry.supports.temperature !== false;
  const supportsReasoning = entry.supports.reasoning === true;

  const hasTools = !!opts.tools && opts.tools.length > 0;
  const maxTokens = opts.maxCompletionTokens ?? 16384;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: sanitizeMessagesForApi(opts.messages),
    stream: true,
  };
  if (customEndpoint) {
    // The host's gateway gets the plain OpenAI-shaped request.
    if (hasTools) Object.assign(body, { tools: opts.tools, tool_choice: "auto", parallel_tool_calls: true });
    if (supportsTemperature) body.temperature = opts.temperature ?? 0.2;
    body.max_completion_tokens = maxTokens;
    if (opts.reasoningEffort && supportsReasoning) body.reasoning_effort = opts.reasoningEffort;
    // OpenAI's streaming API omits `usage` unless asked; OpenRouter always
    // sends it (and documents this flag as a no-op), so only custom
    // endpoints get it.
    body.stream_options = { include_usage: true };
  } else {
    // Only send optional parameters the model's endpoints accept. With
    // `require_parameters` (below) a single unsupported parameter would leave
    // no eligible provider and the request 404s — and most models accept
    // e.g. `max_tokens` but not `max_completion_tokens`, or omit
    // `parallel_tool_calls`. For a model we have no parameter list for, send
    // only the near-universal ones and skip require_parameters.
    const known = entry.parameters ? new Set(entry.parameters) : null;
    const accepts = (p: string) => (known ? known.has(p) : p === "tools" || p === "max_tokens" || p === "temperature");
    if (hasTools) {
      body.tools = opts.tools;
      if (accepts("tool_choice")) body.tool_choice = "auto";
      if (accepts("parallel_tool_calls")) body.parallel_tool_calls = true;
    }
    if (supportsTemperature && accepts("temperature")) body.temperature = opts.temperature ?? 0.2;
    if (accepts("max_completion_tokens")) body.max_completion_tokens = maxTokens;
    else if (accepts("max_tokens")) body.max_tokens = maxTokens;
    if (opts.reasoningEffort && supportsReasoning) {
      if (accepts("reasoning_effort")) body.reasoning_effort = opts.reasoningEffort;
      else if (accepts("reasoning")) body.reasoning = { effort: opts.reasoningEffort };
    }

    // Sticky routing: OpenRouter pins a session to the provider that served
    // it, so the prompt-prefix cache stays warm across turns (10 min idle
    // window). Without it OpenRouter hashes the first system + user message,
    // which also works but can't tell two sessions with the same opener apart.
    if (opts.sessionId) body.session_id = opts.sessionId.slice(0, 256);
    // Only route to providers that support every parameter we send — above
    // all `tools`: a few endpoints for some models serve the model without
    // tool calling, and a coding agent is useless there. Tool-calling quality
    // ordering (Auto Exacto) is applied by OpenRouter on top of this. Skipped
    // when the model's parameter list is unknown (we can't guarantee a match).
    const provider = { ...(known ? { require_parameters: true } : {}), ...(opts.provider ?? {}) };
    if (Object.keys(provider).length > 0) body.provider = provider;
    // Anthropic models only cache with explicit breakpoints; the top-level
    // directive makes OpenRouter place them automatically. Everyone else
    // kimiflare defaults to (Moonshot, DeepSeek, Z.AI, OpenAI, …) caches
    // implicitly.
    if (vendorOf(opts.model) === "anthropic") body.cache_control = { type: "ephemeral" };
  }

  // Debug-only payload dump (KIMIFLARE_DUMP_LLM=1). Pure post-assembly
  // observer: reads the already-finalized body immediately before fetch — it
  // cannot alter what is sent. See src/util/llm-dump.ts.
  let dumpRecord: LlmDumpRecord | null = null;
  if (isLlmDumpEnabled()) {
    const dumpMessages = body.messages as ChatMessage[];
    const dumpTools = (body.tools as ToolDef[] | undefined) ?? [];
    const { messages: _m, tools: _t, ...params } = body;
    const dumpResponse: LlmDumpResponse = {
      text: "",
      reasoning: "",
      toolCalls: [],
      finishReason: null,
      usage: null,
    };
    dumpRecord = {
      meta: {
        requestId,
        sessionId: opts.sessionId ?? getLogSessionId(),
        turnId: getLogTurnId(),
        model: opts.model,
        url,
        ts: new Date().toISOString(),
      },
      request: {
        system: dumpMessages.filter((m) => m.role === "system"),
        messages: dumpMessages,
        tools: dumpTools,
        params,
        rawSerialized: stableStringify(body, jsonReplacer),
      },
      breakdown: computeBreakdown(dumpMessages, dumpTools),
      response: dumpResponse,
    };
  }

  logger.debug("runKimi:request", { requestId, attempt: 0, model: opts.model });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
        ...targetHeaders,
      };
      if (opts.sessionId) headers["X-Session-ID"] = opts.sessionId;
      headers["X-Request-ID"] = requestId;
      res = await fetch(url, {
        method: "POST",
        headers,
        body: stableStringify(body, jsonReplacer),
        signal: opts.signal,
      });
    } catch (fetchErr) {
      if (isAbortError(fetchErr)) throw fetchErr;
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      logger.warn("runKimi:fetch_error", { requestId, attempt, error: msg });
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = Math.random() * (500 * 2 ** attempt);
        await sleep(delay, opts.signal);
        continue;
      }
      throw new KimiApiError(`kimiflare: network error: ${msg}`, undefined, undefined);
    }

    const contentType = res.headers.get("content-type") ?? "";

    // Errors come back as JSON (not SSE): OpenRouter's { error: { code,
    // message } } or an OpenAI-style error from a custom endpoint. Retry the
    // transient ones (408/429/5xx); surface everything else with a fix.
    if (!contentType.includes("text/event-stream")) {
      if (res.bodyUsed) {
        throw new KimiApiError(
          `kimiflare: Received HTTP ${res.status} but could not read the response body. Please try again.`,
          undefined,
          res.status,
        );
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* ignore */
      }
      const err = extractApiError(parsed, text);
      const msg = err?.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`;
      const status = err?.status ?? res.status;
      const apiErr = new KimiApiError(
        `kimiflare: ${describeHttpError(opts.model, status, msg, customEndpoint)}`,
        err?.code,
        status,
      );
      if (isRetryable(apiErr, attempt)) {
        const isRateLimit = apiErr.httpStatus === 429;
        const baseDelay = isRateLimit ? 2000 : 500;
        // OpenRouter sends Retry-After (seconds) on 429/503; honour it, capped
        // so a long server hint can't wedge an interactive turn.
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 30_000)
            : Math.random() * (baseDelay * 2 ** attempt);
        logger.warn("runKimi:retrying", { requestId, attempt, code: apiErr.code, httpStatus: apiErr.httpStatus, delay });
        await sleep(delay, opts.signal);
        continue;
      }
      throw apiErr;
    }

    if (!res.body) throw new KimiApiError("kimiflare: empty response body", undefined, res.status);

    logger.debug("runKimi:stream_start", { requestId });
    try {
      for await (const ev of parseStream(res.body, opts.signal, opts.idleTimeoutMs, opts.postFirstByteIdleTimeoutMs)) {
        if (dumpRecord) accumulateDumpResponse(dumpRecord.response, ev);
        yield ev;
      }
    } finally {
      // Write even on abort/error so partial turns are still captured.
      if (dumpRecord) {
        dumpRecord.meta.attempt = attempt;
        writeLlmDump(dumpRecord);
      }
    }
    logger.debug("runKimi:stream_end", { requestId });
    return;
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Turn an HTTP error into the message the user sees, with the concrete fix
 * for the cases that have one (bad key, no credits, unknown model).
 */
function describeHttpError(
  model: string,
  status: number,
  msg: string,
  customEndpoint: CustomEndpoint | null,
): string {
  if (customEndpoint) {
    if (status === 401 || status === 403) {
      return [
        `${model} rejected the request (HTTP ${status}): ${msg || "authentication failed"}.`,
        ``,
        `Check that KIMIFLARE_API_KEY (or \`apiKey\` in config) matches what ${customEndpoint.baseUrl} expects.`,
      ].join("\n");
    }
    return msg;
  }
  if (status === 401) {
    return [
      `OpenRouter rejected your API key (HTTP 401): ${msg || "invalid key"}.`,
      ``,
      `Fix: run  /key set <your-key>  with a key from ${OPENROUTER_KEYS_URL}`,
      `(or set OPENROUTER_API_KEY in the environment).`,
    ].join("\n");
  }
  if (status === 402) {
    return [
      `Your OpenRouter account is out of credits (HTTP 402): ${msg}.`,
      ``,
      `Add credits at https://openrouter.ai/settings/credits, or pick a free model with  /model  (look for the "Free" section).`,
    ].join("\n");
  }
  if (status === 403) {
    return [
      `OpenRouter refused the request (HTTP 403): ${msg}.`,
      ``,
      `This is usually a moderation or guardrail block on the key, or a model your account can't access.`,
    ].join("\n");
  }
  if (status === 404 && /model|endpoint/i.test(msg)) {
    return [
      `OpenRouter can't serve ${model} (HTTP 404): ${msg}.`,
      ``,
      `Pick another model with  /model .`,
    ].join("\n");
  }
  return msg;
}

/** Fold a streamed event into the debug dump's response accumulator.
 *  Read-only side-effect on the dump record — never affects the yielded
 *  stream. Only invoked when KIMIFLARE_DUMP_LLM is enabled. */
function accumulateDumpResponse(resp: LlmDumpResponse, ev: KimiEvent): void {
  switch (ev.type) {
    case "text":
      resp.text += ev.delta;
      break;
    case "reasoning":
      resp.reasoning += ev.delta;
      break;
    case "tool_call_complete":
      resp.toolCalls.push({ name: ev.name, arguments: ev.arguments });
      break;
    case "usage":
      resp.usage = ev.usage;
      break;
    case "done":
      resp.finishReason = ev.finishReason;
      if (ev.usage) resp.usage = ev.usage;
      break;
  }
}

/** Validate that a model id is OpenRouter-shaped before it goes on the wire.
 *
 *  Accepted: "<vendor>/<model>[:variant]", optionally with OpenRouter's "~"
 *  alias prefix — e.g. "moonshotai/kimi-k2.6", "deepseek/deepseek-r1:free",
 *  "~moonshotai/kimi-latest", "openrouter/auto". Vendor must be
 *  alnum/-/_; the model segment may contain ./-/_ but no slashes or
 *  whitespace. */
export function validateModelId(model: string): void {
  if (!model) throw new KimiApiError(`Invalid model ID: ${model}`, 400);
  if (/^~?[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(:[a-zA-Z0-9._-]+)?$/.test(model)) return;
  throw new KimiApiError(`Invalid model ID: ${model}`, 400);
}

function buildKimiRequestTarget(
  opts: RunKimiOpts,
  customEndpoint: CustomEndpoint | null,
): { url: string; headers: Record<string, string> } {
  // Custom OpenAI-compatible endpoint: the host app owns routing and auth.
  // The model id only rides in the JSON body on this path, so any non-empty
  // id passes through.
  if (customEndpoint) {
    if (!opts.model) throw new KimiApiError(`Invalid model ID: ${opts.model}`, 400);
    return {
      url: customChatCompletionsUrl(customEndpoint.baseUrl),
      headers: customEndpoint.apiKey ? { Authorization: `Bearer ${customEndpoint.apiKey}` } : {},
    };
  }

  validateModelId(opts.model);
  if (!opts.openrouterApiKey) {
    throw new KimiApiError(
      [
        `kimiflare: no OpenRouter API key configured.`,
        ``,
        `Fix: run  /key set <your-key>  with a key from ${OPENROUTER_KEYS_URL}`,
        `(or set OPENROUTER_API_KEY in the environment).`,
      ].join("\n"),
      undefined,
      401,
    );
  }
  return {
    url: openRouterUrl("chat/completions"),
    headers: openRouterHeaders(opts.openrouterApiKey),
  };
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_POST_FIRST_BYTE_IDLE_TIMEOUT_MS = 30_000;

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  postFirstByteIdleTimeoutMs = DEFAULT_POST_FIRST_BYTE_IDLE_TIMEOUT_MS,
): AsyncGenerator<KimiEvent, void, void> {
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let lastUsage: Usage | null = null;
  let finishReason: string | null = null;
  let metaSent = false;

  for await (const dataStr of readSSE(body, signal, idleTimeoutMs, postFirstByteIdleTimeoutMs)) {
    if (dataStr === "[DONE]") break;
    let chunk: StreamChunk | null = null;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (!chunk) continue;

    // A failure after the stream has started (upstream provider died
    // mid-generation) arrives as a chunk carrying `error`, not an HTTP status.
    if (chunk.error) {
      const code = typeof chunk.error.code === "number" ? chunk.error.code : undefined;
      throw new KimiApiError(
        `kimiflare: ${chunk.error.message ?? "the model provider failed mid-response"}`,
        undefined,
        code,
      );
    }

    // Every OpenRouter chunk carries the generation id; report it once.
    if (!metaSent && typeof chunk.id === "string" && chunk.id) {
      metaSent = true;
      yield {
        type: "response_meta",
        meta: {
          generationId: chunk.id,
          ...(typeof chunk.model === "string" ? { model: chunk.model } : {}),
          ...(typeof chunk.provider === "string" ? { provider: chunk.provider } : {}),
        },
      };
    }

    if (chunk.usage) {
      lastUsage = chunk.usage;
      yield { type: "usage", usage: chunk.usage };
    }

    // OpenAI-compatible format: { choices: [{ delta: { content: "..." } }] }
    const choice = chunk.choices?.[0];
    if (choice) {
      const d = choice.delta;
      if (d) {
        // OpenRouter streams reasoning as `reasoning`; OpenAI-compatible
        // custom endpoints (vLLM, Moonshot-style) use `reasoning_content`.
        const reasoningDelta = d.reasoning ?? d.reasoning_content;
        if (typeof reasoningDelta === "string" && reasoningDelta.length) {
          yield { type: "reasoning", delta: reasoningDelta };
        }
        // Structured reasoning (Claude signatures, OpenAI/Gemini encrypted
        // blocks). Must be echoed back verbatim during tool use; the loop
        // merges these by `index` (see mergeReasoningDetails in messages.ts).
        if (Array.isArray(d.reasoning_details) && d.reasoning_details.length) {
          yield { type: "reasoning_details", details: d.reasoning_details };
        }
        if (typeof d.content === "string" && d.content.length) {
          yield { type: "text", delta: d.content };
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let buf = toolCalls.get(idx);
            const incomingName = tc.function?.name ?? null;
            const incomingId = tc.id ?? null;
            if (!buf) {
              buf = { id: incomingId ?? `tc_${idx}`, name: incomingName ?? "", args: "" };
              toolCalls.set(idx, buf);
              if (buf.name) {
                yield { type: "tool_call_start", index: idx, id: buf.id, name: buf.name };
              }
            } else {
              if (!buf.name && incomingName) {
                buf.name = incomingName;
                yield { type: "tool_call_start", index: idx, id: buf.id, name: buf.name };
              }
              if (buf.id.startsWith("tc_") && incomingId) buf.id = incomingId;
            }
            const argDelta = tc.function?.arguments;
            if (typeof argDelta === "string" && argDelta.length) {
              buf.args += argDelta;
              yield { type: "tool_call_args", index: idx, argsDelta: argDelta };
            }
          }
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  for (const [idx, buf] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!buf.name) continue;
    yield {
      type: "tool_call_complete",
      index: idx,
      id: buf.id,
      name: buf.name,
      arguments: buf.args,
    };
  }

  yield { type: "done", finishReason, usage: lastUsage };
}

interface StreamChunk {
  id?: string;
  model?: string;
  provider?: string;
  choices?: StreamChoice[];
  usage?: Usage;
  error?: { code?: number | string; message?: string };
}
interface StreamChoice {
  delta?: StreamDelta;
  finish_reason?: string | null;
  index?: number;
}
interface StreamDelta {
  role?: string | null;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: ReasoningDetail[];
  tool_calls?: StreamToolCall[];
}
interface StreamToolCall {
  index?: number;
  id?: string | null;
  type?: string | null;
  function?: { name?: string | null; arguments?: string | null };
}

function sanitizeMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    let next: ChatMessage = m;
    if (Array.isArray(m.content)) {
      next = {
        ...m,
        content: m.content.map((part) =>
          part.type === "text" ? { ...part, text: sanitizeString(part.text) } : part,
        ),
      };
    }
    if (!next.tool_calls || next.tool_calls.length === 0) return next;
    return {
      ...next,
      tool_calls: next.tool_calls.map((tc) => ({
        ...tc,
        function: {
          name: tc.function.name,
          arguments: validateJsonArguments(tc.function.arguments),
        },
      })),
    };
  });
}

function validateJsonArguments(raw: string): string {
  if (!raw || !raw.trim()) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

function extractApiError(
  parsed: unknown,
  rawText?: string,
): { code?: number; status?: number; message?: string } | null {
  if (parsed && typeof parsed === "object") {
    // OpenRouter / OpenAI format: { error: { code, message, metadata? } }.
    // OpenRouter's `code` is the HTTP status; upstream provider detail (the
    // actual reason a provider refused) sits in metadata.raw.
    const wrapped = (parsed as { error?: unknown }).error;
    if (wrapped && typeof wrapped === "object") {
      const e = wrapped as { code?: number | string; message?: string; metadata?: { raw?: unknown; provider_name?: string } };
      const status = typeof e.code === "number" ? e.code : undefined;
      let message = typeof e.message === "string" ? e.message : undefined;
      const raw = e.metadata?.raw;
      if (message && typeof raw === "string" && raw && !message.includes(raw)) {
        const who = e.metadata?.provider_name ? `${e.metadata.provider_name}: ` : "";
        message = `${message} (${who}${raw.slice(0, 300)})`;
      }
      return { status, message };
    }
    if (typeof wrapped === "string") return { message: wrapped };

    // Bare OpenAI-compatible format: { object: "error", message, code }
    const oai = parsed as { object?: string; message?: string; code?: string | number };
    if (oai.object === "error" && typeof oai.message === "string") {
      const codeNum = typeof oai.code === "number" ? oai.code : undefined;
      return { code: codeNum, message: oai.message };
    }
  }

  // Fallback: try to grab any "message" field from raw JSON text with a regex
  if (rawText) {
    const msgMatch = rawText.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch?.[1]) {
      return { message: msgMatch[1] };
    }
  }

  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
