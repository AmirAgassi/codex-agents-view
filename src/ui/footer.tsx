import React, { memo } from "react";
import { Box, Text } from "ink";
import type { DashboardStatusMessage } from "./types.js";

interface FooterProps {
  connection: "connecting" | "connected" | "disconnected" | "error";
  connectionError?: string;
  message?: DashboardStatusMessage | string;
  composerActive: boolean;
  hasSelection: boolean;
  hasPendingRequest: boolean;
}

const MESSAGE_COLOR = {
  info: "cyan",
  success: "green",
  warning: "yellow",
  error: "red",
} as const;

function FooterComponent({
  connection,
  connectionError,
  message,
  composerActive,
  hasSelection,
  hasPendingRequest,
}: FooterProps): React.JSX.Element {
  const normalized =
    typeof message === "string" ? { kind: "info" as const, text: message } : message;
  const connectionMessage =
    connection === "error"
      ? connectionError ?? "Could not connect to Codex app-server"
      : connection === "disconnected"
        ? "Codex app-server is offline"
        : connection === "connecting"
          ? "Connecting to Codex app-server…"
          : undefined;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box minWidth={0} flexGrow={1}>
        {normalized ? (
          <Text color={MESSAGE_COLOR[normalized.kind ?? "info"]} wrap="truncate-end">
            {normalized.text}
          </Text>
        ) : connectionMessage ? (
          <Text color={connection === "error" ? "red" : "yellow"} wrap="truncate-end">
            {connectionMessage}
          </Text>
        ) : composerActive ? (
          <Text dimColor>enter submit · tab complete command · ctrl/alt+⌫ word · esc cancel</Text>
        ) : (
          <Text dimColor>
            {hasPendingRequest ? "ctrl+a allow · ctrl+d decline · " : ""}
            {hasSelection ? "←/→/enter chat · / commands · space reply · " : ""}
            type new task · shift+↑/↓ reorder · ctrl+g shortcuts
          </Text>
        )}
      </Box>
      <Text dimColor> ctrl+c quit</Text>
    </Box>
  );
}

export const Footer = memo(FooterComponent);
