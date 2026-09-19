import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";
import type { ModelEntry, ModelProvider } from "../models/registry.js";
import { probeUnifiedBilling, type ProbeResult } from "../agent/probe-unified-billing.js";
import { enableGatewayAuth } from "../cloud/ai-gateway-api.js";

const PROVIDER_NAME: Record<ModelProvider, string> = {
  "workers-ai": "Cloudflare Workers AI",
  moonshotai: "Moonshot AI",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google AI Studio",
  "openai-compatible": "your provider",
  openrouter: "OpenRouter",
};

interface Props {
  model: ModelEntry;
  accountId: string;
  apiToken: string;
  gatewayId: string;
  onResolve: (result: "enabled" | "fallback-byok" | "cancelled") => void;
}

type Phase =
  | { kind: "probing" }
  | { kind: "success" }
  | {
      kind: "needs-setup";
      message: string;
      eventId: string | null;
      status: number | null;
    }
  | {
      kind: "other-error";
      message: string;
      eventId: string | null;
      status: number | null;
    };

export function UnifiedBillingStatus({
  model,
  accountId,
  apiToken,
  gatewayId,
  onResolve,
}: Props) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [attempt, setAttempt] = useState(0);
  const name = PROVIDER_NAME[model.provider];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r: ProbeResult = await probeUnifiedBilling({
        accountId,
        apiToken,
        gatewayId,
        model: model.id,
      });
      if (cancelled) return;
      if (r.ok) {
        setPhase({ kind: "success" });
        setTimeout(() => onResolve("enabled"), 700);
      } else if (r.reason === "needs-setup") {
        setPhase({
          kind: "needs-setup",
          message: r.message,
          eventId: r.eventId,
          status: r.status,
        });
      } else {
        setPhase({
          kind: "other-error",
          message: r.message,
          eventId: r.eventId,
          status: r.status,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // re-run whenever `attempt` changes (Retry pressed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useInput((_input, key) => {
    if (key.escape) onResolve("cancelled");
  });

  if (phase.kind === "probing") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
        <Text color={theme.accent} bold>
          Enabling unified billing for {name}…
        </Text>
        <Box marginTop={1}>
          <Text color={theme.info.color} dimColor>
            Sending a 1-token test request through your AI Gateway. This takes a moment.
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "success") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
        <Text color={theme.accent} bold>
          ✓ done — {name} billed via your Cloudflare credits.
        </Text>
      </Box>
    );
  }

  if (phase.kind === "needs-setup") {
    const items = [
      {
        label: "Enable Authentication on this gateway (fixes UB) — recommended",
        value: "enable-auth" as const,
      },
      { label: "I've enabled it — try again", value: "retry" as const },
      { label: `Use my own ${name} API key instead`, value: "byok" as const },
      { label: "Cancel", value: "cancel" as const },
    ];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
        <Text color={theme.accent} bold>
          {name} needs Cloudflare credits before Unified Billing can pay for it.
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Step-by-step (Unified Billing is implicit — adding credits IS enabling it):</Text>
          <Text>  1. Open the AI Gateway Credits page:</Text>
          <Text color={theme.accent} underline>
            {`     https://dash.cloudflare.com/${accountId}/ai/ai-gateway/credits`}
          </Text>
          <Text>  2. Add a payment method if you don't have one yet.</Text>
          <Text>  3. Click <Text bold>"Top-up credits"</Text> and confirm the amount.</Text>
          <Text>  4. Come back here and pick <Text bold>"I've enabled it — try again"</Text>.</Text>
          <Box marginTop={1}>
            <Text color={theme.muted?.color ?? theme.info.color} dimColor>
              Credits are one account-wide pool. Confirmed providers: OpenAI &
              Anthropic. Others (Google, Groq, xAI, Moonshot AI) may not be
              supported yet — the retry will tell you.
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted?.color ?? theme.info.color} dimColor>
              Hint: if you already have credits, your gateway probably has
              Authentication turned off. CF needs it ON for Unified Billing to
              activate. Picking "Enable Authentication" above flips it for you.
            </Text>
          </Box>
          {phase.eventId ? (
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted?.color ?? theme.info.color} dimColor>
                Debug · HTTP {phase.status} · cf-aig-event-id: {phase.eventId}
              </Text>
              <Text color={theme.muted?.color ?? theme.info.color} dimColor>
                Look up the full upstream error at:
              </Text>
              <Text color={theme.accent} underline>
                {`     https://dash.cloudflare.com/${accountId}/ai/ai-gateway/gateways/${gatewayId}/logs`}
              </Text>
              <Text color={theme.muted?.color ?? theme.info.color} dimColor>
                CF response: {phase.message}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "enable-auth") {
                setPhase({ kind: "probing" });
                void (async () => {
                  const r = await enableGatewayAuth(accountId, apiToken, gatewayId);
                  if (r.ok) {
                    setAttempt((a) => a + 1);
                  } else {
                    setPhase({
                      kind: "other-error",
                      message: `Couldn't enable Authentication on this gateway: ${r.message}`,
                      eventId: null,
                      status: null,
                    });
                  }
                })();
              } else if (item.value === "retry") {
                setAttempt((a) => a + 1);
              } else if (item.value === "byok") {
                onResolve("fallback-byok");
              } else {
                onResolve("cancelled");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // other-error
  const items = [
    { label: "Retry", value: "retry" as const },
    { label: `Use my own ${name} API key instead`, value: "byok" as const },
    { label: "Cancel", value: "cancel" as const },
  ];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
      <Text color={theme.accent} bold>
        Couldn't reach your AI Gateway.
      </Text>
      <Box marginTop={1}>
        <Text color={theme.info.color}>{phase.message}</Text>
      </Box>
      {phase.eventId ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.muted?.color ?? theme.info.color} dimColor>
            Debug · HTTP {phase.status} · cf-aig-event-id: {phase.eventId}
          </Text>
          <Text color={theme.muted?.color ?? theme.info.color} dimColor>
            Look up the full upstream error at:
          </Text>
          <Text color={theme.accent} underline>
            {`     https://dash.cloudflare.com/${accountId}/ai/ai-gateway/gateways/${gatewayId}/logs`}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "retry") setAttempt((a) => a + 1);
            else if (item.value === "byok") onResolve("fallback-byok");
            else onResolve("cancelled");
          }}
        />
      </Box>
    </Box>
  );
}
