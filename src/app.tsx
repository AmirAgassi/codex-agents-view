import { isAbsolute, relative, resolve } from "node:path";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { CliOptions } from "./cli-options.js";
import {
  CodexClient,
  prepareWorkspace,
  type ThreadListParams,
  type WarmThreadTarget,
} from "./codex/index.js";
import {
  createInitialDashboardState,
  dashboardReducer,
} from "./domain/reducer.js";
import { isSubagentThread, subagentRootId } from "./domain/selectors.js";
import type {
  CodexThread,
  PendingRequest,
  Preferences,
  RpcNotification,
  RpcServerRequest,
  SessionRecord,
} from "./domain/types.js";
import { buildServerRequestResponse } from "./request-resolution.js";
import { savePreferences } from "./state/preferences.js";
import { createReconnectLoop, type ReconnectLoop } from "./state/reconnect.js";
import {
  loadWorkspaceRegistry,
  registrationBelongsToProject,
  saveWorkspaceRegistration,
  type WorkspaceRegistry,
} from "./state/workspaces.js";
import {
  Dashboard,
  type DashboardStatusMessage,
  type RequestResolution,
  type SkillDefinition,
} from "./ui/index.js";

const ROOT_SOURCE_KINDS: NonNullable<ThreadListParams["sourceKinds"]> = [
  "cli",
  "vscode",
  "appServer",
];

export type AppOutcome =
  | { type: "exit" }
  | { type: "attach"; threadId: string; cwd: string; initialInput?: string };

export interface AgentViewAppProps {
  client: CodexClient;
  options: CliOptions;
  initialPreferences: Preferences;
  initialSelectedThreadId?: string;
  codexVersion: string;
  onDone: (outcome: AppOutcome) => void;
  onWarmThreads?: (targets: WarmThreadTarget[]) => void;
}

const PREWARM_SESSION_LIMIT = 3;

interface SkillsListResponse {
  data: Array<{
    skills: Array<{
      name: string;
      description: string;
      shortDescription?: string;
      interface?: { shortDescription?: string };
      enabled: boolean;
    }>;
  }>;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function automaticName(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim().slice(0, 64);
}

function pathIsWithin(parent: string, child: string): boolean {
  const difference = relative(resolve(parent), resolve(child));
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function threadIsVisible(
  thread: CodexThread,
  options: CliOptions,
  preferences: Preferences,
  registry: WorkspaceRegistry,
): boolean {
  if (options.allProjects) return true;
  if (preferences.pinnedThreadIds.includes(thread.id)) return true;
  if (thread.cwd && pathIsWithin(options.cwd, thread.cwd)) return true;
  return registrationBelongsToProject(registry.registrations[thread.id], options.cwd);
}

async function listEveryThread(client: CodexClient): Promise<CodexThread[]> {
  const byId = new Map<string, CodexThread>();
  let cursor: string | null = null;
  do {
    const params: ThreadListParams = {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ROOT_SOURCE_KINDS,
    };
    const page = await client.listThreads(params);
    for (const thread of page.data) byId.set(thread.id, thread);
    cursor = page.nextCursor;
  } while (cursor);
  return [...byId.values()];
}

function pendingRequestFromRpc(request: RpcServerRequest): PendingRequest | undefined {
  const params = request.params ?? {};
  const threadId = params.threadId ?? params.conversationId;
  if (typeof threadId !== "string") return undefined;
  return {
    id: request.id,
    method: request.method,
    threadId,
    turnId: typeof params.turnId === "string" ? params.turnId : undefined,
    params,
  };
}

export function AgentViewApp({
  client,
  options,
  initialPreferences,
  initialSelectedThreadId,
  codexVersion,
  onDone,
  onWarmThreads,
}: AgentViewAppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(
    dashboardReducer,
    undefined,
    () => createInitialDashboardState("connecting"),
  );
  const [preferences, setPreferences] = useState<Preferences>({
    ...initialPreferences,
    defaultCwd: options.cwd,
    showAllProjects: options.allProjects,
  });
  const [statusMessage, setStatusMessage] = useState<DashboardStatusMessage>();
  const [isBusy, setIsBusy] = useState(false);
  const [modelLabel, setModelLabel] = useState(options.model ?? "configured model");
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const stateRef = useRef(state);
  const preferencesRef = useRef(preferences);
  const registryRef = useRef<WorkspaceRegistry>({ version: 1, registrations: {} });
  const hydratedThreadIds = useRef(new Set<string>());
  const subscribedThreadIds = useRef(new Set<string>());
  const removedThreadIds = useRef(new Set<string>());
  const activeOperation = useRef<string | undefined>(undefined);
  const refreshGeneration = useRef(0);
  const reconnectLoopRef = useRef<ReconnectLoop | undefined>(undefined);
  const resolvingRequestIds = useRef(new Set<string>());
  const preferenceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const attachPending = useRef(false);
  const retainedAttachThreadId = useRef<string | undefined>(undefined);
  const finished = useRef(false);
  stateRef.current = state;
  preferencesRef.current = preferences;

  const beginOperation = useCallback((name: string): boolean => {
    if (activeOperation.current !== undefined || finished.current) return false;
    activeOperation.current = name;
    setIsBusy(true);
    return true;
  }, []);

  const endOperation = useCallback((name: string): void => {
    if (activeOperation.current !== name) return;
    activeOperation.current = undefined;
    setIsBusy(false);
  }, []);

  const loadSkills = useCallback(async (): Promise<void> => {
    const response = await client.request<SkillsListResponse>("skills/list", {
      cwds: [options.cwd],
    });
    const byName = new Map<string, SkillDefinition>();
    for (const entry of response.data) {
      for (const skill of entry.skills) {
        if (!skill.enabled || byName.has(skill.name)) continue;
        byName.set(skill.name, {
          name: skill.name,
          description:
            skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
        });
      }
    }
    setSkills([...byName.values()]);
  }, [client, options.cwd]);

  const finish = useCallback(
    (outcome: AppOutcome): void => {
      if (finished.current) return;
      if (activeOperation.current !== undefined) {
        setStatusMessage({
          kind: "warning",
          text: `Wait for ${activeOperation.current} to finish before leaving`,
        });
        return;
      }
      finished.current = true;
      void preferenceSaveQueue.current
        .catch((error: unknown) => {
          setStatusMessage({ kind: "error", text: messageFromError(error) });
        })
        .finally(() => onDone(outcome));
    },
    [onDone],
  );

  const ensureClientConnected = useCallback(async (): Promise<void> => {
    if (client.state === "connected") return;
    dispatch({ type: "connection/changed", connection: "connecting" });
    await client.connect();
    subscribedThreadIds.current.clear();
    dispatch({ type: "connection/changed", connection: "connected" });
  }, [client]);

  const ensureThreadSubscribed = useCallback(
    async (threadId: string): Promise<CodexThread> => {
      const existing = stateRef.current.sessions[threadId]?.thread;
      if (subscribedThreadIds.current.has(threadId) && existing) return existing;
      const resumed = await client.resumeThread(threadId, {
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
      });
      if (removedThreadIds.current.has(threadId)) {
        throw new Error("This session was removed while it was loading");
      }
      subscribedThreadIds.current.add(threadId);
      hydratedThreadIds.current.add(threadId);
      dispatch({ type: "thread/upsert", thread: resumed.thread });
      return resumed.thread;
    },
    [client, options.approvalPolicy, options.sandbox],
  );

  const refresh = useCallback(async (): Promise<boolean> => {
    const operation = "session refresh";
    if (!beginOperation(operation)) return false;
    const generation = ++refreshGeneration.current;
    setStatusMessage({ kind: "info", text: "Refreshing Codex sessions…" });
    try {
      await ensureClientConnected();
      const previousIds = new Set(Object.keys(stateRef.current.sessions));
      const [threads, registry] = await Promise.all([
        listEveryThread(client),
        loadWorkspaceRegistry(),
      ]);
      registryRef.current = registry;
      const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
      const visibleRoots = threads.filter((thread) =>
        !isSubagentThread(thread) &&
        !removedThreadIds.current.has(thread.id) &&
        threadIsVisible(thread, options, preferencesRef.current, registry)
      );
      const visibleRootIds = new Set(visibleRoots.map((thread) => thread.id));
      const visible = threads.filter((thread) => {
        if (visibleRootIds.has(thread.id)) return true;
        if (!isSubagentThread(thread) || removedThreadIds.current.has(thread.id)) return false;
        const parentId = subagentRootId(thread, threadsById);
        return parentId !== undefined && visibleRootIds.has(parentId);
      });
      const visibleIds = new Set(visible.map((thread) => thread.id));
      dispatch({ type: "thread/list", threads: visible });
      if (onWarmThreads) {
        const pinnedIds = new Set(preferencesRef.current.pinnedThreadIds);
        const warmTargets = visibleRoots
          .map((thread, index) => ({
            thread,
            index,
            priority: (thread.status.type === "active" ? 2 : 0) +
              (pinnedIds.has(thread.id) ? 1 : 0),
          }))
          .filter(({ priority }) => priority > 0)
          .sort((left, right) => right.priority - left.priority || left.index - right.index)
          .slice(0, PREWARM_SESSION_LIMIT)
          .map(({ thread }) => ({
            threadId: thread.id,
            cwd: registry.registrations[thread.id]?.taskCwd ?? thread.cwd ?? options.cwd,
          }));
        onWarmThreads(warmTargets);
      }
      for (const threadId of previousIds) {
        if (!visibleIds.has(threadId)) dispatch({ type: "thread/delete", threadId });
      }

      const active = visibleRoots.filter((thread) => thread.status.type === "active");
      const resumed = await Promise.allSettled(
        active.map((thread) =>
          client.resumeThread(thread.id, {
            approvalPolicy: options.approvalPolicy,
            sandbox: options.sandbox,
          }),
        ),
      );
      for (const result of resumed) {
        if (
          result.status === "fulfilled" &&
          !removedThreadIds.current.has(result.value.thread.id)
        ) {
          hydratedThreadIds.current.add(result.value.thread.id);
          subscribedThreadIds.current.add(result.value.thread.id);
          dispatch({ type: "thread/upsert", thread: result.value.thread });
        }
      }
      const resumeFailures = resumed.filter((result) => result.status === "rejected").length;

      // Hydrate a bounded recent window so rows show outcomes instead of only
      // repeating their first prompt. Older sessions load on demand when peeked.
      const recent = visible
        .filter(
          (thread) =>
            thread.status.type !== "active" &&
            !hydratedThreadIds.current.has(thread.id),
        )
        .slice(0, 20);
      for (const thread of recent) hydratedThreadIds.current.add(thread.id);
      void Promise.allSettled(
        recent.map((thread) => client.readThread(thread.id, true)),
      ).then((results) => {
        if (finished.current || generation !== refreshGeneration.current) return;
        for (const [index, result] of results.entries()) {
          const threadId = recent[index]?.id;
          if (
            result.status === "fulfilled" &&
            threadId !== undefined &&
            visibleIds.has(threadId) &&
            !removedThreadIds.current.has(threadId) &&
            generation === refreshGeneration.current
          ) {
            dispatch({ type: "thread/upsert", thread: result.value.thread });
          } else if (threadId) {
            hydratedThreadIds.current.delete(threadId);
          }
        }
      });
      setStatusMessage({
        kind: resumeFailures > 0 ? "warning" : "success",
        text: resumeFailures > 0
          ? `${visible.length} sessions loaded · ${resumeFailures} active session${resumeFailures === 1 ? "" : "s"} could not reconnect`
          : `${visible.length} session${visible.length === 1 ? "" : "s"} loaded`,
      });
      const fullyReconnected = resumeFailures === 0 && client.state === "connected";
      if (fullyReconnected) reconnectLoopRef.current?.stop();
      return fullyReconnected;
    } catch (error) {
      setStatusMessage({ kind: "error", text: messageFromError(error) });
      if (client.state !== "connected") {
        dispatch({
          type: "connection/changed",
          connection: "error",
          error: messageFromError(error),
        });
      }
      return false;
    } finally {
      endOperation(operation);
    }
  }, [beginOperation, client, endOperation, ensureClientConnected, onWarmThreads, options]);

  useEffect(() => {
    const reconnectLoop = createReconnectLoop({
      attempt: async () => finished.current ? true : refresh(),
      isBlocked: () => activeOperation.current !== undefined,
    });
    reconnectLoopRef.current = reconnectLoop;

    const onNotification = (notification: RpcNotification): void => {
      if (notification.method === "skills/changed") {
        void loadSkills().catch(() => undefined);
      }
      const threadId = typeof notification.params?.threadId === "string"
        ? notification.params.threadId
        : undefined;
      if (threadId && (notification.method === "thread/archived" || notification.method === "thread/deleted")) {
        removedThreadIds.current.add(threadId);
        hydratedThreadIds.current.delete(threadId);
        subscribedThreadIds.current.delete(threadId);
      } else if (threadId && notification.method === "thread/unarchived") {
        removedThreadIds.current.delete(threadId);
      } else if (threadId && notification.method === "thread/closed") {
        subscribedThreadIds.current.delete(threadId);
      }
      dispatch({ type: "rpc/message", message: notification });
    };
    const onServerRequest = (request: RpcServerRequest): void => {
      const pending = pendingRequestFromRpc(request);
      if (pending) {
        dispatch({ type: "serverRequest/received", request: pending });
      } else {
        setStatusMessage({
          kind: "warning",
          text: `Codex requested unsupported global input: ${request.method}`,
        });
        void client.respondError(request.id, {
          code: -32_601,
          message: `Unsupported global request: ${request.method}`,
        }).catch((error: unknown) => {
          setStatusMessage({ kind: "error", text: messageFromError(error) });
        });
      }
    };
    const onError = (error: Error): void => {
      setStatusMessage({ kind: "error", text: error.message });
    };
    const onDisconnect = (): void => {
      subscribedThreadIds.current.clear();
      hydratedThreadIds.current.clear();
      refreshGeneration.current += 1;
      for (const session of Object.values(stateRef.current.sessions)) {
        for (const request of session.pendingRequests) {
          dispatch({
            type: "serverRequest/resolved",
            requestId: request.id,
            threadId: request.threadId,
          });
        }
      }
      dispatch({ type: "connection/changed", connection: "disconnected" });
      if (!finished.current) reconnectLoop.start();
    };

    client.on("notification", onNotification);
    client.on("serverRequest", onServerRequest);
    client.on("protocolError", onError);
    client.on("error", onError);
    client.on("disconnect", onDisconnect);

    let cancelled = false;
    void (async () => {
      try {
        await client.connect();
        if (cancelled) return;
        dispatch({ type: "connection/changed", connection: "connected" });

        const configPromise = client.request<{ config?: Record<string, unknown> }>(
          "config/read",
        );
        const [refreshResult, configResult] = await Promise.allSettled([
          refresh(),
          configPromise,
          loadSkills(),
        ]);
        if (refreshResult.status === "rejected" || !refreshResult.value) {
          reconnectLoop.start();
        }
        if (configResult.status === "fulfilled") {
          const model = configResult.value.config?.model;
          const effort = configResult.value.config?.model_reasoning_effort;
          if (!options.model && typeof model === "string") {
            setModelLabel(
              typeof effort === "string" ? `${model} · ${effort} effort` : model,
            );
          }
        }
      } catch (error) {
        if (cancelled) return;
        dispatch({
          type: "connection/changed",
          connection: "error",
          error: messageFromError(error),
        });
        reconnectLoop.start();
      }
    })();

    return () => {
      cancelled = true;
      reconnectLoop.stop();
      if (reconnectLoopRef.current === reconnectLoop) reconnectLoopRef.current = undefined;
      client.off("notification", onNotification);
      client.off("serverRequest", onServerRequest);
      client.off("protocolError", onError);
      client.off("error", onError);
      client.off("disconnect", onDisconnect);
      for (const threadId of subscribedThreadIds.current) {
        if (threadId === retainedAttachThreadId.current) continue;
        void client.unsubscribeThread(threadId).catch(() => undefined);
      }
      subscribedThreadIds.current.clear();
    };
  }, [client, loadSkills, options.model, refresh]);

  const handleDispatch = useCallback(
    async (prompt: string, requestedCwd?: string): Promise<string | undefined> => {
      const operation = "task dispatch";
      if (!beginOperation(operation)) return;
      setStatusMessage({ kind: "info", text: "Preparing an isolated workspace…" });
      let worktreePath: string | undefined;
      try {
        await ensureClientConnected();
        const workspace = await prepareWorkspace(requestedCwd ?? options.cwd, prompt, {
          useWorktree: options.useWorktrees,
        });
        worktreePath = workspace.worktreePath;
        setStatusMessage({ kind: "info", text: "Starting Codex session…" });
        const started = await client.startThread({
          cwd: workspace.cwd,
          model: options.model,
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          serviceName: "codex_agent_view",
        });
        dispatch({ type: "thread/upsert", thread: started.thread });
        hydratedThreadIds.current.add(started.thread.id);
        subscribedThreadIds.current.add(started.thread.id);

        const registration = {
          threadId: started.thread.id,
          sourceCwd: workspace.sourceCwd,
          taskCwd: workspace.cwd,
          worktreePath: workspace.worktreePath,
          createdAt: Date.now(),
        };
        registryRef.current.registrations[started.thread.id] = registration;
        const turn = await client.startTurn(started.thread.id, prompt);
        dispatch({ type: "turn/started", threadId: started.thread.id, turn: turn.turn });

        const metadata = await Promise.allSettled([
          client.renameThread(started.thread.id, automaticName(prompt)),
          saveWorkspaceRegistration(registration),
        ]);
        const metadataFailures = metadata.filter((result) => result.status === "rejected").length;
        setStatusMessage({
          kind: metadataFailures > 0 ? "warning" : "success",
          text: `${workspace.worktreePath
            ? `Dispatched in ${workspace.worktreePath}`
            : `Dispatched in ${workspace.cwd}`}${metadataFailures > 0 ? " · session metadata could not be fully saved" : ""}`,
        });
        return started.thread.id;
      } catch (error) {
        setStatusMessage({
          kind: "error",
          text: `${messageFromError(error)}${worktreePath ? ` · worktree kept at ${worktreePath}` : ""}`,
        });
      } finally {
        endOperation(operation);
      }
    },
    [beginOperation, client, endOperation, ensureClientConnected, options],
  );

  const handleSteer = useCallback(
    async (threadId: string, prompt: string): Promise<void> => {
      const operation = "message send";
      if (!beginOperation(operation)) return;
      try {
        await ensureClientConnected();
        const thread = await ensureThreadSubscribed(threadId);
        const activeTurnId = thread.turns?.findLast(
          (turn) => turn.status === "inProgress",
        )?.id ?? stateRef.current.sessions[threadId]?.activeTurnId;
        if (activeTurnId) {
          await client.steerTurn(threadId, activeTurnId, prompt);
          setStatusMessage({ kind: "success", text: "Steered the active turn" });
        } else {
          const result = await client.startTurn(threadId, prompt);
          dispatch({ type: "turn/started", threadId, turn: result.turn });
          setStatusMessage({ kind: "success", text: "Follow-up started" });
        }
      } catch (error) {
        setStatusMessage({ kind: "error", text: messageFromError(error) });
      } finally {
        endOperation(operation);
      }
    },
    [beginOperation, client, endOperation, ensureClientConnected, ensureThreadSubscribed],
  );

  const handleResolveRequest = useCallback(
    async (request: PendingRequest, resolution: RequestResolution): Promise<void> => {
      const requestKey = `${request.threadId}:${String(request.id)}`;
      if (resolvingRequestIds.current.has(requestKey)) return;
      const operation = "request response";
      if (!beginOperation(operation)) return;
      resolvingRequestIds.current.add(requestKey);
      try {
        const response = buildServerRequestResponse(request, resolution);
        if (response.type === "result") {
          await client.respond(request.id, response.value);
        } else {
          await client.respondError(request.id, {
            code: response.code,
            message: response.message,
          });
        }
        dispatch({
          type: "serverRequest/resolved",
          requestId: request.id,
          threadId: request.threadId,
        });
        setStatusMessage({ kind: "success", text: "Response sent to Codex" });
      } catch (error) {
        setStatusMessage({ kind: "error", text: messageFromError(error) });
      } finally {
        resolvingRequestIds.current.delete(requestKey);
        endOperation(operation);
      }
    },
    [beginOperation, client, endOperation],
  );

  const handleInterrupt = useCallback(
    async (threadId: string): Promise<void> => {
      const operation = "turn interrupt";
      if (!beginOperation(operation)) return;
      try {
        await ensureClientConnected();
        const thread = await ensureThreadSubscribed(threadId);
        const turnId = thread.turns?.findLast(
          (turn) => turn.status === "inProgress",
        )?.id ?? stateRef.current.sessions[threadId]?.activeTurnId;
        if (!turnId) {
          setStatusMessage({ kind: "warning", text: "This session has no active turn" });
          return;
        }
        await client.interruptTurn(threadId, turnId);
        setStatusMessage({ kind: "success", text: "Turn interrupted" });
      } catch (error) {
        setStatusMessage({ kind: "error", text: messageFromError(error) });
      } finally {
        endOperation(operation);
      }
    },
    [beginOperation, client, endOperation, ensureClientConnected, ensureThreadSubscribed],
  );

  const handleRename = useCallback(
    async (threadId: string, name: string): Promise<void> => {
      const operation = "session rename";
      if (!beginOperation(operation)) return;
      try {
        await ensureClientConnected();
        await client.renameThread(threadId, name);
        dispatch({ type: "thread/name", threadId, name });
        setStatusMessage({ kind: "success", text: "Session renamed" });
      } catch (error) {
        setStatusMessage({ kind: "error", text: messageFromError(error) });
      } finally {
        endOperation(operation);
      }
    },
    [beginOperation, client, endOperation, ensureClientConnected],
  );

  const handleArchive = useCallback(
    async (threadId: string): Promise<void> => {
      const session = stateRef.current.sessions[threadId];
      if (session?.thread.status.type === "active" || session?.activeTurnId) {
        setStatusMessage({
          kind: "warning",
          text: "Interrupt the active turn before archiving this session",
        });
        return;
      }
      const operation = "session archive";
      if (!beginOperation(operation)) return;
      try {
        await ensureClientConnected();
        await client.archiveThread(threadId);
        removedThreadIds.current.add(threadId);
        hydratedThreadIds.current.delete(threadId);
        subscribedThreadIds.current.delete(threadId);
        dispatch({ type: "thread/archive", threadId });
        setStatusMessage({ kind: "success", text: "Session archived" });
      } catch (error) {
        setStatusMessage({ kind: "error", text: messageFromError(error) });
      } finally {
        endOperation(operation);
      }
    },
    [beginOperation, client, endOperation, ensureClientConnected],
  );

  const persistPreferences = useCallback((next: Preferences): void => {
    preferencesRef.current = next;
    setPreferences(next);
    const save = preferenceSaveQueue.current
      .catch(() => undefined)
      .then(() => savePreferences(next));
    preferenceSaveQueue.current = save;
    void save.catch((error: unknown) => {
      setStatusMessage({ kind: "error", text: messageFromError(error) });
    });
  }, []);

  const handlePinToggle = useCallback((threadId: string, pinned: boolean): void => {
    const current = preferencesRef.current;
    const ids = new Set(current.pinnedThreadIds);
    if (pinned) ids.add(threadId);
    else ids.delete(threadId);
    persistPreferences({
      ...current,
      pinnedThreadIds: [...ids],
      order: pinned
        ? current.order.filter((orderedThreadId) => orderedThreadId !== threadId)
        : current.order,
    });
  }, [persistPreferences]);

  const handleReorder = useCallback((orderedThreadIds: string[]): void => {
    const current = preferencesRef.current;
    const visibleIds = new Set(orderedThreadIds);
    persistPreferences({
      ...current,
      order: [
        ...orderedThreadIds,
        ...current.order.filter((threadId) => !visibleIds.has(threadId)),
      ],
    });
  }, [persistPreferences]);

  const handleSelectionChange = useCallback(
    (session: SessionRecord | undefined): void => {
      if (!session) return;
      if (client.state === "connected" && subscribedThreadIds.current.has(session.thread.id)) return;
      const operation = "chat load";
      if (!beginOperation(operation)) return;
      void (async () => {
        await ensureClientConnected();
        return ensureThreadSubscribed(session.thread.id);
      })()
        .then(() => {
          setStatusMessage({ kind: "success", text: "Conversation loaded" });
        })
        .catch((error: unknown) => {
          subscribedThreadIds.current.delete(session.thread.id);
          setStatusMessage({ kind: "error", text: messageFromError(error) });
        })
        .finally(() => {
          endOperation(operation);
        });
    },
    [beginOperation, client, endOperation, ensureClientConnected, ensureThreadSubscribed],
  );

  const handleAttach = useCallback(
    (threadId: string, initialInput?: string): void => {
      if (attachPending.current || finished.current) return;
      attachPending.current = true;
      retainedAttachThreadId.current = threadId;
      const cwd = registryRef.current.registrations[threadId]?.taskCwd ??
        stateRef.current.sessions[threadId]?.thread.cwd ?? options.cwd;
      setStatusMessage({ kind: "info", text: "Opening warm native Codex…" });
      void ensureClientConnected()
        .then(() => ensureThreadSubscribed(threadId))
        .catch(() => undefined)
        .finally(() => finish({ type: "attach", threadId, cwd, initialInput }));
    },
    [ensureClientConnected, ensureThreadSubscribed, finish, options.cwd],
  );

  return (
    <Dashboard
      state={state}
      preferences={preferences}
      initialSelectedThreadId={initialSelectedThreadId}
      version={codexVersion}
      model={modelLabel}
      cwd={options.cwd}
      statusMessage={statusMessage}
      isBusy={isBusy}
      skills={skills}
      onDispatch={handleDispatch}
      onSteer={(threadId, prompt) => void handleSteer(threadId, prompt)}
      onResolveRequest={(request, resolution) =>
        void handleResolveRequest(request, resolution)}
      onInterrupt={(threadId) => void handleInterrupt(threadId)}
      onRename={(threadId, name) => void handleRename(threadId, name)}
      onArchive={(threadId) => void handleArchive(threadId)}
      onPinToggle={handlePinToggle}
      onReorder={handleReorder}
      onAttach={handleAttach}
      onRefresh={() => void refresh()}
      onExit={() => finish({ type: "exit" })}
      onSelectionChange={handleSelectionChange}
    />
  );
}
