import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "./spinner.js";
import { DiffView } from "./diff-view.js";
import { collapsePathsInText } from "../util/paths.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";
import { humanizeToolTitle, type IntentTier } from "./narrator.js";

export interface ToolEventState {
  id: string;
  name: string;
  args: string;
  status: "queued" | "running" | "done" | "error" | "blocked" | "cancelled" | "rejected";
  result?: string;
  render?: { title: string; body?: string; diff?: { path: string; before: string; after: string } };
  expanded?: boolean;
  startedAt?: number;
}

interface Props {
  evt: ToolEventState;
  verbose?: boolean;
  isRepeated?: boolean;
  intentTier?: IntentTier;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 1) return `${ms}ms`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export const ToolView = React.memo(function ToolView({ evt, verbose, isRepeated, intentTier }: Props) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (evt.startedAt === undefined) return;
    if (evt.status !== "running") {
      setNow(Date.now());
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [evt.status, evt.startedAt]);

  const statusIcon =
    evt.status === "queued" ? (
      <Text color={theme.muted?.color ?? theme.info.color}>
        [ ]
      </Text>
    ) : evt.status === "running" ? (
      <Text color={theme.info.color}>
        <Spinner type="dots" />
      </Text>
    ) : evt.status === "blocked" ? (
      <Text color={theme.muted?.color ?? theme.info.color} dimColor>[skip]</Text>
    ) : evt.status === "error" ? (
      <Text color={theme.palette.error}>[err]</Text>
    ) : evt.status === "cancelled" ? (
      <Text color={theme.info.color}>
        [x]
      </Text>
    ) : evt.status === "rejected" ? (
      <Text color={theme.palette.error}>[!]</Text>
    ) : (
      <Text color={theme.palette.success}>[ok]</Text>
    );
  const rawTitle = evt.render?.title ?? `${evt.name}(${compactArgs(evt.args)})`;
  let title = humanizeToolTitle(evt.name, rawTitle, intentTier);
  if (evt.startedAt !== undefined && (evt.status === "running" || evt.status === "done" || evt.status === "error")) {
    title += ` \u00b7 ${formatElapsed(now - evt.startedAt)}`;
  }

  const statusLabel =
    evt.status === "rejected" ? (
      <Text color={theme.palette.error}> rejected</Text>
    ) : evt.status === "cancelled" ? (
      <Text color={theme.info.color}> cancelled</Text>
    ) : null;

  const showItalic = evt.status === "queued" || evt.status === "cancelled" || evt.status === "rejected";

  const expand = Boolean(evt.expanded || verbose);
  const visibleResult = evt.status === "blocked" ? undefined : evt.result;
  const lines = visibleResult ? visibleResult.split("\n") : [];
  const showLimit = verbose ? 200 : 20;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        {statusIcon}{" "}
        <Text color={theme.info.color} italic={showItalic}>{title}</Text>
        {statusLabel}
        {isRepeated ? (
          <Text color={theme.warn}> [warn] repeated</Text>
        ) : null}
      </Text>
      {evt.render?.diff ? (
        <Box marginLeft={2}>
          <DiffView {...evt.render.diff} />
        </Box>
      ) : null}
      {visibleResult && expand ? (
        <Box
          marginLeft={2}
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.info.color}
          paddingX={1}
        >
          {lines.slice(0, showLimit).map((l, i) => (
            <Text key={i} color={theme.info.color}>
              {l}
            </Text>
          ))}
          {lines.length > showLimit && (
            <Text color={theme.info.color}>
              … ({lines.length - showLimit} more lines)
            </Text>
          )}
        </Box>
      ) : null}
      {visibleResult && !expand && evt.status !== "running" && evt.status !== "queued" && evt.status !== "cancelled" && evt.status !== "rejected" ? (
        <Text color={theme.info.color}>
          {"  "}{firstLine(visibleResult)}
        </Text>
      ) : null}
    </Box>
  );
});

function compactArgs(raw: string): string {
  const collapsed = collapsePathsInText(raw, process.cwd());
  const s = collapsed.replace(/\s+/g, " ");
  return s.length <= 80 ? s : s.slice(0, 80) + "…";
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length <= 120 ? line : line.slice(0, 120) + "…";
}
