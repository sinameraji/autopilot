import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";
import type { RemoteSession } from "../remote/session-store.js";
import { listRemoteSessions } from "../remote/session-store.js";
import { getRemoteStatus, cancelRemoteSession } from "../remote/worker-client.js";

interface Props {
  onSelect?: (session: RemoteSession) => void;
  onCancel?: () => void;
}

export function RemoteDashboard({ onSelect, onCancel }: Props) {
  const theme = useTheme();
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    try {
      setRefreshing(true);
      setSessions(await loadRemoteSessions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useInput((input, key) => {
    if (input === "r" || input === "R") {
      void loadSessions();
    }
    if (key.escape && onCancel) {
      onCancel();
    }
  });

  const items = sessions.map((s) => ({
    label: formatSessionLine(s),
    value: s.sessionId,
  }));

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.accent}>Loading remote sessions...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.error}>Error: {error}</Text>
        <Text dimColor>Press R to retry, Esc to close</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={theme.accent}>No remote sessions yet.</Text>
        <Text dimColor>Type /remote &lt;prompt&gt; to start one.</Text>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.accent}>
        Recent remote tasks {refreshing ? "(refreshing...)" : ""}
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            const session = sessions.find((s) => s.sessionId === item.value);
            if (session) onSelect?.(session);
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate • Enter select • R refresh • Esc close
        </Text>
      </Box>
    </Box>
  );
}

/** Remote sessions, newest first, with live status for unfinished ones. */
export async function loadRemoteSessions(): Promise<RemoteSession[]> {
  const list = await listRemoteSessions();
  const updated = await Promise.all(
    list.map(async (s) => {
      if (s.status !== "running" && s.status !== "pending") return s;
      try {
        const status = await getRemoteStatus(s.workerUrl, s.sessionId);
        return {
          ...s,
          status: status.status,
          prUrl: status.prUrl ?? s.prUrl,
          tokensUsed: status.tokensUsed ?? s.tokensUsed,
          tokensBudget: status.tokensBudget ?? s.tokensBudget,
          updatedAt: new Date().toISOString(),
        };
      } catch {
        return s;
      }
    }),
  );
  return updated.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function formatSessionLine(s: RemoteSession): string {
  const icon =
    s.status === "done"
      ? "✅"
      : s.status === "error"
        ? "❌"
        : s.status === "cancelled"
          ? "⏹️"
          : s.status === "running"
            ? "⏳"
            : "⏸";
  const ago = formatAgo(new Date(s.updatedAt));
  const prompt = s.prompt.slice(0, 30) + (s.prompt.length > 30 ? "…" : "");
  const outcome = s.prUrl ? `PR ${s.prUrl.split("/").pop()}` : s.status;
  const cost = s.tokensUsed && s.tokensBudget
    ? ` (${formatTokens(s.tokensUsed)}/${formatTokens(s.tokensBudget)})`
    : s.tokensUsed
      ? ` (${formatTokens(s.tokensUsed)})`
      : "";
  return `${icon} ${prompt} → ${outcome}  ${ago}${cost}`;
}

function formatAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function RemoteSessionDetail({
  session,
  onBack,
  onCancel,
}: {
  session: RemoteSession;
  onBack: () => void;
  onCancel?: (session: RemoteSession) => void;
}) {
  const theme = useTheme();
  const [cancelling, setCancelling] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
    if ((input === "c" || input === "C") && onCancel && (session.status === "running" || session.status === "pending")) {
      void handleCancel();
    }
  });

  async function handleCancel() {
    if (!onCancel) return;
    setCancelling(true);
    try {
      await cancelRemoteSession(session.workerUrl, session.sessionId);
      onCancel(session);
    } catch {
      // error handled by caller
    } finally {
      setCancelling(false);
    }
  }

  const isRunning = session.status === "running" || session.status === "pending";

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.accent}>Remote Session</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>ID:      {session.sessionId}</Text>
        <Text>Repo:    {session.repo}</Text>
        <Text>Status:  {session.status}</Text>
        <Text>Prompt:  {session.prompt}</Text>
        {session.prUrl && <Text>PR:      {session.prUrl}</Text>}
        {session.errorMessage && <Text color={theme.error}>Error:   {session.errorMessage}</Text>}
        {session.tokensUsed !== undefined && (
          <Text>Tokens:  {formatTokens(session.tokensUsed)}
            {session.tokensBudget ? ` / ${formatTokens(session.tokensBudget)}` : ""}
          </Text>
        )}
        <Text>Created: {new Date(session.createdAt).toLocaleString()}</Text>
        {session.finishedAt && <Text>Finished: {new Date(session.finishedAt).toLocaleString()}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="row" gap={2}>
        {isRunning && onCancel && (
          <Text color={theme.error}>
            {cancelling ? "Cancelling..." : "[C] Cancel session"}
          </Text>
        )}
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}
