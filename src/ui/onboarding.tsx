/**
 * First-run setup: paste an OpenRouter key, pick a model, done.
 *
 * Skipped entirely when a key is already configured (OPENROUTER_API_KEY /
 * KIMIFLARE_OPENROUTER_KEY in the env, or `openrouterApiKey` in the config
 * file) — `loadConfig()` then returns a config and the app never mounts this
 * screen, which is what makes headless installs possible.
 *
 * The key is validated against OpenRouter's GET /key before anything is
 * saved, so a typo surfaces here instead of on the first prompt. Saving
 * merges into the existing config file, so an upgrading user's settings
 * (theme, MCP servers, …) survive.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CustomTextInput } from "./text-input.js";
import { formatModelPrice, ModelPicker } from "./model-picker.js";
import { useTheme } from "./theme-context.js";
import { openBrowser } from "./app-helpers.js";
import {
  DEFAULT_MODEL,
  hasLegacyCloudflareConfig,
  loadConfig,
  patchPersistedConfig,
  type KimiConfig,
} from "../config.js";
import {
  checkOpenRouterKey,
  looksLikeOpenRouterKey,
  OPENROUTER_KEYS_URL,
  type OpenRouterKeyInfo,
} from "../models/openrouter.js";
import { getModelOrInfer, RECOMMENDED_MODEL_IDS, type ModelEntry } from "../models/registry.js";

interface Props {
  onDone: (cfg: KimiConfig) => void;
  onCancel?: () => void;
}

type Step = "key" | "checking" | "model" | "browse" | "saving";

export function Onboarding({ onDone, onCancel }: Props) {
  const theme = useTheme();
  const [step, setStep] = useState<Step>("key");
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyInfo, setKeyInfo] = useState<OpenRouterKeyInfo | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [modelIdx, setModelIdx] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void hasLegacyCloudflareConfig().then(setUpgrading);
  }, []);

  const recommended = useMemo(
    () => RECOMMENDED_MODEL_IDS.map((id) => getModelOrInfer(id)),
    [],
  );
  // Default selection: kimiflare's default model; the last row opens the full catalog.
  useEffect(() => {
    const i = recommended.findIndex((m) => m.id === DEFAULT_MODEL);
    if (i >= 0) setModelIdx(i);
  }, [recommended]);

  const submitKey = async (raw: string) => {
    const candidate = raw.trim();
    if (!candidate) return;
    // The field is masked, so a rejected value can't be meaningfully edited —
    // clear it for a fresh paste.
    if (!looksLikeOpenRouterKey(candidate)) {
      setKey("");
      setKeyError("That doesn't look like an OpenRouter key — they start with sk-or-.");
      return;
    }
    setKeyError(null);
    setStep("checking");
    const res = await checkOpenRouterKey(candidate);
    if (res.ok) {
      setKey(candidate);
      setKeyInfo(res.info);
      setStep("model");
      return;
    }
    setKey("");
    setKeyError(
      res.reason === "invalid"
        ? "OpenRouter rejected this key. Check it was copied in full, or create a new one."
        : `Couldn't reach OpenRouter to check the key (${res.message}). Check your connection and try again.`,
    );
    setStep("key");
  };

  const finish = async (model: ModelEntry) => {
    setStep("saving");
    try {
      await patchPersistedConfig({ openrouterApiKey: key, model: model.id });
      const cfg = await loadConfig();
      if (!cfg) throw new Error("config did not load after saving");
      onDone(cfg);
    } catch (e) {
      setSaveError((e as Error).message);
      setStep("model");
    }
  };

  useInput((input, k) => {
    if (step === "key") {
      if (k.escape) onCancel?.();
      if (k.ctrl && input === "o") openBrowser(OPENROUTER_KEYS_URL);
      return;
    }
    if (step !== "model") return;
    const rows = recommended.length + 1; // + "Browse all models…"
    if (k.upArrow) setModelIdx((i) => (i - 1 + rows) % rows);
    else if (k.downArrow) setModelIdx((i) => (i + 1) % rows);
    else if (k.escape) {
      setStep("key");
      setKeyInfo(null);
    } else if (k.return) {
      if (modelIdx === recommended.length) setStep("browse");
      else void finish(recommended[modelIdx]!);
    }
  });

  if (step === "browse") {
    return (
      <ModelPicker
        current={DEFAULT_MODEL}
        onPick={(m) => {
          if (m) void finish(m);
          else setStep("model");
        }}
      />
    );
  }

  const stepNo = step === "key" || step === "checking" ? 1 : 2;

  return (
    // No header here: the startup banner (ui/logo.ts) names the app just above.
    <Box flexDirection="column" paddingY={1}>
      {upgrading && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.accent}>autopilot (formerly kimiflare) now runs on OpenRouter.</Text>
          <Text color={theme.info.color} dimColor>
            Cloudflare Workers AI and AI Gateway are no longer used. Paste an OpenRouter key once and your
            other settings carry over — Kimi models, memory and sessions all keep working.
          </Text>
        </Box>
      )}

      <Text color={theme.info.color}>Step {stepNo} of 2</Text>

      {(step === "key" || step === "checking") && (
        <Box marginTop={1} flexDirection="column">
          <Text>Paste your OpenRouter API key</Text>
          <Text color={theme.info.color} dimColor>
            Create one at {OPENROUTER_KEYS_URL} (Ctrl+O opens it). Model calls are billed to your own
            OpenRouter account — autopilot (formerly kimiflare) never sees or stores it anywhere but your config file.
          </Text>
          <Box marginTop={1}>
            <Text color={theme.palette.primary}>› </Text>
            {step === "checking" ? (
              <Text color={theme.info.color}>checking key with OpenRouter…</Text>
            ) : (
              <CustomTextInput value={key} onChange={setKey} onSubmit={(v) => void submitKey(v)} mask="•" />
            )}
          </Box>
          {keyError && (
            <Box marginTop={1}>
              <Text color={theme.error}>{keyError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.info.color} dimColor>
              Enter to continue · Esc to quit · tip: set OPENROUTER_API_KEY to skip this screen
            </Text>
          </Box>
        </Box>
      )}

      {(step === "model" || step === "saving") && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.info.color}>
            ✓ key accepted{keyInfo?.label ? ` (${keyInfo.label})` : ""}
            {describeCredit(keyInfo)}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Pick a model — you can switch any time with /model</Text>
            <Text color={theme.info.color} dimColor>
              ↑/↓ to move, Enter to pick. Prices are USD per million tokens (input / output).
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {recommended.map((m, i) => (
              <Text key={m.id} color={i === modelIdx ? theme.palette.primary : undefined}>
                {i === modelIdx ? "› " : "  "}
                {(m.name ?? m.id).replace(/^[^:]+:\s*/, "").padEnd(22)}
                <Text color={theme.info.color} dimColor>
                  {`${formatModelPrice(m.pricing)}  ·  ${formatContext(m.contextWindow)} ctx${
                    m.id === DEFAULT_MODEL ? "  ·  default" : ""
                  }`}
                </Text>
              </Text>
            ))}
            <Text color={modelIdx === recommended.length ? theme.palette.primary : undefined}>
              {modelIdx === recommended.length ? "› " : "  "}
              Browse all OpenRouter models…
            </Text>
          </Box>
          {keyInfo?.isFreeTier && (
            <Box marginTop={1}>
              <Text color={theme.warn}>
                This key has no credits yet: only free models (ids ending in :free) will work, with a daily
                request cap. Add credits at https://openrouter.ai/settings/credits to use the models above.
              </Text>
            </Box>
          )}
          {step === "saving" && (
            <Box marginTop={1}>
              <Text color={theme.info.color}>saving…</Text>
            </Box>
          )}
          {saveError && (
            <Box marginTop={1}>
              <Text color={theme.error}>Couldn't save config: {saveError}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function describeCredit(info: OpenRouterKeyInfo | null): string {
  if (!info) return "";
  if (typeof info.limitRemaining === "number") return ` · $${info.limitRemaining.toFixed(2)} credit left on this key`;
  return "";
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(n / 1_000)}k`;
}
