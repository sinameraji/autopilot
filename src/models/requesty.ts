/**
 * Requesty endpoint + request-header helpers, the Requesty sibling of
 * openrouter.ts (chat completions, embeddings, the model catalog and key
 * validation).
 *
 * Requesty (https://requesty.ai) is an OpenAI-compatible LLM gateway. It is
 * used only when a Requesty key is configured and no OpenRouter key or custom
 * endpoint is, so it never changes what an existing setup talks to.
 *
 * `REQUESTY_BASE_URL` overrides the API root, e.g. the EU region
 * (https://router.eu.requesty.ai/v1). The same key works on every region.
 */

import { getUserAgent } from "../util/version.js";
import { fetchWithNetworkRetry } from "./openrouter.js";

export const REQUESTY_DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
export const REQUESTY_KEYS_URL = "https://app.requesty.ai/api-keys";

export function requestyBaseUrl(): string {
  const raw = process.env.REQUESTY_BASE_URL?.trim();
  return (raw || REQUESTY_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function requestyUrl(path: string): string {
  return `${requestyBaseUrl()}/${path.replace(/^\/+/, "")}`;
}

/** Headers for an authenticated Requesty request, with the same app attribution sent to OpenRouter. */
export function requestyHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://kimiflare.com",
    "X-Title": "kimiflare",
    "User-Agent": getUserAgent(),
  };
}

export type RequestyKeyCheck =
  | { ok: true }
  | { ok: false; reason: "invalid" | "network" | "http"; message: string };

/**
 * Validate a Requesty key with an authenticated `GET /models` (200 for a
 * valid key, 401/403 for a bad one). Free: no tokens are spent.
 */
export async function checkRequestyKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RequestyKeyCheck> {
  let res: Response;
  try {
    res = await fetchWithNetworkRetry(fetchImpl, requestyUrl("models"), { headers: requestyHeaders(apiKey) });
  } catch (e) {
    return { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid", message: "Requesty rejected this key." };
  }
  if (!res.ok) {
    return { ok: false, reason: "http", message: `Requesty returned HTTP ${res.status}.` };
  }
  return { ok: true };
}
