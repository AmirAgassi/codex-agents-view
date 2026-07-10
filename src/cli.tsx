#!/usr/bin/env node

import { render, type Instance } from "ink";

import { AgentViewApp, type AppOutcome } from "./app.js";
import { HELP_TEXT, VERSION, parseCliOptions, type CliOptions } from "./cli-options.js";
import {
  CodexClient,
  detectCodexVersion,
  restoreTerminal,
  WarmNativeTuiManager,
} from "./codex/index.js";
import { loadPreferences } from "./state/preferences.js";

const SHUTDOWN_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
const SHUTDOWN_SIGNAL_NUMBERS: Record<(typeof SHUTDOWN_SIGNALS)[number], number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
};

function installSignalCleanup(
  client: CodexClient,
  nativeTuis: WarmNativeTuiManager,
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  let handling = false;
  const removeHandlers = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  const terminate = (signal: (typeof SHUTDOWN_SIGNALS)[number]): void => {
    removeHandlers();
    restoreTerminal();
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(128 + SHUTDOWN_SIGNAL_NUMBERS[signal]);
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = (): void => {
      if (handling) return;
      handling = true;
      client.close();
      const fallback = setTimeout(() => terminate(signal), 1_500);
      void nativeTuis.dispose().finally(() => {
        clearTimeout(fallback);
        terminate(signal);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return removeHandlers;
}

async function runDashboard(
  options: CliOptions,
  codexVersion: string,
  client: CodexClient,
  nativeTuis: WarmNativeTuiManager,
  initialSelectedThreadId?: string,
): Promise<AppOutcome> {
  const preferences = await loadPreferences();

  let instance: Instance | undefined;
  let outcome: AppOutcome = { type: "exit" };
  let settled = false;
  const onDone = (next: AppOutcome): void => {
    if (settled) return;
    settled = true;
    outcome = next;
    instance?.unmount();
  };

  instance = render(
    <AgentViewApp
      client={client}
      options={options}
      initialPreferences={preferences}
      initialSelectedThreadId={initialSelectedThreadId}
      codexVersion={codexVersion}
      onDone={onDone}
      onWarmThreads={(targets) => {
        void nativeTuis.prewarm(targets);
      }}
    />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  );

  try {
    await instance.waitUntilExit();
    return outcome;
  } finally {
    instance.unmount();
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP_TEXT}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("codex-agents requires an interactive terminal");
  }

  const codexVersion = await detectCodexVersion();
  const client = new CodexClient({ cwd: options.cwd });
  const nativeTuis = new WarmNativeTuiManager({
    dangerouslyBypassApprovalsAndSandbox:
      options.dangerouslyBypassApprovalsAndSandbox,
  });
  const removeSignalHandlers = installSignalCleanup(client, nativeTuis);
  try {
    let running = true;
    let selectedThreadId: string | undefined;
    while (running) {
      const outcome = await runDashboard(
        options,
        codexVersion,
        client,
        nativeTuis,
        selectedThreadId,
      );

      if (outcome.type === "exit") {
        running = false;
        continue;
      }

      selectedThreadId = outcome.threadId;
      try {
        const result = await nativeTuis.attach(outcome.threadId, { cwd: outcome.cwd });
        if (result.exitCode !== 0) {
          process.stderr.write(`Codex attach exited with status ${result.exitCode}\n`);
        }
      } catch (error) {
        process.stderr.write(
          `Could not open native Codex: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        void client.unsubscribeThread(outcome.threadId).catch(() => undefined);
      }
    }
  } finally {
    removeSignalHandlers();
    client.close();
    await nativeTuis.dispose();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`codex-agents: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
