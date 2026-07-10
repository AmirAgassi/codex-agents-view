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
  it("shows unloaded historical threads as completed with a process-shape distinction", () => {
    const session = historicalSession("one");
    const model = buildDashboardModel(
      { connection: "connected", sessions: { one: session } },
      DEFAULT_PREFERENCES,
    );

    expect(semanticGroup(session)).toBe("completed");
    expect(model.counts).toEqual({ needsInput: 0, working: 0, completed: 1 });
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

    expect(model.items.map((item) => item.id)).toEqual(["older", "newer"]);
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
