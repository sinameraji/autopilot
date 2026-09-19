import type { KimiConfig } from "../config.js";
import { isUnifiedEligible, routeFor, type ModelEntry } from "./registry.js";

export type NextStep =
  | { kind: "ready" }
  | { kind: "needs-gateway" }
  | { kind: "billing-choice" }
  | { kind: "needs-key" };

/**
 * Decide what (if anything) we need to ask the user after they pick a model.
 *
 *   ready          — no further setup; can chat right now.
 *   needs-gateway  — non-Workers-AI model but no aiGatewayId configured.
 *   billing-choice — provider supports Unified Billing AND we don't have a key or unified-on yet.
 *                    User picks: pay-via-CF-credits OR paste-own-key.
 *   needs-key      — BYOK-only provider (e.g. DeepSeek, or OpenRouter) with no stored key.
 */
export function decideNextStep(cfg: KimiConfig | null, model: ModelEntry): NextStep {
  if (model.provider === "workers-ai") return { kind: "ready" };
  // Cloudflare-catalog models (e.g. moonshotai/kimi-k3) are paid from the
  // account's AI Gateway credits via Cloudflare's unified REST API: no
  // provider key, and a gateway is optional (Cloudflare uses/creates
  // "default" when none is set).
  if (routeFor(model) === "cf-catalog") return { kind: "ready" };
  // OpenRouter never goes through Cloudflare at all — no AI Gateway involved,
  // so it must not fall into the needs-gateway branch below. It's plain BYOK:
  // ready once a key is stored, needs-key otherwise. No Unified Billing or
  // Secrets Store alias concept applies (those are Cloudflare-only).
  if (routeFor(model) === "openrouter") {
    return cfg?.providerKeys?.openrouter ? { kind: "ready" } : { kind: "needs-key" };
  }
  if (!cfg) return { kind: "ready" };
  if (!cfg.aiGatewayId) return { kind: "needs-gateway" };

  const providerKey = model.provider as "anthropic" | "openai" | "google" | "moonshotai" | "openai-compatible";
  const hasKey = !!cfg.providerKeys?.[providerKey];
  const hasAlias = !!cfg.providerKeyAliases?.[providerKey];
  const usingUnified = !!cfg.unifiedBilling;

  if (hasKey || hasAlias || usingUnified) return { kind: "ready" };
  if (isUnifiedEligible(model)) return { kind: "billing-choice" };
  return { kind: "needs-key" };
}
