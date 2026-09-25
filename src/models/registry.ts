/**
 * Model registry: single source of truth for per-model capabilities and
 * pricing.
 *
 * Every model is served through OpenRouter (https://openrouter.ai) with the
 * user's own OpenRouter key — there is exactly one provider, so there is no
 * routing decision to make here. What the user *does* choose is the model,
 * and the list of models is not maintained by hand: the live OpenRouter
 * catalog (see openrouter-catalog.ts) is registered at startup via
 * `registerOpenRouterModels()`. The small SEED list below is only the offline
 * fallback — the Kimi models kimiflare is built around, so a first run with no
 * network and no cached catalog still has accurate context windows/pricing
 * for the default model.
 *
 * Model ids are OpenRouter's own `vendor/model[:variant]` ids, e.g.
 * "moonshotai/kimi-k2.6" or "deepseek/deepseek-r1:free". Ids from the
 * Cloudflare era ("@cf/moonshotai/kimi-k2.6", …) are rewritten on config load
 * by `migrateLegacyModelId()`.
 */

export interface ModelPricing {
  /** USD per million uncached input tokens. */
  inputPerMtok: number;
  /** USD per million cached input tokens. Omit if the model does not bill cached input differently. */
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
   * Some reasoning models (e.g. Kimi K3, gpt-5 family) reject any
   * non-default value. Default: true.
   */
  temperature?: boolean;
}

export interface ModelEntry {
  /** OpenRouter model id, e.g. "moonshotai/kimi-k2.6". */
  id: string;
  /** Human-readable name from the catalog, e.g. "MoonshotAI: Kimi K2.6". */
  name?: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  supports: ModelCapabilities;
}

const SEED: ModelEntry[] = [
  // Pricing/context verified against https://openrouter.ai/api/v1/models on
  // 2026-09-25. The live catalog replaces these numbers once it loads.
  {
    id: "moonshotai/kimi-k3",
    name: "MoonshotAI: Kimi K3",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    pricing: { inputPerMtok: 0.8845, cachedInputPerMtok: 0.33, outputPerMtok: 10.5346 },
    // K3 fixes temperature=1.0 — sending any other value is a 400, so we omit it.
    supports: { tools: true, reasoning: true, streaming: true, vision: true, temperature: false },
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "MoonshotAI: Kimi K2.7 Code",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.6562, cachedInputPerMtok: 0.18, outputPerMtok: 3.3 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "MoonshotAI: Kimi K2.6",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.95, cachedInputPerMtok: 0.16, outputPerMtok: 4.0 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "MoonshotAI: Kimi K2.5",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.45, cachedInputPerMtok: 0.07, outputPerMtok: 2.25 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
  },
];

/** Ids of the models kimiflare recommends, in display order. The model picker
 *  pins these to the top; everything else in the catalog follows. */
export const RECOMMENDED_MODEL_IDS: readonly string[] = SEED.map((m) => m.id);

const seedIndex = new Map<string, ModelEntry>(SEED.map((m) => [m.id, m]));
let userOverrides: Map<string, ModelEntry> = new Map();
/** Live OpenRouter catalog, populated by `registerOpenRouterModels()` (see openrouter-catalog.ts).
 *  Empty until that's called; registry.ts itself does no network I/O. */
let openRouterIndex: Map<string, ModelEntry> = new Map();

/** Register or replace entries from a user-supplied config (e.g. ~/.kimiflare/models.json). */
export function registerUserModels(entries: ModelEntry[]): void {
  userOverrides = new Map(entries.map((m) => [m.id, m]));
}

/** Register or replace the live OpenRouter catalog (see `loadOpenRouterCatalog()`). */
export function registerOpenRouterModels(entries: ModelEntry[]): void {
  openRouterIndex = new Map(
    entries.map((m) => {
      // The catalog can't express "accepts temperature, but only the default
      // value" — keep the seed's hand-verified temperature=false (Kimi K3).
      const seed = seedIndex.get(m.id);
      if (seed?.supports.temperature === false) {
        return [m.id, { ...m, supports: { ...m.supports, temperature: false } }];
      }
      return [m.id, m];
    }),
  );
}

/** True once a live (or cached) OpenRouter catalog has been registered. */
export function hasOpenRouterCatalog(): boolean {
  return openRouterIndex.size > 0;
}

/** Look up a model by id. Returns undefined for unknown models. */
export function getModel(id: string): ModelEntry | undefined {
  return userOverrides.get(id) ?? openRouterIndex.get(id) ?? seedIndex.get(id);
}

/** Look up a model, falling back to a generic entry for ids not in the catalog. */
export function getModelOrInfer(id: string): ModelEntry {
  const hit = getModel(id);
  if (hit) return hit;
  // Conservative defaults for unknown models — context/output kept small so
  // the harness errs on the side of compaction rather than wasted prompt tokens.
  return {
    id,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    pricing: { inputPerMtok: 0, outputPerMtok: 0 },
    supports: { tools: true, reasoning: false, streaming: true },
  };
}

export function listModels(): ModelEntry[] {
  const out = new Map(seedIndex);
  for (const [k, v] of openRouterIndex) out.set(k, v);
  for (const [k, v] of userOverrides) out.set(k, v);
  return [...out.values()];
}

/** Vendor segment of an OpenRouter id: "moonshotai/kimi-k2.6" → "moonshotai". */
export function vendorOf(id: string): string {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(0, slash).replace(/^~/, "");
}

/**
 * Free on OpenRouter: the catalog lists a zero input and output price
 * (typically the `:free` variants). Ids missing from the catalog also carry
 * zero pricing (see `getModelOrInfer`), but that means "unknown", not free.
 */
export function isFreeModel(entry: ModelEntry): boolean {
  const zero = entry.pricing.inputPerMtok === 0 && entry.pricing.outputPerMtok === 0;
  return zero && (entry.id.endsWith(":free") || getModel(entry.id) !== undefined);
}

/**
 * Rewrite a model id from the Cloudflare era to its OpenRouter equivalent.
 * Configs written before the OpenRouter switch persist Workers AI ids
 * (`@cf/moonshotai/kimi-k2.6`) and AI Gateway ids (`google-ai-studio/…`).
 * Anything already OpenRouter-shaped passes through unchanged.
 */
export function migrateLegacyModelId(id: string): string;
export function migrateLegacyModelId(id: string | undefined): string | undefined;
export function migrateLegacyModelId(id: string | undefined): string | undefined {
  if (!id) return id;
  const known = LEGACY_MODEL_IDS[id];
  if (known) return known;
  if (id.startsWith("@cf/")) {
    // "@cf/<vendor>/<model>" → "<vendor>/<model>"; Workers AI's zai-org is z-ai on OpenRouter.
    const rest = id.slice("@cf/".length);
    return rest.replace(/^zai-org\//, "z-ai/");
  }
  if (id.startsWith("workers-ai/")) return migrateLegacyModelId(id.slice("workers-ai/".length));
  if (id.startsWith("google-ai-studio/")) return `google/${id.slice("google-ai-studio/".length)}`;
  return id;
}

const LEGACY_MODEL_IDS: Record<string, string> = {
  "@cf/moonshotai/kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
  "@cf/moonshotai/kimi-k2.6": "moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.5": "moonshotai/kimi-k2.5",
  "@cf/zai-org/glm-5.2": "z-ai/glm-5.2",
  "@cf/baai/bge-base-en-v1.5": "baai/bge-base-en-v1.5",
};
