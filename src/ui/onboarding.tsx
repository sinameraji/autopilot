/**
 * First-run setup: sign in with OpenRouter (or paste a key), pick a model, done.
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

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CustomTextInput } from "./text-input.js";
import { ModelPicker } from "./model-picker.js";
import { OpenRouterSignIn } from "./openrouter-signin.js";
import { useTheme } from "./theme-context.js";
import { openBrowser } from "./app-helpers.js";
import {
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
import type { ModelEntry } from "../models/registry.js";

interface Props {
  onDone: (cfg: KimiConfig) => void;
  onCancel?: () => void;
}

type Step = "method" | "signin" | "key" | "checking" | "model" | "saving";

const METHODS = [
  { label: "Sign in with OpenRouter", hint: "recommended — approve in your browser, no key to copy" },
  { label: "Paste an API key", hint: "create one at https://openrouter.ai/keys" },
] as const;

export function Onboarding({ onDone, onCancel }: Props) {
  const theme = useTheme();
  const [step, setStep] = useState<Step>("method");
  const [methodIdx, setMethodIdx] = useState(0);
  /** Where "back" from the key check goes: the paste field or the sign-in panel. */
  const [keySource, setKeySource] = useState<"key" | "signin">("key");
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyInfo, setKeyInfo] = useState<OpenRouterKeyInfo | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void hasLegacyCloudflareConfig().then(setUpgrading);
  }, []);

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
    await acceptKey(candidate, "key");
  };

  /** Validate a key (pasted or minted by sign-in) and move on to the model step. */
  const acceptKey = async (candidate: string, source: "key" | "signin") => {
    setKeySource(source);
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
    setStep(source === "signin" ? "method" : "key");
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

  useInput(
    (input, k) => {
      if (k.escape) setStep("method");
      if (k.ctrl && input === "o") openBrowser(OPENROUTER_KEYS_URL);
    },
    { isActive: step === "key" },
  );

  useInput(
    (_input, k) => {
      if (k.escape) onCancel?.();
      else if (k.upArrow || k.downArrow) setMethodIdx((i) => (i + 1) % METHODS.length);
      else if (k.return) {
        setKeyError(null);
        setStep(methodIdx === 0 ? "signin" : "key");
      }
    },
    { isActive: step === "method" },
  );

  const stepNo = step === "model" || step === "saving" ? 2 : 1;

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

      {step === "method" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Connect your OpenRouter account</Text>
          <Text color={theme.info.color} dimColor>
            Model calls are billed to your own OpenRouter account. ↑/↓ to choose, Enter to continue.
          </Text>
          <Box marginTop={1} flexDirection="column">
            {METHODS.map((m, i) => (
              <Text key={m.label} color={i === methodIdx ? theme.palette.primary : undefined}>
                {i === methodIdx ? "› " : "  "}
                {m.label}
                <Text color={theme.info.color} dimColor>{`  ${m.hint}`}</Text>
              </Text>
            ))}
          </Box>
          {keyError && (
            <Box marginTop={1}>
              <Text color={theme.error}>{keyError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.info.color} dimColor>
              Esc to quit · tip: set OPENROUTER_API_KEY to skip this screen
            </Text>
          </Box>
        </Box>
      )}

      {step === "signin" && (
        <OpenRouterSignIn
          onBack={() => setStep("method")}
          onKey={(minted) => {
            setKey(minted);
            void acceptKey(minted, "signin");
          }}
        />
      )}

      {step === "checking" && keySource === "signin" && (
        <Box marginTop={1}>
          <Text color={theme.info.color}>✓ signed in — checking the new key with OpenRouter…</Text>
        </Box>
      )}

      {(step === "key" || (step === "checking" && keySource === "key")) && (
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
              Enter to continue · Esc back · tip: set OPENROUTER_API_KEY to skip this screen
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
          {step === "model" && (
            <Box marginTop={1} flexDirection="column">
              <ModelPicker
                current=""
                title="Pick a model — switch any time with /model  ·  prices are USD per million tokens"
                onPick={(m) => {
                  if (m) void finish(m);
                  else {
                    setStep("key");
                    setKeyInfo(null);
                  }
                }}
              />
            </Box>
          )}
          {keyInfo?.isFreeTier && (
            <Box marginTop={1}>
              <Text color={theme.warn}>
                This key has no credits yet: only free models work (type "free" to find them), with a daily
                request cap. Add credits at https://openrouter.ai/settings/credits to use the others.
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
