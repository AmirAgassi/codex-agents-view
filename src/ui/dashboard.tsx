import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { reconcileSelection } from "../domain/selectors.js";
import type { PendingRequest } from "../domain/types.js";
import { Composer, type ComposerMode } from "./composer.js";
import { Footer } from "./footer.js";
import { Header } from "./header.js";
import { HelpOverlay } from "./help-overlay.js";
import { buildDashboardModel } from "./model.js";
import { PeekPanel } from "./peek-panel.js";
import { RequestPanel } from "./request-panel.js";
import { SessionList } from "./session-list.js";
import {
  isApprovalRequest,
  parseQuestions,
  requestScopeDetails,
  sessionName,
} from "./format.js";
import type {
  DashboardProps,
  ParsedQuestion,
  UserInputAnswer,
} from "./types.js";

interface ComposerState {
  active: boolean;
  mode: ComposerMode;
  value: string;
  cursor: number;
  targetId?: string;
}

interface AnswerFlow {
  request: PendingRequest;
  questions: ParsedQuestion[];
  questionIndex: number;
  answers: Record<string, UserInputAnswer>;
}

const EMPTY_COMPOSER: ComposerState = {
  active: false,
  mode: "new",
  value: "",
  cursor: 0,
};
const INPUT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function replaceComposerText(
  composer: ComposerState,
  characters: string[],
  cursor: number,
): ComposerState {
  return { ...composer, value: characters.join(""), cursor };
}

function insertText(composer: ComposerState, input: string): ComposerState {
  const characters = Array.from(composer.value);
  const inserted = Array.from(
    input.replace(/[\r\n\t]+/g, " ").replace(INPUT_CONTROL, ""),
  );
  characters.splice(composer.cursor, 0, ...inserted);
  return replaceComposerText(composer, characters, composer.cursor + inserted.length);
}

function deleteBackward(composer: ComposerState): ComposerState {
  if (composer.cursor === 0) return composer;
  const characters = Array.from(composer.value);
  characters.splice(composer.cursor - 1, 1);
  return replaceComposerText(composer, characters, composer.cursor - 1);
}

function deleteForward(composer: ComposerState): ComposerState {
  const characters = Array.from(composer.value);
  if (composer.cursor >= characters.length) return composer;
  characters.splice(composer.cursor, 1);
  return replaceComposerText(composer, characters, composer.cursor);
}

function deleteWordBackward(composer: ComposerState): ComposerState {
  if (composer.cursor === 0) return composer;
  const characters = Array.from(composer.value);
  let start = composer.cursor;
  while (start > 0 && /\s/.test(characters[start - 1] ?? "")) start -= 1;
  while (start > 0 && !/\s/.test(characters[start - 1] ?? "")) start -= 1;
  characters.splice(start, composer.cursor - start);
  return replaceComposerText(composer, characters, start);
}

function moveCursor(composer: ComposerState, cursor: number): ComposerState {
  return {
    ...composer,
    cursor: Math.max(0, Math.min(Array.from(composer.value).length, cursor)),
  };
}

function requestKey(request: PendingRequest): string {
  return `${request.threadId}:${String(request.id)}`;
}

export function Dashboard({
  state,
  preferences,
  initialSelectedThreadId,
  title = "Codex Agents View",
  version,
  model,
  cwd,
  statusMessage,
  isBusy = false,
  onDispatch,
  onSteer,
  onResolveRequest,
  onInterrupt,
  onRename,
  onArchive,
  onPinToggle,
  onAttach,
  onRefresh,
  onExit,
  onSelectionChange,
}: DashboardProps): React.JSX.Element {
  const { columns, rows } = useWindowSize();
  const terminalWidth = columns;
  const terminalHeight = rows;
  const dashboardModel = useMemo(
    () => buildDashboardModel(state, preferences),
    [state, preferences],
  );
  const [selection, setSelection] = useState<string | undefined>(initialSelectedThreadId);
  const previousItemIds = useRef<string[]>([]);
  const [peekedId, setPeekedId] = useState<string>();
  const [helpVisible, setHelpVisible] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [answerFlow, setAnswerFlow] = useState<AnswerFlow>();

  const currentItemIds = useMemo(
    () => dashboardModel.items.map((item) => item.id),
    [dashboardModel.items],
  );
  const selectedId = reconcileSelection(
    selection,
    dashboardModel.items.map((item) => item.record),
    previousItemIds.current,
  );
  const selectedIndex = dashboardModel.items.findIndex((item) => item.id === selectedId);
  const selected = selectedId ? state.sessions[selectedId] : undefined;
  const selectedRequest = selected?.pendingRequests[0];
  const currentQuestion = answerFlow?.questions[answerFlow.questionIndex];
  const detailRows = selectedRequest
    ? isApprovalRequest(selectedRequest)
      ? 8 + requestScopeDetails(selectedRequest).length
      : 5 + Math.min(5, parseQuestions(selectedRequest)[0]?.options.length ?? 0)
    : peekedId === selectedId ? 8 : 0;
  const chromeRows = 9;
  const listRows = Math.max(3, terminalHeight - chromeRows - detailRows);
  const displayCwd =
    cwd ?? preferences.defaultCwd ?? selected?.thread.cwd ?? process.cwd();

  useEffect(() => {
    if (currentItemIds.length === 0) return;
    previousItemIds.current = currentItemIds;
    if (selectedId !== selection) setSelection(selectedId);
  }, [currentItemIds, selectedId, selection]);

  const chooseIndex = (nextIndex: number): void => {
    if (dashboardModel.items.length === 0) return;
    const bounded = Math.max(0, Math.min(dashboardModel.items.length - 1, nextIndex));
    const next = dashboardModel.items[bounded];
    if (!next) return;
    setSelection(next.id);
    setPeekedId(undefined);
  };

  const closeComposer = (): void => {
    setComposer(EMPTY_COMPOSER);
    setAnswerFlow(undefined);
  };

  const beginComposer = (
    mode: ComposerMode,
    targetId?: string,
    flow?: AnswerFlow,
    initialValue = "",
  ): void => {
    setHelpVisible(false);
    setPeekedId(undefined);
    setComposer({
      active: true,
      mode,
      value: initialValue,
      cursor: Array.from(initialValue).length,
      targetId,
    });
    setAnswerFlow(flow);
  };

  const advanceAnswer = (answer: string): void => {
    if (!answerFlow) return;
    const question = answerFlow.questions[answerFlow.questionIndex];
    if (!question) return;
    const answers = {
      ...answerFlow.answers,
      [question.id]: { answers: [answer] },
    };
    const nextIndex = answerFlow.questionIndex + 1;

    if (nextIndex < answerFlow.questions.length) {
      setAnswerFlow({ ...answerFlow, questionIndex: nextIndex, answers });
      setComposer((current) => ({ ...current, value: "", cursor: 0 }));
      return;
    }

    onResolveRequest?.(answerFlow.request, { kind: "userInput", answers });
    closeComposer();
  };

  const submitComposer = (): void => {
    if (isBusy) return;
    const value = composer.value.trim();
    if (!value) return;

    if (composer.mode === "answer") {
      advanceAnswer(value);
      return;
    }
    if (composer.mode === "reply" && composer.targetId) {
      onSteer?.(composer.targetId, value);
    } else if (composer.mode === "rename" && composer.targetId) {
      onRename?.(composer.targetId, value);
    } else if (composer.mode === "new") {
      void onDispatch?.(value, cwd ?? preferences.defaultCwd);
    }
    closeComposer();
  };

  const resolveDecision = (
    request: PendingRequest,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ): void => {
    onResolveRequest?.(request, { kind: "approval", decision });
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit?.();
      return;
    }

    if (helpVisible) {
      if (key.escape || input === "?" || input === "q") setHelpVisible(false);
      return;
    }

    if (composer.active) {
      if (key.escape) {
        closeComposer();
        return;
      }
      if (
        composer.mode === "new" &&
        composer.value.length === 0 &&
        (key.leftArrow || key.rightArrow || key.return) &&
        selectedId
      ) {
        if (isBusy) return;
        closeComposer();
        onAttach?.(selectedId);
        return;
      }
      if (key.return) {
        submitComposer();
        return;
      }
      if (
        composer.mode === "answer" &&
        composer.value.length === 0 &&
        /^[1-9]$/.test(input)
      ) {
        const option = currentQuestion?.options[Number(input) - 1];
        if (option) {
          advanceAnswer(option.label);
          return;
        }
      }
      if (key.leftArrow) {
        setComposer((current) => moveCursor(current, current.cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setComposer((current) => moveCursor(current, current.cursor + 1));
        return;
      }
      if (key.home || (key.ctrl && input === "a")) {
        setComposer((current) => moveCursor(current, 0));
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setComposer((current) => moveCursor(current, Array.from(current.value).length));
        return;
      }
      if (key.backspace && (key.ctrl || key.meta)) {
        setComposer(deleteWordBackward);
        return;
      }
      if (key.backspace) {
        setComposer(deleteBackward);
        return;
      }
      if (key.delete) {
        setComposer(deleteForward);
        return;
      }
      if (key.ctrl && input === "u") {
        setComposer((current) => replaceComposerText(current, [], 0));
        return;
      }
      if (key.ctrl && input === "w") {
        setComposer(deleteWordBackward);
        return;
      }
      if (
        input === "/" &&
        composer.mode === "new" &&
        composer.value.length === 0 &&
        selectedId
      ) {
        if (isBusy) return;
        closeComposer();
        onAttach?.(selectedId, "/");
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.super) {
        setComposer((current) => insertText(current, input));
      }
      return;
    }

    if (key.meta && input === "q") {
      onExit?.();
      return;
    }
    if (key.meta && input === "?") {
      setHelpVisible(true);
      return;
    }
    if (key.downArrow) {
      chooseIndex(selectedIndex + 1);
      return;
    }
    if (key.upArrow) {
      chooseIndex(selectedIndex - 1);
      return;
    }
    if (key.pageDown) {
      chooseIndex(selectedIndex + Math.max(1, listRows - 2));
      return;
    }
    if (key.pageUp) {
      chooseIndex(selectedIndex - Math.max(1, listRows - 2));
      return;
    }
    if (key.home) {
      chooseIndex(0);
      return;
    }
    if (key.end) {
      chooseIndex(dashboardModel.items.length - 1);
      return;
    }
    if ((key.return || key.leftArrow || key.rightArrow) && selectedId) {
      if (isBusy) return;
      onAttach?.(selectedId);
      return;
    }
    if (isBusy) return;
    if (input === "/" && selectedId && !key.ctrl && !key.meta && !key.super) {
      onAttach?.(selectedId, "/");
      return;
    }
    if (key.meta && input === "v" && selectedId) {
      const opening = peekedId !== selectedId;
      setPeekedId(opening ? selectedId : undefined);
      if (opening) onSelectionChange?.(selected);
      return;
    }
    if (input === " " && selectedId) {
      if (selectedRequest) {
        const questions = parseQuestions(selectedRequest);
        if (questions.length > 0) {
          beginComposer("answer", selectedId, {
            request: selectedRequest,
            questions,
            questionIndex: 0,
            answers: {},
          });
          return;
        }
      }
      beginComposer("reply", selectedId);
      return;
    }
    if (key.meta && input === "p" && selectedId) {
      onPinToggle?.(selectedId, !preferences.pinnedThreadIds.includes(selectedId));
      return;
    }
    if (key.meta && input === "e" && selectedId && selected) {
      beginComposer("rename", selectedId, undefined, sessionName(selected));
      return;
    }
    if (key.meta && input === "z" && selectedId) {
      onArchive?.(selectedId);
      return;
    }
    if (key.meta && input === "x" && selectedId) {
      onInterrupt?.(selectedId);
      return;
    }
    if (key.meta && input === "o" && selectedId) {
      onAttach?.(selectedId);
      return;
    }
    if (key.meta && input === "r") {
      onRefresh?.();
      return;
    }

    if (selectedRequest && key.meta) {
      const approval = isApprovalRequest(selectedRequest);
      const hasQuestions = parseQuestions(selectedRequest).length > 0;
      if (approval && input === "a") {
        resolveDecision(selectedRequest, "accept");
        return;
      }
      if (approval && input === "s") {
        resolveDecision(selectedRequest, "acceptForSession");
        return;
      }
      if (!hasQuestions && input === "d") {
        resolveDecision(selectedRequest, "decline");
        return;
      }
      if (!hasQuestions && input === "c") {
        resolveDecision(selectedRequest, "cancel");
        return;
      }
    }

    if (input && !key.ctrl && !key.meta && !key.super) {
      beginComposer("new", undefined, undefined, input);
    }
  });

  if (terminalWidth < 50 || terminalHeight < 14) {
    return (
      <Box width={terminalWidth} height={terminalHeight} alignItems="center" justifyContent="center">
        <Text color="yellow">Terminal too small · resize to at least 50×14 · ctrl+c quits</Text>
      </Box>
    );
  }

  return (
    <Box width={terminalWidth} height={terminalHeight} flexDirection="column">
      <Header
        title={title}
        version={version}
        model={model}
        cwd={displayCwd}
        counts={dashboardModel.counts}
        connection={state.connection}
      />

      {helpVisible ? (
        <HelpOverlay width={terminalWidth} height={terminalHeight} />
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <SessionList
            sections={dashboardModel.sections}
            items={dashboardModel.items}
            selectedId={selectedId}
            maxRows={listRows}
            width={terminalWidth}
          />
          {selectedRequest ? (
            <RequestPanel
              request={selectedRequest}
              questionIndex={
                answerFlow && requestKey(answerFlow.request) === requestKey(selectedRequest)
                  ? answerFlow.questionIndex
                  : 0
              }
            />
          ) : peekedId === selectedId && selected ? (
            <PeekPanel session={selected} />
          ) : null}
        </Box>
      )}

      <Composer
        active={composer.active}
        mode={composer.mode}
        value={composer.value}
        cursor={composer.cursor}
        width={terminalWidth}
        targetName={selected ? sessionName(selected) : undefined}
        questionLabel={currentQuestion?.question}
        secret={composer.mode === "answer" && currentQuestion?.isSecret === true}
        disabled={isBusy}
      />
      <Footer
        connection={state.connection}
        connectionError={state.connectionError}
        message={statusMessage}
        composerActive={composer.active}
        hasSelection={selected !== undefined}
        hasPendingRequest={selectedRequest !== undefined}
      />
    </Box>
  );
}
