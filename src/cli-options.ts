import { resolve } from "node:path";

export const VERSION = "0.1.0";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CliOptions {
  cwd: string;
  allProjects: boolean;
  useWorktrees: boolean;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  dangerouslyBypassApprovalsAndSandbox: boolean;
  help: boolean;
  version: boolean;
}

const APPROVAL_POLICIES = new Set<ApprovalPolicy>(["untrusted", "on-request", "never"]);
const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseCliOptions(args: string[], initialCwd = process.cwd()): CliOptions {
  const options: CliOptions = {
    cwd: resolve(initialCwd),
    allProjects: false,
    useWorktrees: true,
    dangerouslyBypassApprovalsAndSandbox: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--all":
        options.allProjects = true;
        break;
      case "--direct":
      case "--no-worktree":
        options.useWorktrees = false;
        break;
      case "--cwd":
      case "-C": {
        const value = takeValue(args, index, arg);
        options.cwd = resolve(initialCwd, value);
        index += 1;
        break;
      }
      case "--model":
      case "-m":
        options.model = takeValue(args, index, arg);
        index += 1;
        break;
      case "--approval": {
        const value = takeValue(args, index, arg) as ApprovalPolicy;
        if (!APPROVAL_POLICIES.has(value)) {
          throw new Error(`Unsupported approval policy: ${value}`);
        }
        options.approvalPolicy = value;
        index += 1;
        break;
      }
      case "--dangerously-bypass-approvals-and-sandbox":
        options.approvalPolicy = "never";
        options.sandbox = "danger-full-access";
        break;
      case "--sandbox":
      case "-s": {
        const value = takeValue(args, index, arg) as SandboxMode;
        if (!SANDBOX_MODES.has(value)) {
          throw new Error(`Unsupported sandbox mode: ${value}`);
        }
        options.sandbox = value;
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-V":
        options.version = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.dangerouslyBypassApprovalsAndSandbox =
    options.approvalPolicy === "never" && options.sandbox === "danger-full-access";

  return options;
}

export const HELP_TEXT = `codex-agents ${VERSION}

Usage: codex-agents [options]

Options:
  -C, --cwd <path>       Project directory to show and dispatch into
      --all              Show sessions from every project
      --direct           Dispatch in the project checkout, without a worktree
  -m, --model <model>    Override the configured Codex model for new sessions
      --approval <mode>  untrusted, on-request, or never
  -s, --sandbox <mode>   read-only, workspace-write, or danger-full-access
      --dangerously-bypass-approvals-and-sandbox
                         Skip approvals and sandboxing in dashboard and native chats
  -h, --help             Show help
  -V, --version          Show version

New sessions use isolated Git worktrees by default. Use --direct when a task
must operate in the current checkout. Enter or → opens a warm native Codex TUI;
Shift+← or Ctrl+B parks it while the daemon-owned turn keeps running. tmux is
used when available, with a transparent PTY fallback.`;
