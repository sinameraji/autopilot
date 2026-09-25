/**
 * Per-token pricing for the local cost *estimate*, looked up from the model
 * registry (OpenRouter's live catalog). Unknown models return zero cost —
 * usage is still tracked, but the dollar figure is suppressed rather than
 * silently wrong. The authoritative number is what OpenRouter reports it
 * billed; see usage-tracker.ts for how each turn is confirmed.
 */

import { getModel, type ModelPricing } from "./models/registry.js";

/** Legacy K2.6 constants — kept as exports for back-compat with anything
 *  importing them directly. New code should look up via the registry. */
export const PRICE_IN_PER_M = 0.95;
export const PRICE_IN_CACHED_PER_M = 0.16;
export const PRICE_OUT_PER_M = 4.0;

export interface CostBreakdown {
  uncachedIn: number;
  cachedIn: number;
  out: number;
  total: number;
}

const ZERO_PRICING: ModelPricing = { inputPerMtok: 0, outputPerMtok: 0 };

export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  model?: string,
): CostBreakdown {
  const pricing = model ? (getModel(model)?.pricing ?? ZERO_PRICING) : {
    inputPerMtok: PRICE_IN_PER_M,
    cachedInputPerMtok: PRICE_IN_CACHED_PER_M,
    outputPerMtok: PRICE_OUT_PER_M,
  };
  const uncachedIn = Math.max(0, promptTokens - cachedTokens);
  const cachedIn = cachedTokens;
  const out = completionTokens;
  const cachedRate = pricing.cachedInputPerMtok ?? pricing.inputPerMtok;
  const total =
    (uncachedIn * pricing.inputPerMtok) / 1_000_000 +
    (cachedIn * cachedRate) / 1_000_000 +
    (out * pricing.outputPerMtok) / 1_000_000;
  return { uncachedIn, cachedIn, out, total };
}
