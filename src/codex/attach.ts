import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty";

export const DETACH_CONTROL_B = "\u0002";
export const DETACH_SHIFT_LEFT = "\u001b[1;2D";

const ESCAPE_BYTE = 0x1b;
const CSI_OPEN_BYTE = 0x5b;
const CONTROL_B_BYTE = 0x02;
const MAX_PENDING_ESCAPE_BYTES = 64;
const INPUT_ESCAPE_TIMEOUT_MS = 25;

const TERMINAL_RESET = [
  "\u001b[?2026l",
  "\u001b[<u",
  "\u001b[>4;0m",
  "\u001b[?2004l",
  "\u001b[?1004l",
  "\u001b[0m",
  "\u001b[?25h",
  "\u001b]0;\u0007",
  "\u001b[?1049l",
].join("");

export function restoreTerminal(): void {
  process.stdout.write(TERMINAL_RESET);
}

const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
const SIGNAL_NUMBERS: Record<(typeof FORWARDED_SIGNALS)[number], number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
};

const require = createRequire(import.meta.url);

function ensurePtyHelperExecutable(): void {
  if (process.platform === "win32") return;
  const packageRoot = resolve(dirname(require.resolve("node-pty")), "..");
  const candidates = [
    join(packageRoot, "build", "Release", "spawn-helper"),
    join(packageRoot, "build", "Debug", "spawn-helper"),
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  for (const candidate of candidates) {
    try {
      chmodSync(candidate, 0o755);
      return;
    } catch {
      // Try the next location used by node-pty's native binding loader.
    }
  }
}

export function buildAttachArgs(
  threadId: string,
  dangerouslyBypassApprovalsAndSandbox = false,
): string[] {
  return [
    "resume",
    ...(dangerouslyBypassApprovalsAndSandbox
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : []),
    "--remote",
    "unix://",
    threadId,
  ];
}

function isPressOrRepeat(eventType: string | undefined): boolean {
  return eventType === undefined || eventType === "1" || eventType === "2";
}

function hasOnlyModifier(encoded: string, requiredBits: number): boolean {
  const value = Number(encoded);
  if (!Number.isSafeInteger(value) || value < 1) return false;
  // Caps Lock and Num Lock do not change shortcut identity.
  const shortcutModifierMask = 0b11_1111;
  return ((value - 1) & shortcutModifierMask) === requiredBits;
}

function isDetachEscapeSequence(sequence: Buffer): boolean {
  const value = sequence.toString("ascii");
  const cursor = /^\u001b\[1;(\d+)(?::([123]))?D$/u.exec(value);
  if (cursor) {
    return hasOnlyModifier(cursor[1]!, 0b000001) && isPressOrRepeat(cursor[2]);
  }

  const csiU = /^\u001b\[(\d+(?::\d*)*);(\d+)(?::([123]))?(?:;\d+(?::\d+)*)?u$/u.exec(value);
  if (!csiU || !hasOnlyModifier(csiU[2]!, 0b000100) || !isPressOrRepeat(csiU[3])) {
    return false;
  }
  const keyCodes = csiU[1]!.split(":");
  const primaryKey = Number(keyCodes[0]);
  const baseLayoutKey = keyCodes.length >= 3 && keyCodes[2] !== ""
    ? Number(keyCodes[2])
    : undefined;
  return primaryKey === 98 || baseLayoutKey === 98;
}

export function isDetachInput(data: Buffer | string): boolean {
  return new DetachInputParser().push(data).detach;
}

export interface DetachInputResult {
  detach: boolean;
  passthrough: Buffer;
}

/**
 * Parses terminal input without changing non-detach bytes. An incomplete CSI
 * sequence is retained so Kitty keyboard events can be recognized even when a
 * stream read splits the escape sequence.
 */
export class DetachInputParser {
  #pending = Buffer.alloc(0);

  get hasPending(): boolean {
    return this.#pending.length > 0;
  }

  push(data: Buffer | string): DetachInputResult {
    const incoming = typeof data === "string" ? Buffer.from(data) : data;
    const combined = this.#pending.length > 0
      ? Buffer.concat([this.#pending, incoming])
      : incoming;
    this.#pending = Buffer.alloc(0);
    let segmentStart = 0;
    let index = 0;

    while (index < combined.length) {
      if (combined[index] === CONTROL_B_BYTE) {
        return {
          detach: true,
          passthrough: Buffer.from(combined.subarray(segmentStart, index)),
        };
      }

      if (combined[index] !== ESCAPE_BYTE) {
        index += 1;
        continue;
      }

      if (index + 1 >= combined.length) {
        this.#pending = Buffer.from(combined.subarray(index));
        return {
          detach: false,
          passthrough: Buffer.from(combined.subarray(segmentStart, index)),
        };
      }
      if (combined[index + 1] !== CSI_OPEN_BYTE) {
        index += 1;
        continue;
      }

      let finalIndex = -1;
      for (let cursor = index + 2; cursor < combined.length; cursor += 1) {
        const byte = combined[cursor]!;
        if (byte >= 0x40 && byte <= 0x7e) {
          finalIndex = cursor;
          break;
        }
      }
      if (finalIndex === -1) {
        if (combined.length - index > MAX_PENDING_ESCAPE_BYTES) {
          index += 1;
          continue;
        }
        this.#pending = Buffer.from(combined.subarray(index));
        return {
          detach: false,
          passthrough: Buffer.from(combined.subarray(segmentStart, index)),
        };
      }

      const sequence = combined.subarray(index, finalIndex + 1);
      if (isDetachEscapeSequence(sequence)) {
        return {
          detach: true,
          passthrough: Buffer.from(combined.subarray(segmentStart, index)),
        };
      }
      index = finalIndex + 1;
    }

    return {
      detach: false,
      passthrough: Buffer.from(combined.subarray(segmentStart)),
    };
  }

  flush(): Buffer {
    const pending = this.#pending;
    this.#pending = Buffer.alloc(0);
    return pending;
  }
}

function ptyEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

/**
 * Hand the current terminal to the official Codex TUI through a transparent
 * pseudoterminal. Every byte is passed through unchanged except the dedicated
 * detach shortcuts. Detaching kills only this UI client; the daemon-owned
 * thread and its in-flight turn continue running in the background.
 */
export async function attachToThread(
  threadId: string,
  options: {
    codexCommand?: string;
    cwd?: string;
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  let child: IPty;

  try {
    ensurePtyHelperExecutable();
    child = spawnPty(
      options.codexCommand ?? "codex",
      buildAttachArgs(threadId, options.dangerouslyBypassApprovalsAndSandbox),
      {
        name: process.env.TERM && process.env.TERM !== "dumb"
          ? process.env.TERM
          : "xterm-256color",
        cols: Math.max(1, stdout.columns ?? 80),
        rows: Math.max(1, stdout.rows ?? 24),
        cwd: options.cwd,
        env: ptyEnvironment(options.env ?? process.env),
      },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  return await new Promise<number>((resolve) => {
    let detached = false;
    let settled = false;
    let detachTimer: NodeJS.Timeout | undefined;
    let inputFlushTimer: NodeJS.Timeout | undefined;
    let dataSubscription: IDisposable | undefined;
    let exitSubscription: IDisposable | undefined;
    const inputParser = new DetachInputParser();
    const signalHandlers = new Map<NodeJS.Signals, () => void>();

    const resetTerminal = (): void => {
      restoreTerminal();
    };

    const cleanup = (): void => {
      stdin.off("data", onInput);
      stdout.off("resize", onResize);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      if (detachTimer) clearTimeout(detachTimer);
      if (inputFlushTimer) clearTimeout(inputFlushTimer);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
      resetTerminal();
    };

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(detached ? 0 : exitCode);
    };

    const detach = (): void => {
      if (detached) return;
      detached = true;
      if (inputFlushTimer) clearTimeout(inputFlushTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        finish(0);
        return;
      }
      // node-pty should report an exit after SIGKILL. Do not leave the
      // supervisor stuck if a platform-specific helper fails to deliver it.
      detachTimer = setTimeout(() => finish(0), 1_500);
    };

    function onInput(data: Buffer | string): void {
      if (inputFlushTimer) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = undefined;
      }
      const parsed = inputParser.push(data);
      if (parsed.passthrough.length > 0) child.write(parsed.passthrough);
      if (parsed.detach) {
        detach();
        return;
      }
      if (inputParser.hasPending) {
        inputFlushTimer = setTimeout(() => {
          inputFlushTimer = undefined;
          const pending = inputParser.flush();
          if (!settled && !detached && pending.length > 0) child.write(pending);
        }, INPUT_ESCAPE_TIMEOUT_MS);
      }
    }

    function onResize(): void {
      try {
        child.resize(
          Math.max(1, stdout.columns ?? 80),
          Math.max(1, stdout.rows ?? 24),
        );
      } catch {
        // A resize racing with process exit is harmless.
      }
    }

    function onSignal(signal: (typeof FORWARDED_SIGNALS)[number]): void {
      if (settled) return;
      settled = true;
      try {
        child.kill(signal);
      } finally {
        cleanup();
        // Re-raise after removing our handlers so callers and service managers
        // observe the original signal instead of a dashboard restart.
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(128 + SIGNAL_NUMBERS[signal]);
        }
      }
    }

    dataSubscription = child.onData((data) => stdout.write(data));
    exitSubscription = child.onExit(({ exitCode, signal }) => {
      finish(signal === undefined || signal === 0 ? exitCode : 128 + signal);
    });
    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => onSignal(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onInput);
    stdout.on("resize", onResize);
  });
}
