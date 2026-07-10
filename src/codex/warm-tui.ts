import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { attachToThread, buildAttachArgs } from "./attach.js";

const DEFAULT_MAX_WARM_SESSIONS = 3;
const TMUX_SESSION_PREFIX = "cav-";
const TMUX_LAST_USED_OPTION = "@codex_agent_view_last_used";

export interface WarmThreadTarget {
  threadId: string;
  cwd: string;
}

export interface WarmAttachOptions {
  codexCommand?: string;
  cwd?: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface WarmAttachResult {
  exitCode: number;
  warm: boolean;
}

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TmuxRunner = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<TmuxCommandResult>;

export type ColdAttach = (
  threadId: string,
  options?: WarmAttachOptions,
) => Promise<number>;

export interface WarmNativeTuiManagerOptions {
  tmuxCommand?: string;
  codexCommand?: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  socketName?: string;
  maxWarmSessions?: number;
  env?: NodeJS.ProcessEnv;
  runTmux?: TmuxRunner;
  attachTmux?: TmuxRunner;
  coldAttach?: ColdAttach;
}

interface TmuxSessionRow {
  attached: boolean;
  lastUsed: number;
  name: string;
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
};

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 1;
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  attached: boolean,
): Promise<TmuxCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: attached ? "inherit" : ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (result: TmuxCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    if (!attached) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      finish({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on("exit", (code, signal) => {
      finish({
        exitCode: code ?? signalExitCode(signal),
        stdout,
        stderr,
      });
    });
  });
}

const defaultRunner: TmuxRunner = (command, args, env) =>
  runProcess(command, args, env, false);
const defaultAttachRunner: TmuxRunner = (command, args, env) =>
  runProcess(command, args, env, true);

export function tmuxSocketName(
  codexHome = process.env.CODEX_HOME ?? "~/.codex",
  ownerPid = process.pid,
): string {
  const profile = createHash("sha256").update(codexHome).digest("hex").slice(0, 10);
  return `codex-agent-view-${ownerPid}-${profile}`;
}

export function tmuxSessionName(threadId: string): string {
  const id = createHash("sha256").update(threadId).digest("hex").slice(0, 20);
  return `${TMUX_SESSION_PREFIX}${id}`;
}

function parseSessionRows(output: string): TmuxSessionRow[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", lastUsed = "0", attached = "0"] = line.split("\t");
      return {
        name,
        lastUsed: Number(lastUsed) || 0,
        attached: Number(attached) > 0,
      };
    })
    .filter((row) => row.name.startsWith(TMUX_SESSION_PREFIX));
}

function terminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.TERM && env.TERM !== "dumb"
    ? env
    : { ...env, TERM: "xterm-256color" };
}

/**
 * Keeps the official Codex TUI alive in detached tmux sessions. tmux owns the
 * virtual terminal screen, so reattachment is an exact native redraw and MCP
 * initialization happens only once per warm session.
 */
export class WarmNativeTuiManager {
  readonly #tmuxCommand: string;
  readonly #codexCommand: string;
  readonly #dangerouslyBypassApprovalsAndSandbox: boolean;
  readonly #socketName: string;
  readonly #maxWarmSessions: number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #runTmux: TmuxRunner;
  readonly #attachTmux: TmuxRunner;
  readonly #coldAttach: ColdAttach;
  readonly #ownsSocketFile: boolean;
  readonly #starting = new Map<string, Promise<void>>();
  #available: boolean | undefined;
  #configured = false;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: WarmNativeTuiManagerOptions = {}) {
    this.#tmuxCommand = options.tmuxCommand ?? "tmux";
    this.#codexCommand = options.codexCommand ?? "codex";
    this.#dangerouslyBypassApprovalsAndSandbox =
      options.dangerouslyBypassApprovalsAndSandbox ?? false;
    this.#socketName = options.socketName ?? tmuxSocketName(options.env?.CODEX_HOME);
    this.#maxWarmSessions = Math.max(
      1,
      Math.floor(options.maxWarmSessions ?? DEFAULT_MAX_WARM_SESSIONS),
    );
    this.#env = terminalEnvironment(options.env ?? process.env);
    this.#runTmux = options.runTmux ?? defaultRunner;
    this.#attachTmux = options.attachTmux ?? defaultAttachRunner;
    this.#coldAttach = options.coldAttach ?? attachToThread;
    this.#ownsSocketFile = options.runTmux === undefined;
  }

  get baseArgs(): string[] {
    return ["-L", this.#socketName, "-f", "/dev/null"];
  }

  async isAvailable(): Promise<boolean> {
    if (this.#disposed) return false;
    if (this.#available !== undefined) return this.#available;
    const result = await this.#run(["-V"]);
    this.#available = result.exitCode === 0;
    return this.#available;
  }

  async warm(target: WarmThreadTarget): Promise<boolean> {
    if (this.#disposed) return false;
    if (!(await this.isAvailable())) return false;
    try {
      await this.#ensureSession(target.threadId, {
        cwd: target.cwd,
        codexCommand: this.#codexCommand,
        dangerouslyBypassApprovalsAndSandbox:
          this.#dangerouslyBypassApprovalsAndSandbox,
        env: this.#env,
      });
      await this.#prune(tmuxSessionName(target.threadId));
      return true;
    } catch {
      return false;
    }
  }

  async prewarm(targets: WarmThreadTarget[]): Promise<void> {
    for (const target of targets.slice(0, this.#maxWarmSessions)) {
      await this.warm(target);
    }
  }

  async attach(
    threadId: string,
    options: WarmAttachOptions = {},
  ): Promise<WarmAttachResult> {
    if (this.#disposed) {
      throw new Error("The warm native TUI manager is closed");
    }
    const attachOptions = {
      ...options,
      dangerouslyBypassApprovalsAndSandbox:
        options.dangerouslyBypassApprovalsAndSandbox ??
        this.#dangerouslyBypassApprovalsAndSandbox,
    };
    if (!(await this.isAvailable())) {
      return {
        exitCode: await this.#coldAttach(threadId, attachOptions),
        warm: false,
      };
    }

    const name = tmuxSessionName(threadId);
    try {
      await this.#ensureSession(threadId, attachOptions);
      await this.#touch(name);
      await this.#prune(name);
      await this.#run([
        "resize-window",
        "-t",
        `=${name}:`,
        "-x",
        String(Math.max(1, process.stdout.columns ?? 120)),
        "-y",
        String(Math.max(1, process.stdout.rows ?? 40)),
      ]);
      const attached = await this.#attachTmux(
        this.#tmuxCommand,
        [...this.baseArgs, "attach-session", "-t", `=${name}`],
        terminalEnvironment(attachOptions.env ?? this.#env),
      );
      if (attached.exitCode !== 0) {
        await this.#run(["kill-session", "-t", `=${name}`]);
        return {
          exitCode: await this.#coldAttach(threadId, attachOptions),
          warm: false,
        };
      }
      return { exitCode: attached.exitCode, warm: true };
    } catch {
      try {
        await this.#run(["kill-session", "-t", `=${name}`]);
      } catch {
        // The cold PTY fallback remains usable even if tmux itself disappeared.
      }
      return {
        exitCode: await this.#coldAttach(threadId, attachOptions),
        warm: false,
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return await this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      await Promise.allSettled(this.#starting.values());
      if (this.#available === true) await this.#run(["kill-server"]);
      if (this.#ownsSocketFile && process.getuid) {
        const socketPath = join(
          this.#env.TMUX_TMPDIR ?? "/tmp",
          `tmux-${process.getuid()}`,
          this.#socketName,
        );
        await unlink(socketPath).catch(() => undefined);
      }
      this.#available = false;
      this.#configured = false;
    })();
    return await this.#disposePromise;
  }

  async #run(args: string[], env = this.#env): Promise<TmuxCommandResult> {
    return await this.#runTmux(this.#tmuxCommand, [...this.baseArgs, ...args], env);
  }

  async #hasSession(name: string): Promise<boolean> {
    const result = await this.#run(["has-session", "-t", `=${name}`]);
    return result.exitCode === 0;
  }

  async #ensureSession(threadId: string, options: WarmAttachOptions): Promise<void> {
    const name = tmuxSessionName(threadId);
    const existing = this.#starting.get(name);
    if (existing) return await existing;

    const starting = this.#startSession(threadId, name, options).finally(() => {
      this.#starting.delete(name);
    });
    this.#starting.set(name, starting);
    return await starting;
  }

  async #startSession(
    threadId: string,
    name: string,
    options: WarmAttachOptions,
  ): Promise<void> {
    if (this.#disposed) throw new Error("The warm native TUI manager is closed");
    if (!(await this.#hasSession(name))) {
      const cwd = options.cwd ?? process.cwd();
      const command = options.codexCommand ?? this.#codexCommand;
      const result = await this.#run(
        [
          "new-session",
          "-d",
          "-s",
          name,
          "-c",
          cwd,
          "-x",
          String(Math.max(1, process.stdout.columns ?? 120)),
          "-y",
          String(Math.max(1, process.stdout.rows ?? 40)),
          "--",
          command,
          ...buildAttachArgs(
            threadId,
            options.dangerouslyBypassApprovalsAndSandbox,
          ),
        ],
        options.env ?? this.#env,
      );
      if (result.exitCode !== 0 && !(await this.#hasSession(name))) {
        throw new Error(result.stderr.trim() || "Could not start warm Codex TUI");
      }
    }

    if (this.#disposed) throw new Error("The warm native TUI manager is closed");

    await this.#configureServer();
    await this.#run([
      "set-option",
      "-t",
      `=${name}`,
      "@codex_agent_view_thread_id",
      threadId,
    ]);
    await this.#touch(name);
  }

  async #configureServer(): Promise<void> {
    if (this.#configured) return;
    const requiredCommands = [
      ["set-option", "-g", "status", "off"],
      ["set-option", "-g", "prefix", "None"],
      ["set-option", "-g", "prefix2", "None"],
      ["set-option", "-g", "focus-events", "on"],
      ["set-option", "-g", "mouse", "on"],
      ["set-option", "-g", "allow-rename", "off"],
      ["set-option", "-g", "automatic-rename", "off"],
      ["set-option", "-g", "history-limit", "20000"],
      ["set-option", "-g", "set-clipboard", "on"],
      ["bind-key", "-n", "C-b", "detach-client"],
      ["bind-key", "-n", "S-Left", "detach-client"],
    ];
    for (const command of requiredCommands) {
      const result = await this.#run(command);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `tmux configuration failed: ${command.join(" ")}`);
      }
    }
    // Extended key support was added in newer tmux versions; the Ctrl+B
    // fallback remains available if this optional setting is unavailable.
    await this.#run(["set-option", "-g", "extended-keys", "on"]);
    await this.#run(["set-option", "-g", "allow-passthrough", "on"]);
    this.#configured = true;
  }

  async #touch(name: string): Promise<void> {
    await this.#run([
      "set-option",
      "-t",
      `=${name}`,
      TMUX_LAST_USED_OPTION,
      String(Date.now()),
    ]);
  }

  async #prune(excludedName: string): Promise<void> {
    const result = await this.#run([
      "list-sessions",
      "-F",
      `#{session_name}\t#{${TMUX_LAST_USED_OPTION}}\t#{session_attached}`,
    ]);
    if (result.exitCode !== 0) return;
    const sessions = parseSessionRows(result.stdout);
    let excess = sessions.length - this.#maxWarmSessions;
    if (excess <= 0) return;
    const candidates = sessions
      .filter((session) => session.name !== excludedName && !session.attached)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const candidate of candidates) {
      if (excess <= 0) break;
      await this.#run(["kill-session", "-t", `=${candidate.name}`]);
      excess -= 1;
    }
  }
}
