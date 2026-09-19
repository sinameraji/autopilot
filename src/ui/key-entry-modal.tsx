import { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { CustomTextInput } from "./text-input.js";
import { useTheme } from "./theme-context.js";
import type { ModelEntry, ModelProvider } from "../models/registry.js";
import { aliasFor, ensureStore, pushProviderKey } from "../agent/secrets-store.js";

export type KeyResult =
  | { kind: "alias"; alias: string; secretsStoreId: string }
  | { kind: "local"; key: string };

interface Props {
  model: ModelEntry;
  accountId: string;
  apiToken: string;
  /** Existing kimi-code Secrets Store id, if we've created one before. */
  secretsStoreId?: string;
  onSave: (result: KeyResult) => void;
  onCancel: () => void;
}

const PROVIDER_INFO: Record<ModelProvider, { name: string; url: string; hint: string }> = {
  "workers-ai": {
    name: "Cloudflare Workers AI",
    url: "https://dash.cloudflare.com/profile/api-tokens",
    hint: "Use a token with the Workers AI permission.",
  },
  moonshotai: {
    name: "Moonshot AI",
    url: "https://platform.moonshot.cn/",
    hint: "Create a key in the Moonshot console. Starts with `sk-`.",
  },
  anthropic: {
    name: "Anthropic",
    url: "https://console.anthropic.com/settings/keys",
    hint: "Create a key in Settings → API Keys. Starts with `sk-ant-`.",
  },
  openai: {
    name: "OpenAI",
    url: "https://platform.openai.com/api-keys",
    hint: "Create a key in Settings → API Keys. Starts with `sk-`.",
  },
  google: {
    name: "Google AI Studio",
    url: "https://aistudio.google.com/app/apikey",
    hint: "Create a key in Get API key. Starts with `AIza…`.",
  },
  "openai-compatible": {
    name: "your provider",
    url: "your provider's dashboard",
    hint: "Paste the API key your provider issued.",
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/keys",
    hint: "Create a key in Settings → Keys. Starts with `sk-or-`.",
  },
};

function maskPreview(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(0, value.length - 8))}${value.slice(-4)}`;
}

type Phase =
  | { kind: "collecting" }
  | { kind: "uploading" }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

export function KeyEntryModal({
  model,
  accountId,
  apiToken,
  secretsStoreId,
  onSave,
  onCancel,
}: Props) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "collecting" });
  const info = PROVIDER_INFO[model.provider];

  useInput((input, key) => {
    if (key.escape && phase.kind === "collecting") {
      onCancel();
      return;
    }
    if (key.ctrl && input === "r" && phase.kind === "collecting") {
      setReveal((r) => !r);
      return;
    }
  });

  const upload = async (rawKey: string) => {
    setPhase({ kind: "uploading" });

    // 1. Ensure we have a Secrets Store id.
    let storeId = secretsStoreId;
    if (!storeId) {
      const ensured = await ensureStore(accountId, apiToken);
      if (!ensured.ok) {
        if (ensured.reason === "forbidden") {
          setPhase({ kind: "forbidden", message: ensured.message });
        } else {
          setPhase({ kind: "error", message: ensured.message });
        }
        return;
      }
      storeId = ensured.value;
    }

    // 2. Push the secret. Provider type narrowed to keys we know about.
    const provider = model.provider as "anthropic" | "openai" | "google" | "moonshotai" | "openai-compatible";
    const baseName = aliasFor(provider);
    // Append a short random suffix so re-saves don't 409 on existing-name collision.
    const name = `${baseName}-${Math.random().toString(36).slice(2, 8)}`;
    const pushed = await pushProviderKey(accountId, apiToken, storeId, name, rawKey);
    if (!pushed.ok) {
      if (pushed.reason === "forbidden") {
        setPhase({ kind: "forbidden", message: pushed.message });
      } else {
        setPhase({ kind: "error", message: pushed.message });
      }
      return;
    }

    // 3. Hand back the alias. The parent will persist
    //    cfg.providerKeyAliases[provider] + cfg.secretsStoreId.
    onSave({ kind: "alias", alias: pushed.value, secretsStoreId: storeId });
  };

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    void upload(trimmed);
  };

  if (phase.kind === "uploading") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={1}
      >
        <Text color={theme.accent} bold>
          Storing in Cloudflare Secrets Store…
        </Text>
        <Box marginTop={1}>
          <Text color={theme.info.color} dimColor>
            Your key never touches disk — it's being pushed straight to Cloudflare with
            scope: ai_gateway.
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "forbidden") {
    const fallbackItems = [
      { label: "Open dashboard to add the Secrets Store Edit scope", value: "scope" as const },
      { label: "Store the key locally instead (⚠ less safe)", value: "local" as const },
      { label: "Cancel", value: "cancel" as const },
    ];
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={1}
      >
        <Text color={theme.accent} bold>
          Your Cloudflare token can't write to Secrets Store.
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.info.color}>
            To keep your key off disk, add the <Text bold>Secrets Store Edit</Text> permission
            to your token at:
          </Text>
          <Text color={theme.accent} underline>
            https://dash.cloudflare.com/profile/api-tokens
          </Text>
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={fallbackItems}
            onSelect={(item) => {
              if (item.value === "local") {
                onSave({ kind: "local", key: value.trim() });
              } else if (item.value === "scope") {
                setPhase({ kind: "collecting" });
              } else {
                onCancel();
              }
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted?.color ?? theme.info.color} dimColor>
            Local fallback writes to ~/.config/kimiflare/config.json (mode 600). Do not commit
            that file.
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "error") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={1}
      >
        <Text color={theme.accent} bold>
          Couldn't store the key.
        </Text>
        <Box marginTop={1}>
          <Text color={theme.info.color}>{phase.message}</Text>
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "Try again", value: "retry" as const },
              { label: "Cancel", value: "cancel" as const },
            ]}
            onSelect={(item) => {
              if (item.value === "retry") setPhase({ kind: "collecting" });
              else onCancel();
            }}
          />
        </Box>
      </Box>
    );
  }

  // phase === "collecting"
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
    >
      <Text color={theme.accent} bold>
        Connect {info.name}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          To use <Text bold>{model.id}</Text>, kimi-code needs your {info.name} API key.
        </Text>
        <Box marginTop={1}>
          <Text>
            1. Get a key here:{" "}
            <Text color={theme.accent} underline>
              {info.url}
            </Text>
          </Text>
        </Box>
        <Text>2. Paste it below and press Enter.</Text>
        <Box marginTop={1}>
          <Text color={theme.muted?.color ?? theme.info.color} dimColor>
            {info.hint}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.info.color}>API key:</Text>
        {reveal ? (
          <CustomTextInput value={value} onChange={setValue} onSubmit={submit} focus />
        ) : (
          <Box flexDirection="column">
            <Text>{maskPreview(value) || " "}</Text>
            <Box height={0} overflow="hidden">
              <CustomTextInput value={value} onChange={setValue} onSubmit={submit} focus />
            </Box>
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted?.color ?? theme.info.color} dimColor>
          Enter to save  ·  Ctrl+R to {reveal ? "hide" : "reveal"}  ·  Esc to cancel
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted?.color ?? theme.info.color} dimColor>
          Key never touches disk. Pushed to Cloudflare Secrets Store (scope: ai_gateway), then
          referenced by alias on every request. Audit: src/agent/secrets-store.ts ·
          src/agent/client.ts
        </Text>
      </Box>
    </Box>
  );
}
