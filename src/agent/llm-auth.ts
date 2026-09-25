/**
 * The one place that turns config into model-call credentials.
 *
 * Every `runKimi` / `fetchEmbeddings` call site spreads `llmAuthFromConfig(cfg)`
 * into its options instead of picking individual credential fields, so the
 * main loop, side-calls (summaries, memory, decomposition, …), embeddings,
 * print/emit/serve/SDK entry points all authenticate the same way — and a
 * custom endpoint configured in the file (not just the env) applies to all
 * of them.
 */

import type { KimiConfig } from "../config.js";
import type { OpenRouterProviderPrefs } from "./client.js";
import { resolveCustomEndpoint, type CustomEndpoint } from "./custom-endpoint.js";

export interface LlmAuth {
  /** The user's OpenRouter key. */
  openrouterApiKey?: string;
  /** Host-app broker endpoint; when set, used instead of OpenRouter. */
  customEndpoint?: CustomEndpoint;
  /** Extra OpenRouter provider-routing preferences. */
  provider?: OpenRouterProviderPrefs;
}

type AuthConfigFields = Pick<KimiConfig, "openrouterApiKey" | "baseUrl" | "apiKey" | "openrouterProvider">;

export function llmAuthFromConfig(cfg: Partial<AuthConfigFields> | null | undefined): LlmAuth {
  const customEndpoint = resolveCustomEndpoint(cfg ?? null);
  return {
    ...(cfg?.openrouterApiKey ? { openrouterApiKey: cfg.openrouterApiKey } : {}),
    ...(customEndpoint ? { customEndpoint } : {}),
    ...(cfg?.openrouterProvider ? { provider: cfg.openrouterProvider } : {}),
  };
}

/** True when model calls can be made at all (a key, or a custom endpoint). */
export function hasLlmAuth(auth: LlmAuth): boolean {
  return !!auth.openrouterApiKey || !!auth.customEndpoint;
}
