import { describe, expect, it } from "vitest";

import {
  completeSlashCommand,
  isLeadingSlashCommand,
  slashCommandSuggestions,
  validSlashCommandRanges,
} from "../src/ui/slash-commands.js";

describe("slash command composer support", () => {
  it("recognizes valid commands anywhere in a prompt", () => {
    expect(validSlashCommandRanges("run /model then /not-real")).toEqual([
      { start: 4, end: 10 },
    ]);
  });

  it("suggests and completes the command under the cursor", () => {
    expect(slashCommandSuggestions("try /mo later", 7).map((command) => command.name)).toContain(
      "model",
    );
    expect(completeSlashCommand("try /mo later", 7)).toEqual({
      value: "try /model later",
      cursor: 10,
    });
  });

  it("only routes a valid leading command to the native TUI", () => {
    expect(isLeadingSlashCommand("/model")).toBe(true);
    expect(isLeadingSlashCommand("  /review staged changes")).toBe(true);
    expect(isLeadingSlashCommand("please /review this")).toBe(false);
    expect(isLeadingSlashCommand("/not-real")).toBe(false);
  });
});
