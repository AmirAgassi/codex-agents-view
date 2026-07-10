import React, { memo, useMemo } from "react";
import { Box, Text } from "ink";

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
    hiddenBefore: start > 0,
    hiddenAfter: end < characters.length,
  };
}

function placeholder(
  active: boolean,
  mode: ComposerMode,
  targetName: string | undefined,
  questionLabel: string | undefined,
): string {
  if (!active) return "type a task · / for native commands · space to reply";
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

  return (
    <Box
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={active ? (mode === "answer" ? "yellow" : "magenta") : "gray"}
      paddingX={1}
      aria-role="textbox"
      aria-state={{ disabled }}
    >
      <Text color={active ? (mode === "answer" ? "yellow" : "magenta") : "gray"} bold>
        {prompt}{" "}
      </Text>
      {active && value.length > 0 ? (
        <Text wrap="truncate-end">
          {visible.hiddenBefore ? "…" : ""}
          {visible.before}
          <Text inverse>{visible.cursor}</Text>
          {visible.after}
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
  );
}

export const Composer = memo(ComposerComponent);
