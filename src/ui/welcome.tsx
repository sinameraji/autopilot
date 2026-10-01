import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";
import { buildWelcome } from "./greetings.js";

export function Welcome() {
  const theme = useTheme();
  const now = new Date();
  const { headline } = buildWelcome({
    hour: now.getHours(),
    day: now.getDay(),
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>
          {headline}
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text color={theme.info.color} dimColor>
          Type / for commands · try /subagents help
        </Text>
      </Box>

    </Box>
  );
}
