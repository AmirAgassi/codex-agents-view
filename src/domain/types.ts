export type JsonRpcId = number | string;

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  status?: string;
  command?: string | string[];
  cwd?: string;
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  itemsView?: "notLoaded" | "summary" | "full";
  error?: {
    message?: string;
    codexErrorInfo?: unknown | null;
    additionalDetails?: string | null;
  } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface GitInfo {
  sha?: string | null;
  branch?: string | null;
  originUrl?: string | null;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  preview: string;
  ephemeral?: boolean;
  modelProvider?: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: ThreadStatus;
  path?: string | null;
  cwd: string;
  cliVersion?: string;
  source?: unknown;
  agentNickname?: string | null;
  agentRole?: string | null;
  gitInfo?: GitInfo | null;
  name?: string | null;
  turns?: Turn[];
}

export interface RpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcServerRequest extends RpcNotification {
  id: JsonRpcId;
}

export type RpcInboundMessage = RpcResponse | RpcNotification | RpcServerRequest;

export interface PendingRequest {
  id: JsonRpcId;
  method: string;
  threadId: string;
  turnId?: string;
  params: Record<string, unknown>;
}

export interface SessionRecord {
  thread: CodexThread;
  turns: Turn[];
  activeTurnId?: string;
  latestText: string;
  activity: string;
  plan: Array<{ step: string; status: string }>;
  diff: string;
  pendingRequests: PendingRequest[];
  lastChangedAt: number;
}

export interface DashboardState {
  sessions: Record<string, SessionRecord>;
  connection: "connecting" | "connected" | "disconnected" | "error";
  connectionError?: string;
}

export type SessionGroup = "pinned" | "needsInput" | "working" | "completed" | "stale";

export interface Preferences {
  version: 1;
  pinnedThreadIds: string[];
  order: string[];
  groupBy: "state" | "cwd";
  defaultCwd?: string;
  showAllProjects: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  pinnedThreadIds: [],
  order: [],
  groupBy: "state",
  showAllProjects: false,
};
