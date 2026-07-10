import { afterEach, describe, expect, it, vi } from "vitest";

import {
  tmuxSessionName,
  tmuxSocketName,
  WarmNativeTuiManager,
  type TmuxRunner,
} from "../src/codex/warm-tui.js";

interface FakeSession {
  attached: boolean;
  lastUsed: number;
}

class FakeTmux {
  readonly calls: string[][] = [];
  readonly attachCalls: string[][] = [];
  readonly sessions = new Map<string, FakeSession>();
  available = true;
  attachExitCode = 0;

  readonly run: TmuxRunner = async (_command, args) => {
    const command = args.slice(args.indexOf("/dev/null") + 1);
    this.calls.push(command);
    const operation = command[0];
    if (operation === "-V") {
      return this.result(this.available ? 0 : 127, this.available ? "tmux 3.5a\n" : "");
    }
    if (operation === "has-session") {
      return this.result(this.sessions.has(this.target(command)) ? 0 : 1);
    }
    if (operation === "new-session") {
      const name = command[command.indexOf("-s") + 1]!;
      this.sessions.set(name, { attached: false, lastUsed: 0 });
      return this.result(0);
    }
    if (operation === "set-option" && command.includes("@codex_agent_view_last_used")) {
      const session = this.sessions.get(this.target(command));
      if (session) session.lastUsed = Number(command.at(-1)) || 0;
      return this.result(0);
    }
    if (operation === "list-sessions") {
      const stdout = [...this.sessions.entries()]
        .map(([name, session]) =>
          `${name}\t${session.lastUsed}\t${session.attached ? 1 : 0}`)
        .join("\n");
      return this.result(0, stdout);
    }
    if (operation === "kill-session") {
      this.sessions.delete(this.target(command));
      return this.result(0);
    }
    if (operation === "kill-server") {
      this.sessions.clear();
      return this.result(0);
    }
    return this.result(0);
  };

  readonly attach: TmuxRunner = async (_command, args) => {
    const command = args.slice(args.indexOf("/dev/null") + 1);
    this.attachCalls.push(command);
    return this.result(this.attachExitCode);
  };

  count(operation: string): number {
    return this.calls.filter((call) => call[0] === operation).length;
  }

  private target(command: string[]): string {
    const target = command[command.indexOf("-t") + 1] ?? "";
    return target.replace(/^=/u, "").replace(/:$/u, "");
  }

  private result(exitCode: number, stdout = "", stderr = "") {
    return { exitCode, stdout, stderr };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warm native Codex TUI manager", () => {
  it("uses invocation-private sockets and stable hashed session names", () => {
    expect(tmuxSocketName("/tmp/codex", 100)).not.toBe(tmuxSocketName("/tmp/codex", 101));
    expect(tmuxSocketName("/tmp/codex", 100)).toContain("100");
    expect(tmuxSessionName("thread-a")).toBe(tmuxSessionName("thread-a"));
    expect(tmuxSessionName("thread-a")).not.toBe(tmuxSessionName("thread-b"));
  });

  it("prewarms once and reattaches the same native TUI without respawning", async () => {
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });

    await manager.warm({ threadId: "thread-a", cwd: "/tmp" });
    await manager.attach("thread-a", { cwd: "/tmp" });
    await manager.attach("thread-a", { cwd: "/tmp" });

    expect(tmux.count("new-session")).toBe(1);
    expect(tmux.attachCalls).toHaveLength(2);
    expect(tmux.count("resize-window")).toBe(2);
    const configured = tmux.calls.map((call) => call.join(" "));
    expect(configured).toContain("bind-key -n C-b detach-client");
    expect(configured).toContain("bind-key -n S-Left detach-client");
    expect(configured).toContain("set-option -g mouse on");
    expect(configured.some((call) => call.includes("escape-time"))).toBe(false);
  });

  it("passes skip-permissions mode to warm and cold native TUIs", async () => {
    const warmTmux = new FakeTmux();
    const warmManager = new WarmNativeTuiManager({
      socketName: "warm-test",
      dangerouslyBypassApprovalsAndSandbox: true,
      runTmux: warmTmux.run,
      attachTmux: warmTmux.attach,
    });

    await warmManager.warm({ threadId: "thread-a", cwd: "/tmp" });
    expect(warmTmux.calls.find((call) => call[0] === "new-session")).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );

    const coldTmux = new FakeTmux();
    coldTmux.available = false;
    const coldAttach = vi.fn().mockResolvedValue(0);
    const coldManager = new WarmNativeTuiManager({
      socketName: "cold-test",
      dangerouslyBypassApprovalsAndSandbox: true,
      runTmux: coldTmux.run,
      attachTmux: coldTmux.attach,
      coldAttach,
    });

    await coldManager.attach("thread-b", { cwd: "/tmp" });
    expect(coldAttach).toHaveBeenCalledWith(
      "thread-b",
      expect.objectContaining({ dangerouslyBypassApprovalsAndSandbox: true }),
    );
  });

  it("coalesces concurrent starts for the same thread", async () => {
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });

    await Promise.all([
      manager.warm({ threadId: "thread-a", cwd: "/tmp" }),
      manager.warm({ threadId: "thread-a", cwd: "/tmp" }),
      manager.warm({ threadId: "thread-a", cwd: "/tmp" }),
    ]);
    expect(tmux.count("new-session")).toBe(1);
  });

  it("recreates a native TUI after it exits", async () => {
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });

    await manager.warm({ threadId: "thread-a", cwd: "/tmp" });
    tmux.sessions.delete(tmuxSessionName("thread-a"));
    await manager.warm({ threadId: "thread-a", cwd: "/tmp" });
    expect(tmux.count("new-session")).toBe(2);
  });

  it("falls back to the transparent PTY when tmux is unavailable", async () => {
    const tmux = new FakeTmux();
    tmux.available = false;
    const coldAttach = vi.fn().mockResolvedValue(9);
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: tmux.attach,
      coldAttach,
    });

    await expect(manager.attach("thread-a", { cwd: "/tmp" })).resolves.toEqual({
      exitCode: 9,
      warm: false,
    });
    expect(coldAttach).toHaveBeenCalledOnce();
    expect(tmux.count("new-session")).toBe(0);
  });

  it("falls back and closes the warm session when tmux attach fails", async () => {
    const tmux = new FakeTmux();
    tmux.attachExitCode = 1;
    const coldAttach = vi.fn().mockResolvedValue(0);
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: tmux.attach,
      coldAttach,
    });

    await expect(manager.attach("thread-a", { cwd: "/tmp" })).resolves.toEqual({
      exitCode: 0,
      warm: false,
    });
    expect(coldAttach).toHaveBeenCalledOnce();
    expect(tmux.sessions.has(tmuxSessionName("thread-a"))).toBe(false);
  });

  it("falls back when the tmux client cannot be spawned", async () => {
    const tmux = new FakeTmux();
    const coldAttach = vi.fn().mockResolvedValue(0);
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: async () => {
        throw new Error("spawn failed");
      },
      coldAttach,
    });

    await expect(manager.attach("thread-a", { cwd: "/tmp" })).resolves.toEqual({
      exitCode: 0,
      warm: false,
    });
    expect(coldAttach).toHaveBeenCalledOnce();
    expect(tmux.sessions.has(tmuxSessionName("thread-a"))).toBe(false);
  });

  it("evicts the least-recent detached session and never the selected one", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300);
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      maxWarmSessions: 2,
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });

    await manager.warm({ threadId: "thread-a", cwd: "/tmp" });
    await manager.warm({ threadId: "thread-b", cwd: "/tmp" });
    await manager.warm({ threadId: "thread-c", cwd: "/tmp" });

    expect(tmux.sessions.has(tmuxSessionName("thread-a"))).toBe(false);
    expect(tmux.sessions.has(tmuxSessionName("thread-b"))).toBe(true);
    expect(tmux.sessions.has(tmuxSessionName("thread-c"))).toBe(true);
  });

  it("temporarily exceeds the cap instead of evicting an attached session", async () => {
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      maxWarmSessions: 1,
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });
    await manager.warm({ threadId: "thread-a", cwd: "/tmp" });
    tmux.sessions.get(tmuxSessionName("thread-a"))!.attached = true;

    await manager.warm({ threadId: "thread-b", cwd: "/tmp" });
    expect(tmux.sessions.has(tmuxSessionName("thread-a"))).toBe(true);
    expect(tmux.sessions.has(tmuxSessionName("thread-b"))).toBe(true);
  });

  it("bounds eager prewarming at the configured capacity", async () => {
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      maxWarmSessions: 2,
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });
    await manager.prewarm([
      { threadId: "thread-a", cwd: "/tmp" },
      { threadId: "thread-b", cwd: "/tmp" },
      { threadId: "thread-c", cwd: "/tmp" },
    ]);

    expect(tmux.count("new-session")).toBe(2);
    expect(tmux.sessions.size).toBe(2);
  });

  it("disposes the owned tmux server exactly once", async () => {
    const tmux = new FakeTmux();
    const manager = new WarmNativeTuiManager({
      socketName: "test",
      runTmux: tmux.run,
      attachTmux: tmux.attach,
    });
    await manager.warm({ threadId: "thread-a", cwd: "/tmp" });

    await Promise.all([manager.dispose(), manager.dispose()]);
    expect(tmux.count("kill-server")).toBe(1);
    await expect(manager.warm({ threadId: "thread-b", cwd: "/tmp" })).resolves.toBe(false);
  });
});
