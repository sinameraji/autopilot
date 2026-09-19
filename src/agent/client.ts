import { readSSE } from "../util/sse.js";
import { KimiApiError, KillSwitchError, detectKillSwitch } from "../util/errors.js";
import { getUserAgent } from "../util/version.js";
import { jsonReplacer, sanitizeString, stableStringify } from "./messages.js";
import type { ChatMessage, ToolDef, Usage } from "./messages.js";
import { logger } from "../util/logger.js";
import { getLogSessionId, getLogTurnId } from "../util/log-sink.js";
import {
  isLlmDumpEnabled,
  writeLlmDump,
  computeBreakdown,
  type LlmDumpRecord,
  type LlmDumpResponse,
} from "../util/llm-dump.js";
import { getModelOrInfer, isUnifiedEligible, routeFor, type ModelProvider } from "../models/registry.js";
import { DEFAULT_MODEL, DEFAULT_CLOUD_MODEL } from "../config.js";
import { resolveCustomEndpoint, customChatCompletionsUrl, type CustomEndpoint } from "./custom-endpoint.js";

export type KimiEvent =
  | { type: "gateway_meta"; meta: GatewayMeta }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; argsDelta: string }
  | { type: "tool_call_complete"; index: number; id: string; name: string; arguments: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null; usage: Usage | null };

export interface RunKimiOpts {
  accountId: string;
  apiToken: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  sessionId?: string;
  gateway?: AiGatewayOptions;
  cloudMode?: boolean;
  cloudToken?: string;
  cloudDeviceId?: string;
  requestId?: string;
  /** Per-provider API keys (BYOK) forwarded to AI Gateway as cf-aig-authorization headers. */
  providerKeys?: Partial<Record<ModelProvider, string>>;
  /**
   * Per-provider alias names referencing keys stored in Cloudflare Secrets Store
   * (scope: ai_gateway). When present, kimi-code sends cf-aig-byok-alias instead
   * of the raw provider key — the key never re-enters this process after the
   * one-time upload. Takes precedence over `providerKeys`.
   */
  providerKeyAliases?: Partial<Record<ModelProvider, string>>;
  /** When true, omit BYOK headers entirely and let CF Unified Billing pay the upstream provider. */
  unifiedBilling?: boolean;
  /** Abort the stream if no data arrives for this many milliseconds. Default 60000. */
  idleTimeoutMs?: number;
  /** Once the first byte arrives, tighten the idle timeout to this value.
   *  Default 30000 — a live stream stalling mid-flight should surface fast. */
  postFirstByteIdleTimeoutMs?: number;
  /**
   * Custom OpenAI-compatible endpoint (see src/agent/custom-endpoint.ts).
   * When set — or when KIMIFLARE_BASE_URL is in the environment — the request
   * goes to `<baseUrl>/chat/completions` with `Authorization: Bearer <apiKey>`
   * and every Cloudflare path (Workers AI, AI Gateway, cf-catalog, cloud
   * mode) is bypassed. Model ids pass through in the body unchanged.
   */
  customEndpoint?: CustomEndpoint;
}

export interface AiGatewayOptions {
  id: string;
  cacheTtl?: number;
  skipCache?: boolean;
  collectLogPayload?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface GatewayMeta {
  cacheStatus?: string;
  logId?: string;
  eventId?: string;
  model?: string;
}

const RETRYABLE_CODES = new Set([3040]); // "Capacity temporarily exceeded"
const MAX_ATTEMPTS = 5;

function cleanErrorMessage(msg: string): string {
  // Cloudflare Workers AI sometimes prefixes messages with redundant "AiError: "
  return msg.replace(/^(AiError:\s*)+/, "").trim();
}

function isRetryable(err: KimiApiError, attempt: number): boolean {
  if (attempt >= MAX_ATTEMPTS - 1) return false;
  if (err.code !== undefined && RETRYABLE_CODES.has(err.code)) return true;
  if (err.httpStatus === 429) return true;
  if (err.httpStatus !== undefined && err.httpStatus >= 500 && err.httpStatus < 600) return true;
  if (err.message.includes("Internal server error")) return true;
  return false;
}

export async function* runKimi(opts: RunKimiOpts): AsyncGenerator<KimiEvent, void, void> {
  // Custom endpoint wins over everything, including cloud mode. The env
  // fallback means side-call paths (memory extraction, summarization, …)
  // that build RunKimiOpts from raw accountId/apiToken are rerouted too.
  const customEndpoint = opts.customEndpoint ?? resolveCustomEndpoint();
  if (!customEndpoint && opts.cloudMode && !opts.cloudToken) {
    throw new KimiApiError("kimiflare: cloud mode requires a cloud token. Run `kimiflare auth cloud` to authenticate.", undefined, 401);
  }
  const requestId = opts.requestId ?? crypto.randomUUID();
  const { url, headers: gatewayHeaders } = buildKimiRequestTarget(opts, customEndpoint);
  const isCloudEndpoint = !customEndpoint && url.startsWith("https://api.kimiflare.com");
  // Per-model capability gates. Some providers reject params they don't
  // support — gpt-5/gpt-5-mini and claude-opus-4-7 reject any non-default
  // `temperature`; Groq's llama-3.3 rejects `reasoning_effort`. We look up the
  // capabilities once and conditionally include each field.
  const entry = getModelOrInfer(opts.model);
  const supportsTemperature = entry.supports.temperature !== false;
  const supportsReasoning = entry.supports.reasoning === true;

  // Universal Endpoint routes by the `model` body field. For Workers AI we
  // prefix with "workers-ai/" so /compat dispatches to the Workers AI provider
  // (e.g. "workers-ai/@cf/moonshotai/kimi-k2.7-code"). Cloud mode uses its own
  // shape and ignores this field. The direct Workers AI path (api.cloudflare.com)
  // also ignores the body model field because the model is already in the URL.
  const isDirectWorkersAi = !customEndpoint && url.includes("/ai/run/");
  // Custom endpoints receive the model id verbatim — the host's gateway owns
  // provider dispatch, so no workers-ai/ prefixing.
  const compatModel =
    !customEndpoint && entry.provider === "workers-ai" ? `workers-ai/${opts.model}` : opts.model;

  const body: Record<string, unknown> = {
    messages: sanitizeMessagesForApi(opts.messages),
    ...(opts.tools && opts.tools.length
      ? { tools: opts.tools, tool_choice: "auto", parallel_tool_calls: true }
      : {}),
    stream: true,
    ...(supportsTemperature ? { temperature: opts.temperature ?? 0.2 } : {}),
    max_completion_tokens: opts.maxCompletionTokens ?? 16384,
    ...(isCloudEndpoint || isDirectWorkersAi ? {} : { model: compatModel }),
    // OpenAI's streaming API omits `usage` by default — you have to explicitly
    // opt in via stream_options. Without this, the status bar's token /
    // context-% / cost columns stay blank. CF docs don't mention
    // stream_options but accept it transparently and forward it upstream;
    // providers that don't recognize the field ignore it.
    // Only relevant for the AI Gateway /compat path; direct Workers AI and
    // cloud mode use their own response shapes.
    ...(isCloudEndpoint || isDirectWorkersAi ? {} : { stream_options: { include_usage: true } }),
  };
  if (opts.reasoningEffort && supportsReasoning) {
    body.reasoning_effort = opts.reasoningEffort;
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
      // For custom endpoints the bearer (if any) rides in gatewayHeaders —
      // never fall back to the Cloudflare/cloud token, and send no
      // Authorization header at all when no apiKey is configured.
      const headers: Record<string, string> = {
        ...(customEndpoint
          ? {}
          : { Authorization: `Bearer ${opts.cloudMode && opts.cloudToken ? opts.cloudToken : opts.apiToken}` }),
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
        ...gatewayHeaders,
      };
      if (opts.sessionId) {
        headers["X-Session-ID"] = opts.sessionId;
        headers["x-session-affinity"] = opts.sessionId;
      }
      headers["X-Request-ID"] = requestId;
      res = await fetch(url, {
        method: "POST",
        headers,
        body: stableStringify(body, jsonReplacer),
        signal: opts.signal,
      });
      await detectKillSwitch(res);
    } catch (fetchErr) {
      if (fetchErr instanceof KillSwitchError) throw fetchErr;
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

    // Cloudflare returns HTTP 200 + application/json with {success:false,errors:[{code:3040}]}
    // for transient capacity errors. It also returns HTTP 5xx or OpenAI-style error objects
    // for transient internal failures. Retry those; surface everything else.
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
      const err = extractCloudflareError(parsed, text);
      const rawMsg = err?.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`;
      const msg = cleanErrorMessage(rawMsg);
      // For 401/403 on a non-Workers-AI model, the most likely cause is a
      // bad or missing provider key — not a Cloudflare token problem. Wrap
      // the upstream error with the actionable "/keys" guidance so the user
      // isn't sent to the generic cloud-auth message.
      const modelProvider = (() => {
        try { return getModelOrInfer(opts.model).provider; } catch { return null; }
      })();
      const isProviderAuthError =
        !customEndpoint &&
        (res.status === 401 || res.status === 403) &&
        modelProvider !== null &&
        modelProvider !== "workers-ai";
      const wrappedMsg = customEndpoint && (res.status === 401 || res.status === 403)
        ? [
            `${opts.model} rejected the request (HTTP ${res.status}): ${msg || "authentication failed"}.`,
            ``,
            `Check that KIMIFLARE_API_KEY (or \`apiKey\` in config) matches what ${customEndpoint.baseUrl} expects.`,
          ].join("\n")
        : isProviderAuthError
        ? [
            `${opts.model} rejected the request (HTTP ${res.status}): ${msg || "authentication failed"}.`,
            ``,
            `Your stored ${modelProvider} key is likely invalid or expired. Fix:`,
            `  /keys set ${modelProvider} <new-key>   replace the stored key`,
            `  /keys clear ${modelProvider}           remove it and reopen the picker to paste fresh`,
            `  /model ${opts.cloudMode ? DEFAULT_CLOUD_MODEL : DEFAULT_MODEL}  switch back to Workers AI (no key needed)`,
          ].join("\n")
        : msg;
      const apiErr = new KimiApiError(`kimiflare: ${wrappedMsg}`, err?.code, res.status);
      if (isRetryable(apiErr, attempt)) {
        const isRateLimit = apiErr.httpStatus === 429;
        const baseDelay = isRateLimit ? 2000 : 500;
        const delay = Math.random() * (baseDelay * 2 ** attempt);
        logger.warn("runKimi:retrying", { requestId, attempt, code: apiErr.code, httpStatus: apiErr.httpStatus, delay });
        await sleep(delay, opts.signal);
        continue;
      }
      throw apiErr;
    }

    if (!res.body) throw new KimiApiError("kimiflare: empty response body", undefined, res.status);

    const meta = readGatewayMeta(res.headers);
    if (meta) yield { type: "gateway_meta", meta };

    let lastUsage: Usage | null = null;
    logger.debug("runKimi:stream_start", { requestId });
    try {
      for await (const ev of parseStream(res.body, opts.signal, opts.idleTimeoutMs, opts.postFirstByteIdleTimeoutMs)) {
        if (dumpRecord) accumulateDumpResponse(dumpRecord.response, ev);
        if (ev.type === "usage") lastUsage = ev.usage;
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

    // Client-side fallback: report usage to cloud worker for reconciliation.
    // Only applies to Workers AI models (api.kimiflare.com handles those bills).
    // Never fires for custom endpoints — the host's gateway does its own metering.
    if (!customEndpoint && opts.cloudMode && lastUsage && opts.cloudToken && getModelOrInfer(opts.model).provider === "workers-ai") {
      const reportUrl = "https://api.kimiflare.com/v1/usage/report";
      const reportHeaders: Record<string, string> = {
        Authorization: `Bearer ${opts.cloudToken}`,
        "Content-Type": "application/json",
      };
      if (opts.cloudDeviceId) reportHeaders["X-Device-ID"] = opts.cloudDeviceId;
      if (opts.sessionId) reportHeaders["X-Session-ID"] = opts.sessionId;
      fetch(reportUrl, {
        method: "POST",
        headers: reportHeaders,
        body: JSON.stringify({
          request_id: requestId,
          prompt_tokens: lastUsage.prompt_tokens,
          completion_tokens: lastUsage.completion_tokens,
          cached_tokens: lastUsage.prompt_tokens_details?.cached_tokens ?? 0,
        }),
      }).catch(() => {}); // Best-effort fire-and-forget
    }

    return;
  }
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

/** Validate that a model ID looks like a legitimate Cloudflare or AI-Gateway-routable model.
 *
 *  Accepted shapes:
 *    - "@namespace/name(/version)?" — Cloudflare Workers AI catalog
 *    - "<provider>/<model-id>"      — AI Gateway Universal Endpoint (anthropic/, openai/, google-ai-studio/, groq/, deepseek/, …)
 *
 *  Prevents path traversal via malicious model strings. */
export function validateModelId(model: string): void {
  if (!model) throw new KimiApiError(`Invalid model ID: ${model}`, 400);
  // Workers AI catalog form: @ns/name or @ns/name/version
  if (/^@[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/.test(model)) return;
  // Provider-prefixed form: <provider>/<model-id>[:variant] — no leading @, exactly one path
  // segment after provider. Provider must be alnum/-/_; model id may contain ./-/_ but no
  // slashes or whitespace. The optional `:variant` suffix covers OpenRouter's free/nitro/
  // floor variants (e.g. "deepseek/deepseek-r1:free").
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(:[a-zA-Z0-9._-]+)?$/.test(model)) return;
  throw new KimiApiError(`Invalid model ID: ${model}`, 400);
}

const PROVIDER_DOC: Record<string, { name: string; where: string }> = {
  anthropic: { name: "Anthropic", where: "https://console.anthropic.com/settings/keys" },
  openai: { name: "OpenAI", where: "https://platform.openai.com/api-keys" },
  google: { name: "Google AI Studio", where: "https://aistudio.google.com/app/apikey" },
  moonshotai: { name: "Moonshot AI", where: "https://platform.moonshot.cn/" },
  "openai-compatible": { name: "your provider", where: "your provider's dashboard" },
};

function missingKeyMessage(model: string, provider: string, unifiedAvailable: boolean, cloudMode?: boolean): string {
  const doc = PROVIDER_DOC[provider] ?? { name: "your provider", where: "your provider's dashboard" };
  const lines = [
    `kimiflare: ${model} needs a ${doc.name} API key.`,
    ``,
    `To fix this, do ONE of:`,
    `  1. Get a key from ${doc.where}, then run:  /keys set ${provider} <your-key>`,
  ];
  if (unifiedAvailable) {
    lines.push(`  2. Enable Cloudflare Unified Billing for this gateway in the CF dashboard, then run:  /keys unified on`);
  }
  const fallbackModel = cloudMode ? DEFAULT_CLOUD_MODEL : DEFAULT_MODEL;
  lines.push(`  ${unifiedAvailable ? "3" : "2"}. Switch back to a Workers AI model:  /model ${fallbackModel}`);
  return lines.join("\n");
}

function gatewayHeadersFor(opts: RunKimiOpts): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!opts.gateway) return headers;
  if (opts.gateway.cacheTtl !== undefined) {
    headers["cf-aig-cache-ttl"] = String(opts.gateway.cacheTtl);
  }
  if (opts.gateway.skipCache !== undefined) {
    headers["cf-aig-skip-cache"] = String(opts.gateway.skipCache);
  }
  if (opts.gateway.collectLogPayload !== undefined) {
    headers["cf-aig-collect-log-payload"] = String(opts.gateway.collectLogPayload);
  }
  if (opts.gateway.metadata && Object.keys(opts.gateway.metadata).length > 0) {
    const entries = Object.entries(opts.gateway.metadata).slice(0, 5);
    headers["cf-aig-metadata"] = stableStringify(Object.fromEntries(entries), jsonReplacer);
  }
  return headers;
}

function buildKimiRequestTarget(
  opts: RunKimiOpts,
  customEndpoint: CustomEndpoint | null,
): { url: string; headers: Record<string, string> } {
  // Custom OpenAI-compatible endpoint: the host app owns routing and auth,
  // so every Cloudflare path below is bypassed — no account-id URLs, no
  // cf-aig-* headers, no BYOK / Unified Billing logic. The model id only
  // rides in the JSON body on this path (never the URL), so the strict
  // Cloudflare id shapes don't apply: any non-empty id passes through.
  if (customEndpoint) {
    if (!opts.model) throw new KimiApiError(`Invalid model ID: ${opts.model}`, 400);
    return {
      url: customChatCompletionsUrl(customEndpoint.baseUrl),
      headers: customEndpoint.apiKey ? { Authorization: `Bearer ${customEndpoint.apiKey}` } : {},
    };
  }

  validateModelId(opts.model);

  if (opts.cloudMode) {
    const headers: Record<string, string> = opts.cloudToken ? { Authorization: `Bearer ${opts.cloudToken}` } : {};
    if (opts.cloudDeviceId) headers["X-Device-ID"] = opts.cloudDeviceId;
    return { url: "https://api.kimiflare.com/v1/chat", headers };
  }

  const entry = getModelOrInfer(opts.model);

  // Cloudflare-catalog models (Kimi K3 today): Cloudflare's unified REST API.
  // Same OpenAI-shaped request/stream as the gateway path, but auth is only
  // the Cloudflare token — Cloudflare pays the provider from the account's AI
  // Gateway credits (Unified Billing). The gateway is optional: with
  // `cf-aig-gateway-id` set the request is logged in that gateway, otherwise
  // Cloudflare uses (and auto-creates) the "default" gateway. cf-aig-* headers
  // (cache TTL, skip-cache, metadata, collect-log) apply here too.
  if (routeFor(entry) === "cf-catalog") {
    const headers = gatewayHeadersFor(opts);
    if (opts.gateway?.id) headers["cf-aig-gateway-id"] = opts.gateway.id;
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        opts.accountId,
      )}/ai/v1/chat/completions`,
      headers,
    };
  }

  // OpenRouter models: never Cloudflare at all — direct to openrouter.ai with the
  // user's own OpenRouter key as a plain bearer. No account id, no cf-aig-* headers,
  // no gateway required, no Unified Billing (OpenRouter has no such concept — it's
  // BYOK only, per Sina's decision to keep this bring-your-own-key).
  if (routeFor(entry) === "openrouter") {
    const key = opts.providerKeys?.openrouter;
    if (!key) {
      throw new KimiApiError(
        [
          `kimiflare: ${opts.model} requires an OpenRouter API key.`,
          ``,
          `To fix: run  /keys set openrouter <your-key>  (get one at https://openrouter.ai/keys).`,
        ].join("\n"),
        undefined,
        401,
      );
    }
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        Authorization: `Bearer ${key}`,
        // OpenRouter's attribution headers — optional, but this is how a project
        // shows up in its public rankings; cheap to send.
        "HTTP-Referer": "https://kimiflare.com",
        "X-Title": "kimiflare",
      },
    };
  }

  // If no gateway is configured, Workers AI models can use the direct
  // api.cloudflare.com path for lower latency. Non-Workers-AI models still
  // require AI Gateway (there is no direct path for Anthropic, OpenAI, etc.).
  if (!opts.gateway?.id) {
    if (entry.provider === "workers-ai") {
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
          opts.accountId,
        )}/ai/run/${opts.model}`,
        headers: {
          Authorization: `Bearer ${opts.apiToken}`,
          "Content-Type": "application/json",
        },
      };
    }
    throw new KimiApiError(
      [
        `kimiflare: ${opts.model} requires Cloudflare AI Gateway, but no gateway is configured.`,
        ``,
        `To fix: run  /gateway <your-gateway-id>  (create one at https://dash.cloudflare.com/?to=/:account/ai-gateway).`,
      ].join("\n"),
      undefined,
      400,
    );
  }

  // Gateway path: AI Gateway Universal Endpoint handles all providers.
  const headers = gatewayHeadersFor(opts);

  if (entry.provider !== "workers-ai") {
    // Three BYOK paths, in priority order:
    //   1. Unified Billing  → no provider auth at all; CF pays the upstream provider
    //                         using credits attached to the account. Auth is only the
    //                         gateway-level Authorization: Bearer <CF token>.
    //   2. Stored Keys      → cf-aig-byok-alias points at a CF Secrets Store secret;
    //                         CF resolves it server-side. We never read the secret.
    //   3. Local BYOK       → cf-aig-authorization carries the raw provider key.
    // Only use Unified Billing when the model/provider explicitly supports it.
    // Some providers (e.g. Moonshot AI) are BYOK-only on AI Gateway, so a
    // global unifiedBilling=true must not silently send an unauthenticated
    // request that fails with a generic upstream 503.
    const useUnified = !!opts.unifiedBilling && isUnifiedEligible(entry);
    const alias = opts.providerKeyAliases?.[entry.provider];
    const providerKey = opts.providerKeys?.[entry.provider];
    if (useUnified) {
      // no provider-auth header
    } else if (alias) {
      headers["cf-aig-byok-alias"] = alias;
    } else if (providerKey) {
      headers["cf-aig-authorization"] = `Bearer ${providerKey}`;
    } else {
      throw new KimiApiError(
        missingKeyMessage(opts.model, entry.provider, entry.billingMode === "unified", opts.cloudMode),
        undefined,
        401,
      );
    }
  }
  // For workers-ai there is no upstream key to set: Workers AI bills against
  // the same Cloudflare account whose token signs the request, so the
  // gateway-level Authorization header is the only auth needed.

  return {
    url: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(opts.accountId)}/${encodeURIComponent(
      opts.gateway.id,
    )}/compat/chat/completions`,
    headers,
  };
}

function readGatewayMeta(headers: Headers): GatewayMeta | null {
  const meta: GatewayMeta = {};
  const cacheStatus = headers.get("cf-aig-cache-status");
  const logId = headers.get("cf-aig-log-id");
  const eventId = headers.get("cf-aig-event-id");
  const model = headers.get("cf-aig-model");

  if (cacheStatus) meta.cacheStatus = cacheStatus;
  if (logId) meta.logId = logId;
  if (eventId) meta.eventId = eventId;
  if (model) meta.model = model;

  return Object.keys(meta).length > 0 ? meta : null;
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

  for await (const dataStr of readSSE(body, signal, idleTimeoutMs, postFirstByteIdleTimeoutMs)) {
    if (dataStr === "[DONE]") break;
    let chunk: StreamChunk | null = null;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (!chunk) continue;

    if (chunk.usage) {
      lastUsage = chunk.usage;
      yield { type: "usage", usage: chunk.usage };
    }

    // Cloudflare native format: { response: "..." }
    if (typeof (chunk as Record<string, unknown>).response === "string") {
      const resp = (chunk as Record<string, unknown>).response as string;
      if (resp.length) {
        yield { type: "text", delta: resp };
      }
    }

    // OpenAI-compatible format: { choices: [{ delta: { content: "..." } }] }
    const choice = chunk.choices?.[0];
    if (choice) {
      const d = choice.delta;
      if (d) {
        if (typeof d.reasoning_content === "string" && d.reasoning_content.length) {
          yield { type: "reasoning", delta: d.reasoning_content };
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
  choices?: StreamChoice[];
  usage?: Usage;
}
interface StreamChoice {
  delta?: StreamDelta;
  finish_reason?: string | null;
  index?: number;
}
interface StreamDelta {
  role?: string | null;
  content?: string | null;
  reasoning_content?: string | null;
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

function extractCloudflareError(
  parsed: unknown,
  rawText?: string,
): { code?: number; message?: string } | null {
  if (parsed && typeof parsed === "object") {
    // Cloudflare native format: { success: false, errors: [...] }
    const cf = parsed as { success?: boolean; errors?: Array<{ code?: number; message?: string }> };
    if (cf.success === false && Array.isArray(cf.errors) && cf.errors.length > 0) {
      return { code: cf.errors[0]?.code, message: cf.errors[0]?.message };
    }

    // OpenAI-compatible format: { object: "error", message, code }
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
