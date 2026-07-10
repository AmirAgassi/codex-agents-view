import React, { memo, useMemo } from "react";
import { Box, Text } from "ink";
import type { SessionRecord } from "../domain/types.js";
import { formatAge, semanticGroup, sessionName, sessionSummary } from "./format.js";
import type {
  SemanticSessionGroup,
  SessionListItem,
  SessionSection,
} from "./types.js";

interface SessionListProps {
  sections: SessionSection[];
  items: SessionListItem[];
  selectedId?: string;
  maxRows: number;
  width: number;
  subagentsByParentId: Record<string, SessionRecord[]>;
}

type ListEntry =
  | { type: "spacer"; key: string }
  | { type: "heading"; key: string; label: string; count: number }
  | { type: "session"; key: string; item: SessionListItem }
  | { type: "subagent"; key: string; record: SessionRecord };

interface VisibleEntries {
  before: number;
  after: number;
  entries: ListEntry[];
}

const STATUS_APPEARANCE: Record<
  SemanticSessionGroup,
  { symbol: string; color: string }
> = {
  needsInput: { symbol: "◆", color: "yellow" },
  working: { symbol: "*", color: "cyan" },
  completed: { symbol: "●", color: "green" },
  stale: { symbol: "○", color: "gray" },
};

function visibleWindow(
  sections: SessionSection[],
  items: SessionListItem[],
  selectedId: string | undefined,
  maxRows: number,
  subagentsByParentId: Record<string, SessionRecord[]>,
): VisibleEntries {
  if (items.length === 0) return { before: 0, after: 0, entries: [] };

  const entries: ListEntry[] = sections.flatMap((section, index) => [
    ...(index > 0
      ? [{ type: "spacer" as const, key: `spacer:${section.id}` }]
      : []),
    {
      type: "heading" as const,
      key: `heading:${section.id}`,
      label: section.label,
      count: section.items.length,
    },
    ...section.items.flatMap((item) => [
      {
        type: "session" as const,
        key: `session:${item.id}`,
        item,
      },
      ...(subagentsByParentId[item.id] ?? []).map((record) => ({
        type: "subagent" as const,
        key: `subagent:${record.thread.id}`,
        record,
      })),
    ]),
  ]);
  const selectedEntryIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.type === "session" && entry.item.id === selectedId),
  );
  // Reserve one line for each overflow indicator. Keeping this reservation fixed
  // makes the rendered line count stable while rapidly navigating long lists.
  const capacity = Math.max(1, maxRows - 2);
  const maxStart = Math.max(0, entries.length - capacity);
  const start = Math.min(
    maxStart,
    Math.max(0, selectedEntryIndex - capacity + 1),
  );
  const end = Math.min(entries.length, start + capacity);
  let before = 0;
  let after = 0;
  for (let index = 0; index < start; index += 1) {
    if (entries[index]?.type === "session") before += 1;
  }
  for (let index = end; index < entries.length; index += 1) {
    if (entries[index]?.type === "session") after += 1;
  }

  return {
    before,
    after,
    entries: entries.slice(start, end),
  };
}

interface SessionRowProps {
  item: SessionListItem;
  selected: boolean;
  nameWidth: number;
}

const SessionRow = memo(function SessionRow({
  item,
  selected,
  nameWidth,
}: SessionRowProps): React.JSX.Element {
  const appearance =
    item.record.thread.status.type === "systemError"
      ? { symbol: "×", color: "red" }
      : STATUS_APPEARANCE[item.semanticGroup];
  const timestamp =
    item.record.lastChangedAt ||
    item.record.thread.recencyAt ||
    item.record.thread.updatedAt;

  return (
    <Box
      width="100%"
      paddingX={1}
      backgroundColor={selected ? "gray" : undefined}
      aria-role="option"
      aria-state={{ selected }}
    >
      <Box width={2} flexShrink={0}>
        <Text color={appearance.color} bold={item.semanticGroup === "needsInput"}>
          {appearance.symbol}
        </Text>
      </Box>
      <Box width={nameWidth} minWidth={12} flexShrink={0}>
        <Text bold={selected} wrap="truncate-end">
          {sessionName(item.record)}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={8} marginLeft={1}>
        <Text dimColor={!selected} wrap="truncate-end">
          {sessionSummary(item.record)}
        </Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end" marginLeft={1}>
        <Text dimColor>{formatAge(timestamp)}</Text>
      </Box>
    </Box>
  );
});

const SubagentRow = memo(function SubagentRow({
  record,
  nameWidth,
}: {
  record: SessionRecord;
  nameWidth: number;
}): React.JSX.Element {
  const group = semanticGroup(record);
  const color = record.thread.status.type === "systemError" ? "red" : STATUS_APPEARANCE[group].color;
  const timestamp = record.lastChangedAt || record.thread.recencyAt || record.thread.updatedAt;

  return (
    <Box width="100%" paddingLeft={4} paddingRight={1}>
      <Box width={2} flexShrink={0}>
        <Text color={color}>•</Text>
      </Box>
      <Box width={Math.max(10, nameWidth - 3)} minWidth={10} flexShrink={0}>
        <Text dimColor wrap="truncate-end">{sessionName(record)}</Text>
      </Box>
      <Box flexGrow={1} minWidth={8} marginLeft={1}>
        <Text dimColor wrap="truncate-end">{sessionSummary(record)}</Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end" marginLeft={1}>
        <Text dimColor>{formatAge(timestamp)}</Text>
      </Box>
    </Box>
  );
});

function SessionListComponent({
  sections,
  items,
  selectedId,
  maxRows,
  width,
  subagentsByParentId,
}: SessionListProps): React.JSX.Element {
  const visible = useMemo(
    () => visibleWindow(sections, items, selectedId, maxRows, subagentsByParentId),
    [sections, items, selectedId, maxRows, subagentsByParentId],
  );
  const nameWidth = Math.max(16, Math.min(48, Math.floor(width * 0.42)));

  if (items.length === 0) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center" paddingY={2}>
        <Box flexDirection="column" alignItems="center">
          <Text bold>No Codex sessions yet</Text>
          <Text dimColor>Press n and describe a task to start one.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} aria-role="listbox">
      {visible.before > 0 ? (
        <Text dimColor>  … {visible.before} earlier</Text>
      ) : null}
      {visible.entries.map((entry) =>
        entry.type === "spacer" ? (
          <Box key={entry.key} height={1} />
        ) : entry.type === "heading" ? (
          <Box key={entry.key} paddingLeft={1}>
            <Text bold dimColor>{entry.label}</Text>
            <Text dimColor> {entry.count}</Text>
          </Box>
        ) : entry.type === "session" ? (
          <SessionRow
            key={entry.key}
            item={entry.item}
            selected={entry.item.id === selectedId}
            nameWidth={nameWidth}
          />
        ) : (
          <SubagentRow key={entry.key} record={entry.record} nameWidth={nameWidth} />
        ),
      )}
      {visible.after > 0 ? <Text dimColor>  … {visible.after} more</Text> : null}
    </Box>
  );
}

export const SessionList = memo(SessionListComponent);
