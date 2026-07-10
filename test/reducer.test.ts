import { describe, expect, it } from "vitest";

import {
  createInitialDashboardState,
  createSessionRecord,
  dashboardReducer,
  reduceRpcMessage,
} from "../src/domain/reducer.js";
import {
  formatRelativeTime,
  getSessionGroup,
  getSessionSummary,
  getSessionTitle,
  isSubagentThread,
  reconcileSelection,
  selectGroupedSessions,
  selectOrderedSessions,
  selectSessionCounts,
  subagentParentId,
  subagentRootId,
  truncateSummary,
} from "../src/domain/selectors.js";
import {
  DEFAULT_PREFERENCES,
  type CodexThread,
  type DashboardState,
  type Preferences,
  type RpcInboundMessage,
  type SessionRecord,
  type ThreadItem,
  type Turn,
} from "../src/domain/types.js";

const BASE_TIME = 1_800_000_000_000;

function thread(
  id: string,
  overrides: Partial<CodexThread> = {},
): CodexThread {
  return {
    id,
    preview: `Task ${id}`,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    status: { type: "idle" },
    cwd: "/projects/one",
    turns: [],
    ...overrides,
  };
}

function addThread(state: DashboardState, value: CodexThread, at = BASE_TIME): DashboardState {
  return dashboardReducer(state, { type: "thread/upsert", thread: value, at });
}

function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return {
    ...DEFAULT_PREFERENCES,
    pinnedThreadIds: [],
    order: [],
    ...overrides,
  };
}

describe("dashboardReducer", () => {
  it("creates records from historical threads and derives their latest answer", () => {
    const turns: Turn[] = [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "user", type: "userMessage", content: [{ type: "text", text: "hello" }] },
          { id: "agent", type: "agentMessage", text: "  Done.\nEverything works. " },
        ],
      },
    ];

    const record = createSessionRecord(thread("a", { turns }));

    expect(record.turns).toHaveLength(1);
    expect(record.latestText).toBe("Done. Everything works.");
    expect(record.activity).toBe("Done. Everything works.");
    expect(record.lastChangedAt).toBe(1_700_000_100_000);
  });

  it("does not erase loaded turns when a live thread payload has no turns", () => {
    const historical = thread("a", {
      name: "Original",
      turns: [{ id: "turn-1", status: "completed", items: [{ id: "a", type: "agentMessage", text: "answer" }] }],
    });
    let state = addThread(createInitialDashboardState(), historical);

    state = addThread(state, thread("a", { name: "Renamed", turns: [] }), BASE_TIME + 1_000);

    expect(state.sessions.a?.thread.name).toBe("Renamed");
    expect(state.sessions.a?.turns[0]?.items[0]?.text).toBe("answer");
  });

  it("uses hydrated snapshot order when live events arrived first", () => {
    let state = addThread(createInitialDashboardState(), thread("a"));
    state = dashboardReducer(state, {
      type: "turn/started",
      threadId: "a",
      turn: {
        id: "turn-current",
        status: "inProgress",
        items: [{ id: "current", type: "agentMessage", text: "Streaming" }],
      },
    });

    state = addThread(state, thread("a", {
      turns: [
        {
          id: "turn-old",
          status: "completed",
          items: [{ id: "old", type: "agentMessage", text: "Earlier" }],
        },
        {
          id: "turn-current",
          status: "inProgress",
          items: [
            { id: "user", type: "userMessage", content: [{ type: "text", text: "Now" }] },
            { id: "current", type: "agentMessage", text: "Streaming now" },
          ],
        },
      ],
    }));

    expect(state.sessions.a?.turns.map((turn) => turn.id)).toEqual([
      "turn-old",
      "turn-current",
    ]);
    expect(state.sessions.a?.turns[1]?.items.map((item) => item.id)).toEqual([
      "user",
      "current",
    ]);
  });

  it("does not let an older list snapshot overwrite a newer live status", () => {
    let state = addThread(createInitialDashboardState(), thread("a"), BASE_TIME);
    state = dashboardReducer(state, {
      type: "thread/status",
      threadId: "a",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
      at: BASE_TIME + 10_000,
    });
    state = dashboardReducer(state, {
      type: "thread/list",
      threads: [thread("a", { status: { type: "notLoaded" } })],
    });

    expect(state.sessions.a?.thread.status).toEqual({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    });
    expect(state.sessions.a?.lastChangedAt).toBe(BASE_TIME + 10_000);
  });

  it("streams item text through a turn and completes it", () => {
    let state = addThread(createInitialDashboardState(), thread("a"));
    state = dashboardReducer(state, {
      type: "turn/started",
      threadId: "a",
      turn: { id: "turn-1", status: "inProgress", items: [] },
      at: BASE_TIME + 1_000,
    });
    state = dashboardReducer(state, {
      type: "item/started",
      threadId: "a",
      turnId: "turn-1",
      item: { id: "message", type: "agentMessage", text: "Hel" },
      at: BASE_TIME + 2_000,
    });
    state = dashboardReducer(state, {
      type: "item/delta",
      threadId: "a",
      turnId: "turn-1",
      itemId: "message",
      delta: "lo world",
      at: BASE_TIME + 3_000,
    });

    expect(state.sessions.a?.latestText).toBe("Hello world");
    expect(state.sessions.a?.activeTurnId).toBe("turn-1");
    expect(state.sessions.a?.thread.status).toEqual({ type: "active", activeFlags: [] });

    state = dashboardReducer(state, {
      type: "turn/completed",
      threadId: "a",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ id: "message", type: "agentMessage", text: "Hello world!" }],
      },
      at: BASE_TIME + 4_000,
    });

    expect(state.sessions.a?.activeTurnId).toBeUndefined();
    expect(state.sessions.a?.latestText).toBe("Hello world!");
    expect(state.sessions.a?.thread.status).toEqual({ type: "idle" });
    expect(state.sessions.a?.turns[0]?.items).toHaveLength(1);
  });

  it("recovers live reasoning, file patches, and errors before item hydration", () => {
    let state = addThread(createInitialDashboardState(), thread("a"));
    const messages: RpcInboundMessage[] = [
      {
        method: "item/reasoning/summaryPartAdded",
        params: { threadId: "a", turnId: "turn", itemId: "reason", summaryIndex: 0 },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "a",
          turnId: "turn",
          itemId: "reason",
          summaryIndex: 0,
          delta: "Inspecting state",
        },
      },
      {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "a",
          turnId: "turn",
          itemId: "patch",
          changes: [{ path: "src/app.ts", kind: "update", diff: "+fixed" }],
        },
      },
      {
        method: "error",
        params: {
          threadId: "a",
          turnId: "turn",
          error: { message: "temporary failure" },
          willRetry: true,
        },
      },
    ];
    for (const message of messages) {
      state = reduceRpcMessage(state, message, BASE_TIME + 1_000);
    }

    const turn = state.sessions.a?.turns[0];
    expect(turn?.items[0]).toMatchObject({
      id: "reason",
      type: "reasoning",
      summary: ["Inspecting state"],
    });
    expect(turn?.items[1]).toMatchObject({
      id: "patch",
      type: "fileChange",
      changes: [{ path: "src/app.ts" }],
    });
    expect(turn?.error?.message).toBe("temporary failure");
    expect(state.sessions.a?.activity).toContain("Retrying after error");
  });

  it("handles events that arrive before the thread is loaded", () => {
    const state = dashboardReducer(createInitialDashboardState(), {
      type: "turn/started",
      threadId: "unknown",
      turn: { id: "turn", status: "inProgress", items: [] },
      at: BASE_TIME,
    });

    expect(state.sessions.unknown?.thread.id).toBe("unknown");
    expect(state.sessions.unknown?.thread.status.type).toBe("active");
    expect(state.sessions.unknown?.activeTurnId).toBe("turn");
  });

  it("reduces raw status, name, plan, diff, and archive notifications", () => {
    let state = addThread(createInitialDashboardState(), thread("a"));
    state = reduceRpcMessage(state, {
      method: "thread/name/updated",
      params: { threadId: "a", threadName: "New name" },
    }, BASE_TIME + 1_000);
    state = reduceRpcMessage(state, {
      method: "thread/status/changed",
      params: {
        threadId: "a",
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
      },
    }, BASE_TIME + 2_000);
    state = reduceRpcMessage(state, {
      method: "turn/plan/updated",
      params: {
        threadId: "a",
        turnId: "turn",
        explanation: null,
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
        ],
      },
    }, BASE_TIME + 3_000);
    state = reduceRpcMessage(state, {
      method: "turn/diff/updated",
      params: { threadId: "a", turnId: "turn", diff: "+added" },
    }, BASE_TIME + 4_000);

    expect(state.sessions.a?.thread.name).toBe("New name");
    expect(state.sessions.a?.thread.status).toEqual({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    });
    expect(state.sessions.a?.plan[1]).toEqual({ step: "Implement", status: "inProgress" });
    expect(state.sessions.a?.activity).toBe("Implement");
    expect(state.sessions.a?.diff).toBe("+added");

    state = reduceRpcMessage(state, { method: "thread/archived", params: { threadId: "a" } });
    expect(state.sessions.a).toBeUndefined();
  });

  it("keeps closed threads as unloaded rows", () => {
    let state = addThread(createInitialDashboardState(), thread("a", {
      status: { type: "active", activeFlags: [] },
    }));
    state = reduceRpcMessage(state, {
      method: "thread/closed",
      params: { threadId: "a" },
    }, BASE_TIME);

    expect(state.sessions.a?.thread.status).toEqual({ type: "notLoaded" });
  });

  it("tracks raw server requests, replaces duplicate ids, and resolves them", () => {
    let state = addThread(createInitialDashboardState(), thread("a"));
    const approval = {
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "a",
        turnId: "turn",
        itemId: "item",
        command: "npm test",
      },
    } satisfies RpcInboundMessage;
    state = reduceRpcMessage(state, approval, BASE_TIME + 1_000);
    state = reduceRpcMessage(state, {
      ...approval,
      params: { ...approval.params, command: "npm run check" },
    }, BASE_TIME + 2_000);

    expect(state.sessions.a?.pendingRequests).toHaveLength(1);
    expect(state.sessions.a?.pendingRequests[0]?.params.command).toBe("npm run check");
    expect(state.sessions.a?.activity).toBe("Approve: npm run check");
    expect(state.sessions.a?.thread.status).toEqual({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    });

    state = reduceRpcMessage(state, {
      method: "serverRequest/resolved",
      params: { threadId: "a", requestId: 41 },
    }, BASE_TIME + 3_000);
    expect(state.sessions.a?.pendingRequests).toEqual([]);
    expect(state.sessions.a?.thread.status).toEqual({ type: "active", activeFlags: [] });
    expect(state.sessions.a?.activity).toBe("Working…");
  });

  it("uses question text and the input flag for user-input requests", () => {
    let state = addThread(createInitialDashboardState(), thread("a"));
    state = reduceRpcMessage(state, {
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "a",
        turnId: "turn",
        itemId: "item",
        questions: [{ question: "Which database should we use?" }],
      },
    }, BASE_TIME);

    expect(state.sessions.a?.activity).toBe("Which database should we use?");
    expect(state.sessions.a?.thread.status).toEqual({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    });
  });

  it("ignores responses and irrelevant global requests", () => {
    const state = addThread(createInitialDashboardState(), thread("a"));
    expect(reduceRpcMessage(state, { id: 1, result: {} })).toBe(state);
    expect(reduceRpcMessage(state, {
      id: 2,
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    })).toBe(state);
  });

  it("updates connection state and clears stale errors after reconnect", () => {
    let state = dashboardReducer(createInitialDashboardState(), {
      type: "connection/changed",
      connection: "error",
      error: "socket closed",
    });
    expect(state.connectionError).toBe("socket closed");
    state = dashboardReducer(state, { type: "connection/changed", connection: "connected" });
    expect(state).toMatchObject({ connection: "connected", connectionError: undefined });
  });
});

describe("session selectors", () => {
  function record(
    id: string,
    status: CodexThread["status"],
    at: number,
    cwd = "/projects/one",
  ): SessionRecord {
    return {
      ...createSessionRecord(thread(id, { status, cwd })),
      lastChangedAt: at,
    };
  }

  it("identifies every App Server subagent source shape", () => {
    expect(isSubagentThread(thread("parent-id", { parentThreadId: "root" }))).toBe(true);
    expect(isSubagentThread(thread("thread-source", { threadSource: "subagent" }))).toBe(true);
    expect(isSubagentThread(thread("session-source", { source: { subAgent: {} } }))).toBe(true);
    expect(isSubagentThread(thread("legacy-source", { source: { subagent: {} } }))).toBe(true);
    expect(isSubagentThread(thread("root", { source: "appServer", threadSource: "user" }))).toBe(
      false,
    );
    const nested = thread("nested", {
      sessionId: "root",
      source: { subagent: { thread_spawn: { parent_thread_id: "child" } } },
      threadSource: "subagent",
    });
    const child = thread("child", { parentThreadId: "root", threadSource: "subagent" });
    expect(subagentParentId(nested)).toBe("child");
    expect(subagentRootId(nested, new Map([["child", child]]))).toBe("root");
  });

  it("assigns groups with pinned and needs-input precedence", () => {
    const preferences = prefs({ pinnedThreadIds: ["pinned"] });
    const pinned = record("pinned", { type: "active", activeFlags: ["waitingOnApproval"] }, BASE_TIME);
    const input = record("input", { type: "active", activeFlags: ["waitingOnUserInput"] }, BASE_TIME);
    const working = record("working", { type: "active", activeFlags: [] }, BASE_TIME);
    const completed = record("completed", { type: "idle" }, BASE_TIME);
    const stale = record("stale", { type: "notLoaded" }, BASE_TIME);

    expect(getSessionGroup(pinned, preferences)).toBe("pinned");
    expect(getSessionGroup(input, preferences)).toBe("needsInput");
    expect(getSessionGroup(working, preferences)).toBe("working");
    expect(getSessionGroup(completed, preferences)).toBe("completed");
    expect(getSessionGroup(stale, preferences)).toBe("stale");
  });

  it("groups, filters by cwd, and orders deterministically", () => {
    const state: DashboardState = {
      connection: "connected",
      sessions: {
        old: record("old", { type: "idle" }, BASE_TIME - 10_000),
        new: record("new", { type: "idle" }, BASE_TIME),
        working: record("working", { type: "active", activeFlags: [] }, BASE_TIME - 5_000),
        hidden: record("hidden", { type: "idle" }, BASE_TIME + 1_000, "/projects/two"),
      },
    };
    const preferences = prefs({
      defaultCwd: "/projects/one/",
      order: ["old", "new"],
    });

    const grouped = selectGroupedSessions(state, preferences);
    expect(grouped.working.map((session) => session.thread.id)).toEqual(["working"]);
    expect(grouped.completed.map((session) => session.thread.id)).toEqual(["old", "new"]);
    expect(selectOrderedSessions(state, preferences).map((session) => session.thread.id)).toEqual([
      "working",
      "old",
      "new",
    ]);
    expect(selectSessionCounts(state, preferences)).toEqual({
      pinned: 0,
      needsInput: 0,
      working: 1,
      completed: 2,
      stale: 0,
    });
  });

  it("keeps selection stable and picks a fallback when absent", () => {
    const a = record("a", { type: "idle" }, BASE_TIME);
    const b = record("b", { type: "idle" }, BASE_TIME - 1);
    const c = record("c", { type: "idle" }, BASE_TIME - 2);

    expect(reconcileSelection("b", [c, b, a], ["a", "b", "c"])).toBe("b");
    expect(reconcileSelection("b", [a, c], ["a", "b", "c"])).toBe("c");
    expect(reconcileSelection("missing", [a, c])).toBe("a");
    expect(reconcileSelection(undefined, [a, c])).toBe("a");
    expect(reconcileSelection("a", [])).toBeUndefined();
  });

  it("builds compact summaries and titles", () => {
    const session = {
      ...record("a", { type: "active", activeFlags: [] }, BASE_TIME),
      thread: { ...thread("a"), name: "Named task" },
      activity: "  Running\n tests  ",
    };
    expect(getSessionTitle(session)).toBe("Named task");
    expect(getSessionSummary(session)).toBe("Running tests");
    expect(truncateSummary("abcdefgh", 5)).toBe("abcd…");
    expect(truncateSummary("anything", 1)).toBe("…");
  });

  it("prioritizes pending questions and in-progress plan steps in summaries", () => {
    const base = record("a", { type: "active", activeFlags: [] }, BASE_TIME);
    const planned = { ...base, plan: [{ step: "Write tests", status: "inProgress" }] };
    expect(getSessionSummary(planned)).toBe("Write tests");

    const waiting: SessionRecord = {
      ...planned,
      pendingRequests: [{
        id: 1,
        method: "item/tool/requestUserInput",
        threadId: "a",
        params: { questions: [{ question: "Choose one" }] },
      }],
    };
    expect(getSessionSummary(waiting)).toBe("Choose one");
  });

  it("formats seconds- or milliseconds-based relative timestamps", () => {
    const now = 1_800_000_000_000;
    expect(formatRelativeTime(now, now)).toBe("now");
    expect(formatRelativeTime(now - 15_000, now)).toBe("15s");
    expect(formatRelativeTime((now - 15 * 60_000) / 1_000, now)).toBe("15m");
    expect(formatRelativeTime(now - 9 * 3_600_000, now)).toBe("9h");
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe("5d");
    expect(formatRelativeTime(now + 2 * 60_000, now)).toBe("in 2m");
    expect(formatRelativeTime(Number.NaN, now)).toBe("—");
  });
});
