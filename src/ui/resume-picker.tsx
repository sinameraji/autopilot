import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { SessionSummary } from "../sessions.js";
import { fuzzyFilter } from "../util/fuzzy.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";

interface Props {
  sessions: SessionSummary[];
  onPick: (session: SessionSummary | null) => void;
}

const PAGE_SIZE = 5;

export function ResumePicker({ sessions, onPick }: Props) {
  const theme = useTheme();
  const [page, setPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? fuzzyFilter(sessions, query, (s) => `${s.title ?? s.firstPrompt} ${s.id}`)
    : sessions;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, filtered.length);
  const pageSessions = filtered.slice(start, end);

  useInput((input, key) => {
    if (key.leftArrow && safePage > 0) {
      setPage((p) => p - 1);
      setSelectedIndex(0);
      return;
    }
    if (key.rightArrow && safePage < totalPages - 1) {
      setPage((p) => p + 1);
      setSelectedIndex(0);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setPage(0);
      setSelectedIndex(0);
      return;
    }
    // Keystrokes typed while a render is in flight arrive together as one
    // multi-char `input` — accept all printable characters, not just 1-char input.
    const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable.length > 0 && !key.ctrl && !key.meta && !key.return && !key.escape) {
      setQuery((q) => q + printable);
      setPage(0);
      setSelectedIndex(0);
      return;
    }
    if (input === "q" || key.escape) {
      onPick(null);
      return;
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Resume a session
        </Text>
        <Text color={theme.info.color}>No saved sessions yet. Press Enter to dismiss.</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[{ label: "(back)", value: "__cancel__" }]}
            onSelect={() => onPick(null)}
          />
        </Box>
      </Box>
    );
  }

  const items = pageSessions.map((s) => ({
    label: `${formatDate(s.updatedAt)}  ·  ${s.messageCount} msgs  ·  ${s.title ?? s.firstPrompt}`,
    value: s.id,
  }));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        Resume a session
      </Text>
      <Text color={theme.info.color}>
        {query ? `Search: ${query}▌` : "Type to search…"}  ·  Page {safePage + 1} of {totalPages} ({filtered.length} total)
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          initialIndex={selectedIndex}
          onHighlight={(item) => {
            const idx = items.findIndex((i) => i.value === item.value);
            if (idx >= 0) setSelectedIndex(idx);
          }}
          onSelect={(item) => {
            const picked = sessions.find((s) => s.id === item.value) ?? null;
            onPick(picked);
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.info.color}>
          {safePage > 0 ? "← prev  " : ""}
          {safePage < totalPages - 1 ? "→ next  " : ""}
          q: cancel
        </Text>
      </Box>
    </Box>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
