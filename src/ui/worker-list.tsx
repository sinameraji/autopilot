import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "./spinner.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";
import type { ActiveWorker, WorkerStep } from "../agent/supervisor.js";

interface Props {
  workers: ActiveWorker[];
  isSynthesizing?: boolean;
  narration?: string;
}

export function WorkerList({ workers, isSynthesizing, narration }: Props) {
  const theme = useTheme();

  if (workers.length === 0 && !narration) return null;

  const running = workers.filter((w) => w.status === "running").length;
  const completed = workers.filter((w) => w.status === "completed").length;
  const failed = workers.filter((w) => w.status === "failed").length;
  const budgetExhausted = workers.filter((w) => w.status === "budget_exhausted").length;
  const pending = workers.filter((w) => w.status === "pending").length;

  // Only show the synthesis spinner when workers are actually done and
  // the coordinator is crunching results. If workers are still running
  // we suppress it so the UI doesn't look like everything is stuck on
  // "Synthesizing" while sandboxes are still booting.
  const showSynthesis = isSynthesizing && running === 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {narration && (
        <Box marginBottom={1}>
          <Text color={theme.info.color} italic>
            {narration.split("\n").map((line, i) => (
              <Text key={`narration-${i}`}>{line}{"\n"}</Text>
            ))}
          </Text>
        </Box>
      )}
      <Box>
        <Text color={theme.accent} bold>
          Workers: {pending > 0 ? `${pending} todo · ` : ""}
          {running > 0 ? `${running} ongoing · ` : ""}
          {completed > 0 ? `${completed} done · ` : ""}
          {budgetExhausted > 0 ? `${budgetExhausted} budget hit · ` : ""}
          {failed > 0 ? `${failed} failed · ` : ""}
        </Text>
      </Box>
      {(() => {
        const anyPreRead = workers.find((w) => w.preReadFiles && w.preReadFiles.length > 0);
        if (!anyPreRead) return null;
        const fileCount = anyPreRead.preReadFiles!.length;
        const chars = anyPreRead.preReadChars ?? 0;
        return (
          <Box marginLeft={2}>
            <Text color={theme.info.color}>
              📦 Shared cache: {fileCount} file{fileCount > 1 ? "s" : ""} pre-read (~{chars.toLocaleString()} chars)
            </Text>
          </Box>
        );
      })()}
      {workers.map((w) => (
        <WorkerRow key={w.id} worker={w} />
      ))}
      {showSynthesis && (
        <Box marginLeft={2}>
          <Text color={theme.info.color}>
            <Spinner type="dots" />{" "}
            <Text bold>[coordinator]</Text> Synthesizing findings…
          </Text>
        </Box>
      )}
    </Box>
  );
}

function WorkerRow({ worker }: { worker: ActiveWorker }) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (worker.status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [worker.status]);

  const elapsed = formatElapsed(now - worker.startedAt);
  const modeLabel = worker.mode === "plan" ? "research" : "executor";

  // Status icons mirror the Camouflage TodoListUpdate protocol:
  //   ☐ pending  |  ◐ running  |  ☑ completed  |  ⚠ budget_exhausted  |  ☒ failed
  const statusIcon =
    worker.status === "pending" ? (
      <Text color={theme.muted?.color ?? theme.info.color}>☐</Text>
    ) : worker.status === "running" ? (
      <Text color={theme.info.color}>
        <Spinner type="line" />
      </Text>
    ) : worker.status === "completed" ? (
      <Text color={theme.palette.success}>☑</Text>
    ) : worker.status === "budget_exhausted" ? (
      <Text color={theme.info.color}>⚠</Text>
    ) : (
      <Text color={theme.palette.error}>☒</Text>
    );

  const statusLabel =
    worker.status === "pending"
      ? "todo"
      : worker.status === "running"
      ? "ongoing"
      : worker.status === "completed"
      ? "done"
      : worker.status === "budget_exhausted"
      ? "budget hit"
      : "failed";

  const isDone = worker.status === "completed" || worker.status === "failed" || worker.status === "budget_exhausted";
  const hasSteps = worker.steps && worker.steps.length > 0;
  const logPreview = workerLogPreview(worker);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text>
          {statusIcon}{" "}
          <Text color={theme.info.color} bold>
            [{modeLabel}]
          </Text>{" "}
          <Text
            color={isDone ? theme.muted?.color ?? theme.info.color : theme.info.color}
            italic={worker.status === "pending"}
            strikethrough={worker.status === "completed"}
          >
            {worker.task.slice(0, 60)}
          </Text>
          {worker.status === "running" ? (
            <Text color={theme.accent}> · {elapsed}</Text>
          ) : (
            <Text color={theme.muted?.color ?? theme.info.color} dimColor>
              {" "}
              · {statusLabel}
            </Text>
          )}
          {worker.error ? (
            <Text color={theme.palette.error}> · {worker.error.slice(0, 60)}</Text>
          ) : null}
        </Text>
      </Box>

      {/* Structured steps — primary visibility */}
      {hasSteps && (
        <Box flexDirection="column" marginLeft={4}>
          {worker.steps!.map((step, i) => (
            <StepRow key={`${worker.id}-step-${i}`} step={step} theme={theme} />
          ))}
        </Box>
      )}

      {/* Routine logs duplicate the task/step summaries; keep one line for failures. */}
      {logPreview && (
        <Box marginLeft={4}>
          <Text color={theme.muted?.color ?? theme.info.color} dimColor>
            Last log: {logPreview}
          </Text>
        </Box>
      )}

      {/* Phase timing — shown when worker is done and data is available */}
      {isDone && worker.result?.phases && worker.result.phases.length > 0 && (
        <Box marginLeft={4}>
          <Text color={theme.muted?.color ?? theme.info.color} dimColor>
            {worker.result.phases.map((p) => `${p.name}: ${formatElapsed(p.ms)}`).join(" · ")}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function workerLogPreview(
  worker: Pick<ActiveWorker, "status" | "logs">,
): string | undefined {
  if (worker.status !== "failed" && worker.status !== "budget_exhausted") return undefined;
  const lastLine = worker.logs.at(-1)?.replace(/\s+/g, " ").trim();
  if (!lastLine) return undefined;
  return lastLine.length <= 120 ? lastLine : `${lastLine.slice(0, 119)}…`;
}

function StepRow({ step, theme }: { step: WorkerStep; theme: Theme }) {
  if (step.status === "completed") {
    return (
      <Text color={theme.palette.success}>
        {"  "}✓ <Text strikethrough>{step.label}</Text>
      </Text>
    );
  }
  if (step.status === "active") {
    return (
      <Text color={theme.accent} bold>
        {"  "}<Spinner type="line" /> {step.label}
      </Text>
    );
  }
  if (step.status === "failed") {
    return (
      <Text color={theme.palette.error}>
        {"  "}☒ {step.label}
      </Text>
    );
  }
  return (
    <Text color={theme.muted?.color ?? theme.info.color} dimColor>
      {"  "}☐ {step.label}
    </Text>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
