import type {
  DashboardState,
  PendingRequest,
  Preferences,
  SessionRecord,
} from "../domain/types.js";

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export interface UserInputAnswer {
  answers: string[];
}

export type RequestResolution =
  | { kind: "approval"; decision: ApprovalDecision }
  | { kind: "userInput"; answers: Record<string, UserInputAnswer> };

export interface DashboardStatusMessage {
  kind?: "info" | "success" | "warning" | "error";
  text: string;
}

export interface DashboardProps {
  state: DashboardState;
  preferences: Preferences;
  initialSelectedThreadId?: string;
  title?: string;
  version?: string;
  model?: string;
  cwd?: string;
  statusMessage?: DashboardStatusMessage | string;
  isBusy?: boolean;
  onDispatch?: (prompt: string, cwd?: string) => void | Promise<string | undefined>;
  onSteer?: (threadId: string, prompt: string) => void;
  onResolveRequest?: (
    request: PendingRequest,
    resolution: RequestResolution,
  ) => void;
  onInterrupt?: (threadId: string) => void;
  onRename?: (threadId: string, name: string) => void;
  onArchive?: (threadId: string) => void;
  onPinToggle?: (threadId: string, pinned: boolean) => void;
  onAttach?: (threadId: string) => void;
  onRefresh?: () => void;
  onExit?: () => void;
  onSelectionChange?: (session: SessionRecord | undefined) => void;
}

export interface ParsedQuestionOption {
  label: string;
  description?: string;
}

export interface ParsedQuestion {
  id: string;
  header?: string;
  question: string;
  isSecret: boolean;
  options: ParsedQuestionOption[];
}

export interface DashboardCounts {
  needsInput: number;
  working: number;
  completed: number;
}

export type SemanticSessionGroup =
  | "needsInput"
  | "working"
  | "completed";

export interface SessionListItem {
  id: string;
  record: SessionRecord;
  semanticGroup: SemanticSessionGroup;
  pinned: boolean;
}

export interface SessionSection {
  id: string;
  label: string;
  items: SessionListItem[];
}

export interface DashboardModel {
  counts: DashboardCounts;
  sections: SessionSection[];
  items: SessionListItem[];
}
