import React, { memo, useMemo } from "react";
import { Box, Text } from "ink";
import {
  slashCommandSuggestions,
  type TextRange,
  validSlashCommandRanges,
} from "./slash-commands.js";

export type ComposerMode = "new" | "reply" | "answer" | "rename";

interface ComposerProps {
  active: boolean;
  mode: ComposerMode;
  value: string;
  cursor: number;
  width: number;
  targetName?: string;
  questionLabel?: string;
  secret?: boolean;
  disabled?: boolean;
}

interface VisibleInput {
  before: string;
  cursor: string;
  after: string;
  start: number;
  cursorIndex: number;
  hiddenBefore: boolean;
  hiddenAfter: boolean;
}

function sliceInput(value: string, cursor: number, capacity: number): VisibleInput {
  const characters = Array.from(value);
  const safeCursor = Math.max(0, Math.min(characters.length, cursor));
  const usable = Math.max(4, capacity);
  const start = Math.max(
    0,
    Math.min(safeCursor - Math.floor(usable * 0.7), characters.length - usable),
  );
  const end = Math.min(characters.length, start + usable);

  return {
    before: characters.slice(start, safeCursor).join(""),
    cursor: characters[safeCursor] ?? " ",
    after: characters.slice(safeCursor + 1, end).join(""),
    start,
    cursorIndex: safeCursor,
    hiddenBefore: start > 0,
    hiddenAfter: end < characters.length,
  };
}

function highlightedText(text: string, start: number, ranges: readonly TextRange[]): React.ReactNode[] {
  return Array.from(text).map((character, index) => {
    const highlighted = ranges.some((range) => start + index >= range.start && start + index < range.end);
    return highlighted
      ? <Text key={index} color="cyan" bold>{character}</Text>
      : character;
  });
}

function placeholder(
  active: boolean,
  mode: ComposerMode,
  targetName: string | undefined,
  questionLabel: string | undefined,
): string {
  if (!active) return "type a task · / for commands · space to reply";
  if (mode === "reply") return `reply to ${targetName ?? "selected session"}`;
  if (mode === "answer") return questionLabel ?? "answer the question";
  if (mode === "rename") return `rename ${targetName ?? "selected session"}`;
  return "describe a task for a new session";
}

function ComposerComponent({
  active,
  mode,
  value,
  cursor,
  width,
  targetName,
  questionLabel,
  secret = false,
  disabled = false,
}: ComposerProps): React.JSX.Element {
  const prompt = mode === "reply" ? "↳" : mode === "answer" ? "?" : mode === "rename" ? "✎" : "›";
  const renderedValue = secret ? "•".repeat(Array.from(value).length) : value;
  const visible = useMemo(
    () => sliceInput(renderedValue, cursor, Math.max(8, width - 8)),
    [renderedValue, cursor, width],
  );
  const hint = placeholder(active, mode, targetName, questionLabel);
  const commandRanges = useMemo(
    () => mode === "new" ? validSlashCommandRanges(renderedValue) : [],
    [mode, renderedValue],
  );
  const commandSuggestions = useMemo(
    () => active && mode === "new" ? slashCommandSuggestions(value, cursor) : [],
    [active, cursor, mode, value],
  );
  const cursorHighlighted = commandRanges.some(
    (range) => visible.cursorIndex >= range.start && visible.cursorIndex < range.end,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={active ? (mode === "answer" ? "yellow" : "magenta") : "gray"}
      paddingX={1}
      aria-role="textbox"
      aria-state={{ disabled }}
    >
      <Box>
        <Text color={active ? (mode === "answer" ? "yellow" : "magenta") : "gray"} bold>
          {prompt}{" "}
        </Text>
        {active && value.length > 0 ? (
          <Text wrap="truncate-end">
            {visible.hiddenBefore ? "…" : ""}
            {highlightedText(visible.before, visible.start, commandRanges)}
            <Text inverse color={cursorHighlighted ? "cyan" : undefined} bold={cursorHighlighted}>
              {visible.cursor}
            </Text>
            {highlightedText(visible.after, visible.cursorIndex + 1, commandRanges)}
            {visible.hiddenAfter ? "…" : ""}
          </Text>
        ) : active ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor> {hint}</Text>
          </Text>
        ) : (
          <Text dimColor>{hint}</Text>
        )}
        {disabled ? <Text color="yellow"> busy</Text> : null}
      </Box>
      {commandSuggestions.length > 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>tab complete · </Text>
          <Text color="cyan">
            {commandSuggestions.map((command) => `/${command.name}`).join("  ")}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const Composer = memo(ComposerComponent);
