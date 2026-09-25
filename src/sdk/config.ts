import { loadConfig, saveConfig, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type KimiConfig } from "../config.js";
import { resolveCustomEndpoint } from "../agent/custom-endpoint.js";
import type { CreateSessionOptions } from "./types.js";

export { loadConfig, saveConfig, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT };
export type { KimiConfig };

export async function resolveSdkConfig(opts: CreateSessionOptions): Promise<KimiConfig> {
  const loaded = await loadConfig();
  const merged: KimiConfig = {
    model: DEFAULT_MODEL,
    ...loaded,
    ...opts.config,
  };

  // An OpenRouter key is required unless a custom OpenAI-compatible endpoint
  // is configured (KIMIFLARE_BASE_URL / config baseUrl) — with one, the
  // host's gateway owns routing and auth.
  if (!merged.openrouterApiKey && !resolveCustomEndpoint(merged)) {
    throw new Error(
      "kimiflare SDK: missing credentials. Set OPENROUTER_API_KEY (or config.openrouterApiKey), " +
        "or set KIMIFLARE_BASE_URL (+ KIMIFLARE_API_KEY) for a custom OpenAI-compatible endpoint.",
    );
  }

  return merged;
}
