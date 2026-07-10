import { describe, expect, it } from "vitest";
import { createSessionRecord } from "../src/domain/reducer.js";
import { DEFAULT_PREFERENCES, type PendingRequest } from "../src/domain/types.js";
import {
  compactText,
  parseQuestions,
  requestScopeDetails,
  semanticGroup,
} from "../src/ui/format.js";
import { buildDashboardModel } from "../src/ui/model.js";

function historicalSession(id: string, createdAt = 100, updatedAt = 200) {
  return createSessionRecord({
    id,
    preview: `Task ${id}`,
    cwd: "/repo",
    createdAt,
    updatedAt,
    status: { type: "notLoaded" },
    turns: [],
  });
}

describe("dashboard presentation model", () => {
  it("moves unloaded historical threads into the stale section", () => {
    const session = historicalSession("one");
    const model = buildDashboardModel(
      { connection: "connected", sessions: { one: session } },
      DEFAULT_PREFERENCES,
    );

    expect(semanticGroup(session)).toBe("stale");
    expect(model.counts).toEqual({ needsInput: 0, working: 0, completed: 0, stale: 1 });
    expect(model.sections[0]?.label).toBe("Stale");
  });

  it("keeps loaded idle threads in completed", () => {
    const session = createSessionRecord({
      id: "done",
      preview: "Done",
      cwd: "/repo",
      createdAt: 100,
      updatedAt: 200,
      status: { type: "idle" },
      turns: [],
    });
    const model = buildDashboardModel(
      { connection: "connected", sessions: { done: session } },
      DEFAULT_PREFERENCES,
    );

    expect(semanticGroup(session)).toBe("completed");
    expect(model.counts).toEqual({ needsInput: 0, working: 0, completed: 1, stale: 0 });
    expect(model.sections[0]?.label).toBe("Completed");
  });

  it("keeps sessions in launch order when their activity changes", () => {
    const older = historicalSession("older", 100, 500);
    const newer = historicalSession("newer", 200, 300);
    older.lastChangedAt = 1_000;
    newer.lastChangedAt = 400;

    const model = buildDashboardModel(
      { connection: "connected", sessions: { newer, older } },
      DEFAULT_PREFERENCES,
    );

    expect(model.items.map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("puts newly launched sessions above a persisted manual order", () => {
    const first = historicalSession("first", 100);
    const second = historicalSession("second", 200);
    const newest = historicalSession("newest", 300);
    const model = buildDashboardModel(
      { connection: "connected", sessions: { first, second, newest } },
      { ...DEFAULT_PREFERENCES, order: ["first", "second"] },
    );

    expect(model.items.map((item) => item.id)).toEqual(["newest", "first", "second"]);
  });

  it("puts the pinned section first while preserving pinning order", () => {
    const firstPinned = historicalSession("first-pinned", 300);
    const secondPinned = historicalSession("second-pinned", 100);
    const regular = historicalSession("regular", 200);
    const model = buildDashboardModel(
      {
        connection: "connected",
        sessions: { regular, "first-pinned": firstPinned, "second-pinned": secondPinned },
      },
      {
        ...DEFAULT_PREFERENCES,
        pinnedThreadIds: ["first-pinned", "second-pinned"],
      },
    );

    expect(model.sections.map((section) => section.label)).toEqual(["Pinned", "Stale"]);
    expect(model.sections[0]?.items.map((item) => item.id)).toEqual([
      "first-pinned",
      "second-pinned",
    ]);
  });

  it("strips terminal control characters from model-controlled text", () => {
    expect(compactText("safe\u001b[2J text\u0007")).toBe("safe[2J text");
  });

  it("preserves secret-question metadata so the composer can mask answers", () => {
    const request: PendingRequest = {
      id: 1,
      method: "item/tool/requestUserInput",
      threadId: "one",
      params: {
        questions: [
          {
            id: "token",
            question: "Enter token",
            header: "Secret",
            isSecret: true,
            options: null,
          },
        ],
      },
    };

    expect(parseQuestions(request)).toMatchObject([
      { id: "token", question: "Enter token", isSecret: true },
    ]);
  });

  it("shows the actual capability scope requested by approvals", () => {
    const request: PendingRequest = {
      id: 2,
      method: "item/commandExecution/requestApproval",
      threadId: "one",
      params: {
        networkApprovalContext: { protocol: "https", host: "api.example.com", port: 443 },
        grantRoot: "/repo/generated",
        permissions: { network: true, fileSystem: { write: ["/repo/generated"] } },
        proposedExecpolicyAmendment: { allow: ["git", "fetch"] },
      },
    };

    expect(requestScopeDetails(request)).toEqual([
      "Network: https://api.example.com:443",
      "File access: /repo/generated",
      'Permissions: {"network":true,"fileSystem":{"write":["/repo/generated"]}}',
      'Policy change: {"allow":["git","fetch"]}',
    ]);
  });
});
