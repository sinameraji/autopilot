/**
 * Model registry: single source of truth for per-model capabilities, pricing,
 * and routing decisions.
 *
 * KimiFlare is built around Kimi models served through Cloudflare. Most seeded
 * models are Workers AI models; AI Gateway is optional for those — they also
 * work via the direct api.cloudflare.com path. Kimi K3 (moonshotai/kimi-k3) is
 * a third-party model in Cloudflare's model catalog, paid from the account's
 * AI Gateway credits, and works out of the box with just a Cloudflare token.
 *
 * Routing taxonomy (see `routeFor()`):
 *   - "workers-ai": Workers AI chat models go through EITHER:
 *     a) Direct path:  api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{model}
 *     b) Gateway path: gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/chat/completions
 *     The choice is made at runtime based on whether aiGatewayId is configured.
 *   - "cf-catalog": third-party models in Cloudflare's model catalog (e.g.
 *     moonshotai/kimi-k3) go through Cloudflare's unified REST API
 *     api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/chat/completions with an
 *     optional `cf-aig-gateway-id` header. Cloudflare pays the provider from the
 *     account's AI Gateway credits (Unified Billing) — no provider key, and BYOK
 *     is not supported on this path.
 *   - "gateway": everything else (Anthropic, OpenAI, Google, OpenAI-compatible)
 *     goes through the AI Gateway Universal Endpoint with provider auth
 *     (Unified Billing where supported, else BYOK).
 *   - Embeddings use the Workers AI dual-path logic:
 *     a) Direct:  api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{model}
 *     b) Gateway: gateway.ai.cloudflare.com/v1/{acct}/{gw}/workers-ai/{model}
 *   - User-registered models (via ~/.kimiflare/models.json) can be any provider,
 *     but "gateway"-routed ones require AI Gateway since only Workers AI has a
 *     direct path.
 */

export type ModelProvider =
  | "workers-ai"
  | "anthropic"
  | "openai"
  | "google"
  | "moonshotai"
  | "openai-compatible"
  | "openrouter";

export type BillingMode = "unified" | "byok";

export interface ModelPricing {
  /** USD per million uncached input tokens. */
  inputPerMtok: number;
  /** USD per million cached input tokens. Omit if provider does not bill cached input differently. */
  cachedInputPerMtok?: number;
  /** USD per million output tokens. */
  outputPerMtok: number;
}

export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  streaming: boolean;
  /** Does this model support image/vision inputs? */
  vision?: boolean;
  /**
   * Does this model accept the `temperature` field in the request body?
   * Reasoning models from OpenAI (gpt-5 family) and Anthropic (opus-4-7)
   * reject or deprecate it. Default: true.
   */
  temperature?: boolean;
}

export interface ModelEntry {
  /** Canonical model id, e.g. "@cf/moonshotai/kimi-k2.7-code". */
  id: string;
  provider: ModelProvider;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  supports: ModelCapabilities;
  /**
   * "unified" — Cloudflare's Unified Billing can pay this provider on the user's behalf.
   * "byok"    — user must supply their own provider API key.
   * Note: "unified" availability is provider/gateway-specific; "byok" always works.
   */
  billingMode: BillingMode;
}

/**
 * Providers Cloudflare AI Gateway supports paying for via Unified Billing
 * (CF credits, no upstream key). Workers AI is its own track and trivially
 * "ready" for any account that can reach AI Gateway at all.
 * Source: developers.cloudflare.com/ai-gateway/features/unified-billing/
 */
const UNIFIED_BILLING_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google-ai-studio",
  "groq",
  "xai",
]);

export type ModelRoute = "workers-ai" | "cf-catalog" | "gateway" | "openrouter";

/**
 * Which transport a model uses. Moonshot models are only reachable through
 * Cloudflare's model catalog (unified REST API + Unified Billing) — there is
 * no provider-native Moonshot slug on AI Gateway. OpenRouter models go direct
 * to openrouter.ai — never through Cloudflare at all.
 */
export function routeFor(entry: ModelEntry): ModelRoute {
  if (entry.provider === "workers-ai") return "workers-ai";
  if (entry.provider === "moonshotai") return "cf-catalog";
  if (entry.provider === "openrouter") return "openrouter";
  return "gateway";
}

/** True when the user can pay for this model through Cloudflare credits rather than BYOK. */
export function isUnifiedEligible(entry: ModelEntry): boolean {
  if (entry.provider === "workers-ai") return false; // own billing track
  if (entry.provider === "openrouter") return false; // OpenRouter has no Cloudflare unified-billing concept
  if (routeFor(entry) === "cf-catalog") return true; // credits are the only option
  // For openai-compatible upstreams we key off the model-id prefix
  // (e.g. "groq/llama-3.3-70b-versatile" → "groq").
  const slashIdx = entry.id.indexOf("/");
  if (slashIdx < 0) return false;
  const upstream = entry.id.slice(0, slashIdx).toLowerCase();
  return UNIFIED_BILLING_PROVIDERS.has(upstream);
}

const SEED: ModelEntry[] = [
  // ── Kimi models (Cloudflare Workers AI, native to kimiflare) ──────────────
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    provider: "workers-ai",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.95, cachedInputPerMtok: 0.19, outputPerMtok: 4.0 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
    billingMode: "unified",
  },
  // ── Kimi K3 (Cloudflare model catalog, third-party, Unified Billing) ─────
  // Verified live 2026-08-19 against
  //   POST api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/chat/completions
  // with `cf-aig-gateway-id`: streaming, reasoning_content deltas, tool calls
  // and usage all parse; Cloudflare pays Moonshot from AI Gateway credits.
  // Pricing per Moonshot (platform.kimi.ai/docs/pricing/chat-k3): $3.00 in,
  // $0.30 cached in, $15.00 out per 1M tokens; Cloudflare passes it through.
  {
    id: "moonshotai/kimi-k3",
    provider: "moonshotai",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    pricing: { inputPerMtok: 3.0, cachedInputPerMtok: 0.3, outputPerMtok: 15.0 },
    // K3 fixes temperature=1.0 — sending any other value is a 400
    // ("invalid temperature: only 1 is allowed for this model"), so we omit it.
    // Reasoning is always on; `reasoning_effort` low/medium/high are accepted.
    supports: { tools: true, reasoning: true, streaming: true, vision: true, temperature: false },
    billingMode: "unified",
  },
  {
    id: "@cf/moonshotai/kimi-k2.6",
    provider: "workers-ai",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.95, cachedInputPerMtok: 0.16, outputPerMtok: 4.0 },
    supports: { tools: true, reasoning: true, streaming: true },
    billingMode: "unified",
  },
  {
    id: "@cf/moonshotai/kimi-k2.5",
    provider: "workers-ai",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.55, cachedInputPerMtok: 0.11, outputPerMtok: 2.19 },
    supports: { tools: true, reasoning: true, streaming: true },
    billingMode: "unified",
  },
  // ── GLM (Zhipu AI on Cloudflare Workers AI) ───────────────────────────────
  {
    id: "@cf/zai-org/glm-5.2",
    provider: "workers-ai",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 1.4, cachedInputPerMtok: 0.26, outputPerMtok: 4.4 },
    supports: { tools: true, reasoning: true, streaming: true },
    billingMode: "unified",
  },
];

const seedIndex = new Map<string, ModelEntry>(SEED.map((m) => [m.id, m]));
let userOverrides: Map<string, ModelEntry> = new Map();
/** Live OpenRouter catalog, populated by `registerOpenRouterModels()` (see openrouter-catalog.ts).
 *  Empty until that's called — callers that need it must load it explicitly (e.g. at startup or
 *  when the model picker opens); registry.ts itself does no network I/O. */
let openRouterIndex: Map<string, ModelEntry> = new Map();

/** Register or replace entries from a user-supplied config (e.g. ~/.kimiflare/models.json). */
export function registerUserModels(entries: ModelEntry[]): void {
  userOverrides = new Map(entries.map((m) => [m.id, m]));
}

/** Register or replace the live OpenRouter catalog (see `loadOpenRouterCatalog()`). */
export function registerOpenRouterModels(entries: ModelEntry[]): void {
  openRouterIndex = new Map(entries.map((m) => [m.id, m]));
}

/** Look up a model by id. Returns undefined for unknown models. */
export function getModel(id: string): ModelEntry | undefined {
  return userOverrides.get(id) ?? openRouterIndex.get(id) ?? seedIndex.get(id);
}

/** Look up a model, falling back to a generic entry inferred from the id prefix. */
export function getModelOrInfer(id: string): ModelEntry {
  const hit = getModel(id);
  if (hit) return hit;
  const provider = inferProvider(id);
  // Conservative defaults for unknown models — context/output kept small so
  // the harness errs on the side of compaction rather than wasted prompt tokens.
  return {
    id,
    provider,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    pricing: { inputPerMtok: 0, outputPerMtok: 0 },
    supports: { tools: true, reasoning: false, streaming: true },
    billingMode: provider === "workers-ai" || provider === "moonshotai" ? "unified" : "byok",
  };
}

export function inferProvider(id: string): ModelProvider {
  if (id.startsWith("@cf/")) return "workers-ai";
  if (id.startsWith("anthropic/")) return "anthropic";
  if (id.startsWith("openai/")) return "openai";
  if (id.startsWith("google-ai-studio/") || id.startsWith("google/")) return "google";
  if (id.startsWith("moonshotai/")) return "moonshotai";
  return "openai-compatible";
}

export function listModels(): ModelEntry[] {
  const out = new Map(seedIndex);
  for (const [k, v] of openRouterIndex) out.set(k, v);
  for (const [k, v] of userOverrides) out.set(k, v);
  return [...out.values()];
}
