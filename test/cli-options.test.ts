import { describe, expect, it } from "vitest";
import { parseCliOptions } from "../src/cli-options.js";

describe("parseCliOptions", () => {
  it("uses safe defaults", () => {
    expect(parseCliOptions([], "/tmp/project")).toEqual({
      cwd: "/tmp/project",
      allProjects: false,
      useWorktrees: true,
      dangerouslyBypassApprovalsAndSandbox: false,
      help: false,
      version: false,
    });
  });

  it("supports Codex skip-permissions mode", () => {
    expect(
      parseCliOptions(["--dangerously-bypass-approvals-and-sandbox"], "/tmp/project"),
    ).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
    });
    expect(
      parseCliOptions(
        ["--approval", "never", "--sandbox", "danger-full-access"],
        "/tmp/project",
      ).dangerouslyBypassApprovalsAndSandbox,
    ).toBe(true);
  });

  it("parses launch overrides", () => {
    expect(
      parseCliOptions(
        ["--all", "--direct", "-C", "nested", "-m", "gpt-test", "--approval", "never", "-s", "read-only"],
        "/tmp/project",
      ),
    ).toMatchObject({
      cwd: "/tmp/project/nested",
      allProjects: true,
      useWorktrees: false,
      model: "gpt-test",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });

  it("rejects unknown and incomplete options", () => {
    expect(() => parseCliOptions(["--wat"])).toThrow("Unknown option");
    expect(() => parseCliOptions(["--model"])).toThrow("requires a value");
    expect(() => parseCliOptions(["--approval", "sometimes"])).toThrow(
      "Unsupported approval policy",
    );
  });
});
