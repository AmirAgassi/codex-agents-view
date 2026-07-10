import React, { memo } from "react";
import { Box, Text } from "ink";
import { abbreviateHome } from "./format.js";
import type { DashboardCounts } from "./types.js";

interface HeaderProps {
  title: string;
  version?: string;
  model?: string;
  cwd: string;
  counts: DashboardCounts;
  connection: "connecting" | "connected" | "disconnected" | "error";
}

const CONNECTION_LABEL = {
  connecting: "connecting",
  connected: "connected",
  disconnected: "offline",
  error: "connection error",
} as const;

const CONNECTION_COLOR = {
  connecting: "yellow",
  connected: "green",
  disconnected: "gray",
  error: "red",
} as const;

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}`;
}

function HeaderComponent({
  title,
  version,
  model,
  cwd,
  counts,
  connection,
}: HeaderProps): React.JSX.Element {
  return (
    <Box flexDirection="row" paddingX={1} paddingTop={1} paddingBottom={1}>
      <Box width={12} flexDirection="column" alignItems="center">
        <Text color="magenta" bold>{"╭──────╮"}</Text>
        <Text color="magenta" bold>{"│  ›_  │"}</Text>
        <Text color="magenta" bold>{"╰──┬───╯"}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" minWidth={0}>
        <Box>
          <Text bold>{title}</Text>
          {version ? <Text dimColor> {version}</Text> : null}
          <Text dimColor> · </Text>
          <Text color={CONNECTION_COLOR[connection]}>
            {CONNECTION_LABEL[connection]}
          </Text>
        </Box>
        <Text wrap="truncate-end" dimColor>
          {model ? `${model} · ` : ""}
          {abbreviateHome(cwd)}
        </Text>
        <Box>
          <Text color="yellow">
            {countLabel(counts.needsInput, "awaiting input")}
          </Text>
          <Text dimColor> · </Text>
          <Text color="cyan">{countLabel(counts.working, "working")}</Text>
          <Text dimColor> · </Text>
          <Text>{countLabel(counts.completed, "completed")}</Text>
          <Text dimColor> · </Text>
          <Text color="gray">{countLabel(counts.stale, "stale")}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export const Header = memo(HeaderComponent);
