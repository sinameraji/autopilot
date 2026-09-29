import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "./spinner.js";
import type { Task } from "../tools/registry.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";

interface Props {
  tasks: Task[];
  startedAt: number | null;
  tokensDelta: number;
}

const MAX_VISIBLE = 6;

export function TaskList({ tasks, startedAt, tokensDelta }: Props) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now());
  const [celebrating, setCelebrating] = useState(false);
  const tasksRef = useRef(tasks);
  const prevAllDoneRef = useRef(false);
  tasksRef.current = tasks;

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => {
      setNow(Date.now());
      const current = tasksRef.current;
      if (current.length > 0 && current.every((t) => t.status === "completed")) {
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Celebration trigger: detect transition to all-done
  useEffect(() => {
    const allDone = tasks.length > 0 && tasks.every((t) => t.status === "completed");
    if (allDone && !prevAllDoneRef.current) {
      setCelebrating(true);
      const id = setTimeout(() => setCelebrating(false), 1500);
      return () => clearTimeout(id);
    }
    prevAllDoneRef.current = allDone;
  }, [tasks]);

  if (tasks.length === 0) return null;

  const active = tasks.find((t) => t.status === "in_progress");
  const done = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const allDone = done === total;

  const header = active ? active.title : allDone ? `${total} tasks done` : `${done}/${total}`;

  const elapsed = startedAt ? formatElapsed(now - startedAt) : null;
  const headerStats = [elapsed, tokensDelta > 0 ? `↑ ${formatTokens(tokensDelta)} tokens` : null]
    .filter(Boolean)
    .join(" · ");

  const visibleTasks = tasks.slice(0, MAX_VISIBLE);
  const hiddenPending = Math.max(0, tasks.length - visibleTasks.length);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={celebrating ? theme.palette.success : allDone ? "green" : theme.accent} bold>
          {celebrating ? `✨ ${header}` : header}
        </Text>
        {headerStats && (
          <Text color={theme.info.color} >
            {"  "}({headerStats})
          </Text>
        )}
      </Box>
      {visibleTasks.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
      {hiddenPending > 0 && (
        <Text color={theme.info.color} >
          {"  "}… +{hiddenPending} more
        </Text>
      )}
    </Box>
  );
}

function TaskRow({ task }: { task: Task }) {
  const theme = useTheme();
  if (task.status === "completed") {
    return (
      <Text color={theme.info.color} >
        {"  "}✓ <Text strikethrough>{task.title}</Text>
      </Text>
    );
  }
  if (task.status === "in_progress") {
    return (
      <Text color={theme.accent} bold>
        {"  "}<Spinner type="line" /> {task.title}
      </Text>
    );
  }
  return (
    <Text color={theme.info.color} >
      {"  "}☐ {task.title}
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

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
