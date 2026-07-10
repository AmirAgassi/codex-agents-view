import type {
  CodexThread,
  DashboardState,
  Preferences,
  SessionGroup,
  SessionRecord,
} from "./types.js";

export const SESSION_GROUP_ORDER: readonly SessionGroup[] = [
  "pinned",
  "needsInput",
  "working",
  "completed",
  "stale",
];

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizedSourceKind(value: string): string {
  return value.toLowerCase().replace(/[_-]/gu, "");
}

function sourceIsSubagent(source: unknown): boolean {
  if (typeof source === "string") return normalizedSourceKind(source) === "subagent";
  if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
  return Object.keys(source).some((key) => normalizedSourceKind(key) === "subagent");
}

function parentIdFromSource(source: unknown, depth = 0): string | undefined {
  if (depth > 4 || source === null || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(source)) {
    if (normalizedSourceKind(key) === "parentthreadid" && typeof value === "string") return value;
    const nested = parentIdFromSource(value, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export function isSubagentThread(thread: CodexThread): boolean {
  if (thread.parentThreadId) return true;
  if (thread.threadSource && normalizedSourceKind(thread.threadSource) === "subagent") return true;
  return sourceIsSubagent(thread.source);
}

export function subagentParentId(thread: CodexThread): string | undefined {
  if (!isSubagentThread(thread)) return undefined;
  if (thread.parentThreadId) return thread.parentThreadId;
  const sourceParentId = parentIdFromSource(thread.source);
  if (sourceParentId) return sourceParentId;
  if (thread.sessionId && thread.sessionId !== thread.id) return thread.sessionId;
  if (thread.forkedFromId) return thread.forkedFromId;
  return undefined;
}

export function subagentRootId(
  thread: CodexThread,
  threadsById: ReadonlyMap<string, CodexThread>,
): string | undefined {
  let parentId = subagentParentId(thread);
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = threadsById.get(parentId);
    if (!parent || !isSubagentThread(parent)) return parentId;
    parentId = subagentParentId(parent);
  }
  return undefined;
}

export function truncateSummary(value: string, maxLength = 100): string {
  const text = normalizedText(value);
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function sessionNeedsInput(session: SessionRecord): boolean {
  if (session.pendingRequests.length > 0) return true;
  return session.thread.status.type === "active" && session.thread.status.activeFlags.some(
    (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
  );
}

export function sessionIsWorking(session: SessionRecord): boolean {
  if (sessionNeedsInput(session)) return false;
  if (session.thread.status.type === "active") return true;
  if (session.activeTurnId !== undefined) return true;
  return session.turns.some((turn) => turn.status === "inProgress");
}

export function getSessionGroup(session: SessionRecord, preferences: Preferences): SessionGroup {
  if (preferences.pinnedThreadIds.includes(session.thread.id)) return "pinned";
  if (session.thread.status.type === "notLoaded") return "stale";
  if (sessionNeedsInput(session)) return "needsInput";
  if (sessionIsWorking(session)) return "working";
  return "completed";
}

function lastRequestSummary(session: SessionRecord): string {
  const request = session.pendingRequests.at(-1);
  if (request === undefined) return "";
  if (request.method === "item/tool/requestUserInput" && Array.isArray(request.params.questions)) {
    const question = request.params.questions[0];
    if (typeof question === "object" && question !== null && "question" in question) {
      const text = (question as { question?: unknown }).question;
      if (typeof text === "string") return text;
    }
  }
  if (typeof request.params.reason === "string") return request.params.reason;
  if (typeof request.params.command === "string") return `Approve: ${request.params.command}`;
  return request.method === "item/tool/requestUserInput"
    ? "Waiting for your input"
    : "Waiting for approval";
}

export function getSessionSummary(session: SessionRecord, maxLength = 100): string {
  const pending = lastRequestSummary(session);
  const currentPlan = session.plan.find((step) => step.status === "inProgress")?.step;
  const latestTurn = session.turns.at(-1);
  const failed = latestTurn?.status === "failed" ? latestTurn.error?.message : undefined;
  const value = pending || currentPlan || failed || (
    sessionIsWorking(session)
      ? session.activity || session.latestText
      : session.latestText || session.activity
  ) || session.thread.preview;
  return truncateSummary(value, maxLength);
}

export function getSessionTitle(session: SessionRecord, maxLength = 60): string {
  const cwdName = session.thread.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  const value = [
    session.thread.name,
    session.thread.preview,
    session.thread.agentNickname,
    cwdName,
    session.thread.id,
  ].find((candidate): candidate is string =>
    typeof candidate === "string" && normalizedText(candidate) !== ""
  ) ?? session.thread.id;
  return truncateSummary(value, maxLength);
}

export function toEpochMilliseconds(timestamp: number): number {
  return Math.abs(timestamp) < 100_000_000_000 ? timestamp * 1_000 : timestamp;
}

export function getSessionTimestamp(session: SessionRecord): number {
  if (Number.isFinite(session.lastChangedAt) && session.lastChangedAt > 0) {
    return toEpochMilliseconds(session.lastChangedAt);
  }
  return toEpochMilliseconds(
    session.thread.recencyAt ?? session.thread.updatedAt ?? session.thread.createdAt,
  );
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return "—";
  const deltaMilliseconds = now - toEpochMilliseconds(timestamp);
  const future = deltaMilliseconds < -1_000;
  const seconds = Math.floor(Math.abs(deltaMilliseconds) / 1_000);

  let value: string;
  if (seconds < 5) value = "now";
  else if (seconds < 60) value = `${seconds}s`;
  else if (seconds < 3_600) value = `${Math.floor(seconds / 60)}m`;
  else if (seconds < 86_400) value = `${Math.floor(seconds / 3_600)}h`;
  else if (seconds < 604_800) value = `${Math.floor(seconds / 86_400)}d`;
  else if (seconds < 2_592_000) value = `${Math.floor(seconds / 604_800)}w`;
  else if (seconds < 31_536_000) value = `${Math.floor(seconds / 2_592_000)}mo`;
  else value = `${Math.floor(seconds / 31_536_000)}y`;

  return future && value !== "now" ? `in ${value}` : value;
}

function normalizedPath(value: string): string {
  if (value === "/") return value;
  return value.replace(/[\\/]+$/u, "");
}

export function sessionIsVisible(session: SessionRecord, preferences: Preferences): boolean {
  if (preferences.showAllProjects || preferences.defaultCwd === undefined) return true;
  return normalizedPath(session.thread.cwd) === normalizedPath(preferences.defaultCwd);
}

function preferenceOrder(preferences: Preferences): Map<string, number> {
  return new Map(preferences.order.map((threadId, index) => [threadId, index]));
}

function compareWithOrder(
  left: SessionRecord,
  right: SessionRecord,
  order: ReadonlyMap<string, number>,
): number {
  const leftOrder = order.get(left.thread.id);
  const rightOrder = order.get(right.thread.id);
  if (leftOrder !== undefined || rightOrder !== undefined) {
    if (leftOrder === undefined) return -1;
    if (rightOrder === undefined) return 1;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  }
  const launchOrder = right.thread.createdAt - left.thread.createdAt;
  return launchOrder || left.thread.id.localeCompare(right.thread.id);
}

export function compareSessions(
  left: SessionRecord,
  right: SessionRecord,
  preferences: Preferences,
): number {
  return compareWithOrder(left, right, preferenceOrder(preferences));
}

export type GroupedSessions = Record<SessionGroup, SessionRecord[]>;

export function selectGroupedSessions(
  state: DashboardState,
  preferences: Preferences,
): GroupedSessions {
  const groups: GroupedSessions = {
    pinned: [],
    needsInput: [],
    working: [],
    completed: [],
    stale: [],
  };
  const order = preferenceOrder(preferences);
  for (const session of Object.values(state.sessions)) {
    if (!sessionIsVisible(session, preferences)) continue;
    groups[getSessionGroup(session, preferences)].push(session);
  }
  for (const group of SESSION_GROUP_ORDER) {
    groups[group].sort((left, right) => compareWithOrder(left, right, order));
  }
  return groups;
}

export function selectOrderedSessions(
  state: DashboardState,
  preferences: Preferences,
): SessionRecord[] {
  const groups = selectGroupedSessions(state, preferences);
  return SESSION_GROUP_ORDER.flatMap((group) => groups[group]);
}

export function selectSessionCounts(
  state: DashboardState,
  preferences: Preferences,
): Record<SessionGroup, number> {
  const groups = selectGroupedSessions(state, preferences);
  return {
    pinned: groups.pinned.length,
    needsInput: groups.needsInput.length,
    working: groups.working.length,
    completed: groups.completed.length,
    stale: groups.stale.length,
  };
}

/**
 * Keep a selected row selected across status-driven reordering. When its thread
 * disappears, choose the row now occupying its old index (or the nearest row).
 */
export function reconcileSelection(
  selectedThreadId: string | undefined,
  orderedSessions: readonly SessionRecord[],
  previousThreadIds: readonly string[] = [],
): string | undefined {
  if (orderedSessions.length === 0) return undefined;
  if (
    selectedThreadId !== undefined &&
    orderedSessions.some((session) => session.thread.id === selectedThreadId)
  ) {
    return selectedThreadId;
  }
  const previousIndex = selectedThreadId === undefined
    ? 0
    : Math.max(0, previousThreadIds.indexOf(selectedThreadId));
  return orderedSessions[Math.min(previousIndex, orderedSessions.length - 1)]?.thread.id;
}
