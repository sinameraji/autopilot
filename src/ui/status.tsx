import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { Usage } from "../agent/messages.js";
import type { ResponseMeta } from "../agent/client.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";
import type { Mode } from "../mode.js";
import { calculateCost } from "../pricing.js";
import type { DailyUsage } from "../usage-tracker.js";
import { humanizePhase, type IntentTier } from "./narrator.js";

export type TurnPhase = "generating" | "executing" | "waiting";

interface Props {
  usage: Usage | null;
  sessionUsage?: DailyUsage | null;
  thinking: boolean;
  turnStartedAt: number | null;
  mode: Mode;
  /** Plan/edit/auto modes feature flag; when off the mode badge and tip are hidden. */
  modesEnabled?: boolean;
  contextLimit: number;
  /** Active model id (shown in status bar). */
  model?: string;
  responseMeta?: ResponseMeta | null;
  codeMode?: boolean;
  /** Number of skills active this turn */
  skillsActive?: number;
  /** Whether memory was recalled this turn */
  memoryRecalled?: boolean;
  phase?: TurnPhase;
  currentTool?: string | null;
  lastActivityAt?: number | null;
  kimiMdStale?: boolean;
  gitBranch?: string | null;
  intentTier?: IntentTier;
}

export function StatusBar({ usage, sessionUsage, thinking, turnStartedAt, mode, modesEnabled = true, contextLimit, model, responseMeta, codeMode, skillsActive, memoryRecalled, phase, currentTool, lastActivityAt, kimiMdStale, gitBranch, intentTier }: Props) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now());
  const modeColor =
    mode === "plan" ? theme.modeBadge.plan : mode === "auto" ? theme.modeBadge.auto : theme.modeBadge.edit;
  const warn = usage && usage.prompt_tokens / contextLimit >= 0.8;

  useEffect(() => {
    if (!thinking || turnStartedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [thinking, turnStartedAt]);

  const elapsed = turnStartedAt !== null ? formatElapsed(Math.max(0, now - turnStartedAt)) : null;

  const idleParts: string[] = [];
  if (gitBranch) idleParts.push(gitBranch);
  if (model) idleParts.push(shortenModelId(model));
  if (codeMode) idleParts.push("CODE");

  const metaParts: string[] = [];
  if (skillsActive !== undefined && skillsActive > 0) {
    metaParts.push(`${skillsActive} skill${skillsActive === 1 ? "" : "s"}`);
  }
  if (memoryRecalled) {
    metaParts.push("memory");
  }

  const elapsedMs = turnStartedAt !== null ? Math.max(0, now - turnStartedAt) : 0;
  const rotateIndex = Math.min(Math.floor(elapsedMs / 2000), 2);

  const phaseLabel = phase === "generating"
    ? humanizePhase("generating", intentTier)
    : phase === "executing"
      ? `${humanizePhase("executing", intentTier)} ${currentTool ?? ""}`
      : phase === "waiting"
        ? humanizePhase("waiting", intentTier)
        : humanizePhase("generating", intentTier);

  // If we're still busy but the phase has flipped to "waiting" (e.g. between
  // assistant final output and turn cleanup, or while waiting for the next
  // model response after tools), don't show "ready" — it makes the spinner
  // appear next to a "ready" label which looks broken.
  const activePhaseLabel = thinking && phase === "waiting"
    ? humanizePhase("generating", intentTier)
    : phaseLabel;

  // Rotate the generating label every 2s so long waits don't feel frozen.
  const rotatingLabel = (() => {
    if (!thinking || phase === "executing") return activePhaseLabel;
    const tier = intentTier ?? "medium";
    const labels = tier === "heavy"
      ? ["reasoning", "synthesizing", "composing"]
      : tier === "light"
        ? ["thinking", "reasoning", "composing"]
        : ["thinking", "reasoning", "synthesizing"];
    return labels[rotateIndex] ?? labels[labels.length - 1]!;
  })();
  const idleMs = lastActivityAt && thinking ? now - lastActivityAt : 0;
  const idleLabel = idleMs > 30_000 ? ` (idle ${formatElapsed(Math.floor(idleMs / 1000))})` : "";

  const thinkingText = metaParts.length > 0
    ? `${rotatingLabel}${elapsed ? ` · ${elapsed}` : ""}${idleLabel} · ${metaParts.join(" · ")}`
    : `${rotatingLabel}${elapsed ? ` · ${elapsed}` : ""}${idleLabel}`;

  const readyText = idleParts.length > 0
    ? `${idleParts.join(" · ")} · ready`
    : "ready";

  return (
    <Box flexDirection="column">
      <Box>
        {modesEnabled ? (
          <>
            <Text color={modeColor} bold>
              [{mode}]
            </Text>
            <Text> </Text>
          </>
        ) : null}
        {thinking ? (
          <Text color={theme.spinner}>
            <Spinner type="dots2" />{" "}
            {thinkingText}
          </Text>
        ) : (
          <Text color={theme.info.color} >
            {readyText}
          </Text>
        )}
      </Box>
      {usage && (
        <Box>
          <Text color={theme.info.color} >
            {buildRightParts(usage, contextLimit, sessionUsage, responseMeta, model).join("  ·  ")}
          </Text>
          {sessionUsage?.reconcilePending ? (
            <Text color={theme.muted?.color ?? theme.info.color} dimColor={theme.muted?.dim ?? true}>
              {" "}
              <Spinner type="dots" />
            </Text>
          ) : null}
          {warn ? (
            <Text color={theme.warn} bold>
              {"  ·  "}/compact recommended
            </Text>
          ) : null}
          {kimiMdStale ? (
            <Text color={theme.warn} bold>
              {"  ·  "}⚠ KIMI.md stale · run /init
            </Text>
          ) : null}
        </Box>
      )}
      {!thinking && modesEnabled && (
        <Box>
          <Text color={theme.muted?.color ?? theme.info.color} dimColor={theme.muted?.dim}>
            tip: shift+tab cycles mode
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function buildRightParts(
  usage: Usage,
  contextLimit: number,
  sessionUsage?: DailyUsage | null,
  responseMeta?: ResponseMeta | null,
  model?: string,
): string[] {
  const pct = Math.round((usage.prompt_tokens / contextLimit) * 100);
  const parts: string[] = [];
  if (sessionUsage) {
    const cached = sessionUsage.cachedTokens;
    parts.push(`in ${sessionUsage.promptTokens}${cached ? ` (${cached} cached)` : ""}`);
    parts.push(`ctx ${pct}%`);
    // ≈ prefix signals the cost is still the local estimate; once OpenRouter
    // confirms the turn's billed cost, the prefix and spinner go away.
    const prefix = sessionUsage.reconcilePending ? "≈$" : "$";
    parts.push(`${prefix}${sessionUsage.cost.toFixed(2)}`);
    if (typeof sessionUsage.lastTurnMs === "number") {
      parts.push(formatDuration(sessionUsage.lastTurnMs));
    }
  } else {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    // OpenRouter reports the billed cost inline; fall back to the price table.
    const cost =
      typeof usage.cost === "number"
        ? usage.cost
        : calculateCost(usage.prompt_tokens, usage.completion_tokens, cached, model).total;
    parts.push(`in ${usage.prompt_tokens}${cached ? ` (${cached} cached)` : ""}`);
    parts.push(`ctx ${pct}%`);
    parts.push(`$${cost.toFixed(2)}`);
  }
  const provider = formatProviderTag(responseMeta);
  if (provider) parts.push(provider);
  return parts;
}

/** "via <upstream>" — OpenRouter picks the upstream provider per request
 *  (price, uptime, tool-calling quality), so which one served the last turn
 *  is worth seeing when latency or behaviour changes. */
export function formatProviderTag(meta?: ResponseMeta | null): string | null {
  const provider = meta?.provider?.trim();
  return provider ? `via ${provider}` : null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Shorten a model id for the status bar: drop the vendor prefix and keep
 *  the recognizable tail. "moonshotai/kimi-k2.7-code" → "kimi-k2.7-code",
 *  "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6". */
export function shortenModelId(id: string): string {
  if (id.startsWith("@")) {
    const parts = id.split("/");
    return parts[parts.length - 1] ?? id;
  }
  const slash = id.indexOf("/");
  if (slash === -1) return id;
  return id.slice(slash + 1);
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
