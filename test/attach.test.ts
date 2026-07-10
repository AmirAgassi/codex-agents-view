import { describe, expect, it } from "vitest";
import {
  buildAttachArgs,
  DetachInputParser,
  DETACH_CONTROL_B,
  DETACH_SHIFT_LEFT,
  isDetachInput,
} from "../src/codex/attach.js";

describe("buildAttachArgs", () => {
  it("resumes the selected thread through the managed Unix daemon", () => {
    expect(buildAttachArgs("019abc-thread")).toEqual([
      "resume",
      "--remote",
      "unix://",
      "019abc-thread",
    ]);
    expect(buildAttachArgs("019abc-thread", true)).toEqual([
      "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      "--remote",
      "unix://",
      "019abc-thread",
    ]);
  });

  it("recognizes dedicated detach keys without stealing normal arrows", () => {
    expect(isDetachInput(DETACH_CONTROL_B)).toBe(true);
    expect(isDetachInput(Buffer.from(DETACH_SHIFT_LEFT))).toBe(true);
    expect(isDetachInput("\u001b[D")).toBe(false);
    expect(isDetachInput("ordinary input")).toBe(false);
  });

  it("recognizes Kitty Ctrl+B and Shift+Left press or repeat events", () => {
    expect(isDetachInput("\u001b[98;5u")).toBe(true);
    expect(isDetachInput("\u001b[98::98;5:1u")).toBe(true);
    expect(isDetachInput("\u001b[98;5:2u")).toBe(true);
    expect(isDetachInput("\u001b[1;2:1D")).toBe(true);
    expect(isDetachInput("\u001b[1;2:2D")).toBe(true);
  });

  it("passes through releases, other modifiers, and plain Left", () => {
    expect(isDetachInput("\u001b[98;5:3u")).toBe(false);
    expect(isDetachInput("\u001b[98;6u")).toBe(false);
    expect(isDetachInput("\u001b[1;2:3D")).toBe(false);
    expect(isDetachInput("\u001b[D")).toBe(false);
  });
});

describe("DetachInputParser", () => {
  it("detects a Kitty detach event split across stream reads", () => {
    const parser = new DetachInputParser();
    const first = parser.push("before\u001b[98;");
    expect(first).toEqual({ detach: false, passthrough: Buffer.from("before") });
    expect(parser.hasPending).toBe(true);

    const second = parser.push("5:1u");
    expect(second).toEqual({ detach: true, passthrough: Buffer.alloc(0) });
    expect(parser.hasPending).toBe(false);
  });

  it("preserves fragmented non-detach input byte-for-byte", () => {
    const parser = new DetachInputParser();
    const first = parser.push(Buffer.from("text\u001b["));
    const second = parser.push(Buffer.from("D🙂"));
    expect(Buffer.concat([first.passthrough, second.passthrough])).toEqual(
      Buffer.from("text\u001b[D🙂"),
    );
    expect(second.detach).toBe(false);
  });

  it("flushes a standalone incomplete escape sequence", () => {
    const parser = new DetachInputParser();
    expect(parser.push("\u001b").passthrough).toEqual(Buffer.alloc(0));
    expect(parser.flush()).toEqual(Buffer.from("\u001b"));
    expect(parser.hasPending).toBe(false);
  });

  it("forwards bytes before a raw detach key", () => {
    const parser = new DetachInputParser();
    expect(parser.push(`abc${DETACH_CONTROL_B}ignored`)).toEqual({
      detach: true,
      passthrough: Buffer.from("abc"),
    });
  });
});
