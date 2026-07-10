export interface SlashCommandDefinition {
  name: string;
  description: string;
}

export interface TextRange {
  start: number;
  end: number;
}

interface SlashToken extends TextRange {
  query: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { name: "model", description: "choose the model and reasoning effort" },
  { name: "fast", description: "toggle the Fast service tier" },
  { name: "permissions", description: "choose what Codex may do" },
  { name: "review", description: "review the current changes" },
  { name: "plan", description: "switch to Plan mode" },
  { name: "mention", description: "mention a file" },
  { name: "skills", description: "browse and use skills" },
  { name: "status", description: "show session configuration and usage" },
  { name: "debug-config", description: "show config layers and requirement sources" },
  { name: "diff", description: "show the Git diff" },
  { name: "compact", description: "summarize the conversation" },
  { name: "rename", description: "rename the current thread" },
  { name: "new", description: "start a new chat" },
  { name: "resume", description: "resume a saved chat" },
  { name: "fork", description: "fork the current chat" },
  { name: "init", description: "create an AGENTS.md file" },
  { name: "goal", description: "set or view the task goal" },
  { name: "agent", description: "switch the active agent thread" },
  { name: "subagents", description: "switch the active agent thread" },
  { name: "side", description: "start an ephemeral side conversation" },
  { name: "btw", description: "start an ephemeral side conversation" },
  { name: "mcp", description: "list configured MCP tools" },
  { name: "apps", description: "manage apps" },
  { name: "plugins", description: "browse plugins" },
  { name: "usage", description: "view account usage" },
  { name: "personality", description: "choose a communication style" },
  { name: "ide", description: "include current IDE context" },
  { name: "keymap", description: "remap TUI shortcuts" },
  { name: "vim", description: "toggle Vim composer mode" },
  { name: "experimental", description: "toggle experimental features" },
  { name: "approve", description: "approve a retry denied by automatic review" },
  { name: "memories", description: "configure memory use" },
  { name: "import", description: "import setup and chats from Claude Code" },
  { name: "hooks", description: "view and manage lifecycle hooks" },
  { name: "app", description: "continue this session in Codex Desktop" },
  { name: "copy", description: "copy the last response" },
  { name: "raw", description: "toggle raw scrollback mode" },
  { name: "ps", description: "list background terminals" },
  { name: "stop", description: "stop all background terminals" },
  { name: "clean", description: "stop all background terminals" },
  { name: "clear", description: "clear the terminal and start fresh" },
  { name: "title", description: "configure the terminal title" },
  { name: "statusline", description: "configure the status line" },
  { name: "theme", description: "choose a syntax highlighting theme" },
  { name: "pets", description: "choose or hide the terminal pet" },
  { name: "pet", description: "choose or hide the terminal pet" },
  { name: "archive", description: "archive this session and exit" },
  { name: "delete", description: "delete this session and exit" },
  { name: "quit", description: "exit Codex" },
  { name: "exit", description: "exit Codex" },
  { name: "logout", description: "log out of Codex" },
  { name: "feedback", description: "send logs to Codex maintainers" },
];

const COMMAND_NAMES = new Set(SLASH_COMMANDS.map((command) => command.name));
const COMMAND_CHARACTER = /^[a-z-]$/iu;

function tokenAtCursor(value: string, cursor: number): SlashToken | undefined {
  const characters = Array.from(value);
  let nameStart = cursor;
  while (nameStart > 0 && COMMAND_CHARACTER.test(characters[nameStart - 1] ?? "")) {
    nameStart -= 1;
  }
  const start = nameStart - 1;
  if (start < 0 || characters[start] !== "/") return undefined;
  if (start > 0 && !/\s/u.test(characters[start - 1] ?? "")) return undefined;
  let end = cursor;
  while (end < characters.length && COMMAND_CHARACTER.test(characters[end] ?? "")) end += 1;
  return {
    start,
    end,
    query: characters.slice(nameStart, end).join("").toLowerCase(),
  };
}

export function slashCommandSuggestions(
  value: string,
  cursor: number,
): readonly SlashCommandDefinition[] {
  const token = tokenAtCursor(value, cursor);
  if (!token) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(token.query)).slice(0, 5);
}

export function completeSlashCommand(
  value: string,
  cursor: number,
): { value: string; cursor: number } | undefined {
  const token = tokenAtCursor(value, cursor);
  const suggestion = slashCommandSuggestions(value, cursor)[0];
  if (!token || !suggestion) return undefined;
  const characters = Array.from(value);
  const replacement = Array.from(`/${suggestion.name}`);
  characters.splice(token.start, token.end - token.start, ...replacement);
  return {
    value: characters.join(""),
    cursor: token.start + replacement.length,
  };
}

export function validSlashCommandRanges(value: string): TextRange[] {
  const characters = Array.from(value);
  const ranges: TextRange[] = [];
  for (let start = 0; start < characters.length; start += 1) {
    if (characters[start] !== "/") continue;
    if (start > 0 && !/\s/u.test(characters[start - 1] ?? "")) continue;
    let end = start + 1;
    while (end < characters.length && COMMAND_CHARACTER.test(characters[end] ?? "")) end += 1;
    const name = characters.slice(start + 1, end).join("").toLowerCase();
    if (COMMAND_NAMES.has(name)) ranges.push({ start, end });
    start = end - 1;
  }
  return ranges;
}

export function isLeadingSlashCommand(value: string): boolean {
  const trimmed = value.trimStart();
  const match = /^\/([a-z-]+)(?:\s|$)/iu.exec(trimmed);
  return match?.[1] !== undefined && COMMAND_NAMES.has(match[1].toLowerCase());
}
