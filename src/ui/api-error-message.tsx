import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme-context.js";

interface Props {
  httpStatus?: number;
  code?: number;
  message: string;
}

export function ApiErrorMessage({ httpStatus, code, message }: Props) {
  const theme = useTheme();

  const parts: string[] = [];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  if (code !== undefined) parts.push(`code: ${code}`);
  const meta = parts.join(" · ");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.error} paddingX={1} marginY={1}>
      <Text bold color={theme.error}>
        ⚠ {message}
      </Text>
      {meta && (
        <Text color={theme.muted?.color ?? theme.info.color} dimColor={theme.muted?.dim ?? true}>
          {meta}
        </Text>
      )}
      <Text color={theme.muted?.color ?? theme.info.color} dimColor={theme.muted?.dim ?? true}>
        Provider status: https://status.openrouter.ai · switch models with /model
      </Text>
    </Box>
  );
}
