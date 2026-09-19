import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";
import type { ModelEntry, ModelProvider } from "../models/registry.js";
import { isCloudModeAvailable } from "../cloud/availability.js";

export type BillingChoice = "cloud" | "unified" | "byok";

interface Props {
  model: ModelEntry;
  onPick: (choice: BillingChoice | null) => void;
}

const PROVIDER_NAME: Record<ModelProvider, string> = {
  "workers-ai": "Cloudflare Workers AI",
  moonshotai: "Moonshot AI",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google AI Studio",
  "openai-compatible": "your provider",
  openrouter: "OpenRouter",
};

export function BillingChooser({ model, onPick }: Props) {
  const theme = useTheme();
  const name = PROVIDER_NAME[model.provider];

  useInput((_input, key) => {
    if (key.escape) onPick(null);
  });

  const items: { label: string; value: BillingChoice }[] = [
    // KimiFlare Cloud is temporarily hidden (src/cloud/availability.ts).
    ...(model.provider === "workers-ai" && isCloudModeAvailable()
      ? [{ label: `Start free with Kimiflare Cloud  ·  5M tokens`, value: "cloud" as const }]
      : []),
    { label: `Use Cloudflare credits  ·  no extra key`, value: "unified" as const },
    { label: `Use my own ${name} API key`, value: "byok" as const },
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
        Pay for {name}
      </Text>
      <Box marginTop={1}>
        <Text>
          You picked <Text bold>{model.id}</Text>. How would you like to pay for it?
        </Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onPick(item.value)} />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted?.color ?? theme.info.color} dimColor>
          ↑/↓ select  ·  Enter  ·  Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
