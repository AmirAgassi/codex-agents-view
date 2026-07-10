import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { discardPendingInput } from "../src/terminal-input.js";

describe("terminal input cleanup", () => {
  it("discards keystrokes queued while returning from a native chat", () => {
    const input = new PassThrough();
    input.write("/leftover");

    discardPendingInput(input);

    expect(input.read()).toBeNull();
  });
});
