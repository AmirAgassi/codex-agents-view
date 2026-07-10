# Codex Agents View

This was a 4-shot slop project I made for Codex to replicate Claude Code's agents view (see https://code.claude.com/docs/en/agent-view) and better utilize my new Codex plan at work after 5.6 Sol dropped. I'm pretty happy with how it turned out, all things considered.

A keyboard-first terminal dashboard for persistent Codex sessions that opens every chat in the native Codex TUI.
It uses [Codex App Server](https://developers.openai.com/codex/app-server) directly, so sessions continue while the dashboard is closed and
pending approvals are replayed when it reconnects.


This is an unofficial community project and is not affiliated with or endorsed by OpenAI or Anthropic.

## What works

- Sessions grouped into pinned, awaiting input, working, and completed
- Live turn, tool, plan, diff, output, and status events
- Dispatch from the dashboard with isolated Git worktrees by default
- Enter the installed native Codex TUI with its complete history, slash commands, attachments, modes, approvals, and future features intact
- Preload active or pinned native chats and retain up to three warm TUIs so MCP servers initialize once
- Detach from a native chat while its turn keeps running, then open or manage another session
- Resume idle/cold sessions before following up, or steer an active turn in place
- Answer `request_user_input` questions and command, file, or permission approvals
- Interrupt, rename, pin, archive, refresh, and reopen sessions
- Attach to the native Codex TUI and return to the dashboard when it exits
- Current-project and all-project views with bounded rendering for large histories

## Requirements

- macOS or Linux
- Node.js 22 or newer
- Codex CLI with `codex app-server daemon` support (developed against `0.144.0`)
- An existing Codex login
- tmux for warm native-chat switching (optional; the transparent PTY fallback still works without it)

## Install

```bash
git clone https://github.com/AmirAgassi/codex-agents-view.git
cd codex-agents-view
npm install
npm run build
npm link
```

Then open the dashboard for the current project:

```bash
cd /path/to/project
codex-agents
```

Or choose the project explicitly:

```bash
codex-agents -C /path/to/project
codex-agents --all
```

Run `codex-agents --help` for model, approval, sandbox, and direct-checkout options.
Agents View starts the managed local App Server daemon automatically.

To skip all approvals and run without a sandbox in both the dashboard and native Codex TUI:

```bash
codex-agents --dangerously-bypass-approvals-and-sandbox
```

This grants Codex full access to your machine. Use it only in an environment you trust.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k`, `↑` / `↓` | Move between sessions |
| `→` / `Enter` | Open the session in the native Codex TUI |
| `Shift+←` / `Ctrl+B` | Detach from the native chat and return (used inside Codex) |
| `v` | Peek at recent activity |
| `n` | Dispatch a new session |
| `Space` | Reply or answer a pending question |
| `a` / `s` | Allow once / allow for the session |
| `d` / `c` | Decline / cancel a request |
| `x` | Interrupt the active turn |
| `e` | Rename the session |
| `z` | Archive the session |
| `p` | Pin or unpin the session |
| `o` | Open the session in native Codex |
| `r` | Refresh |
| `?` | Show all shortcuts |
| `q` / `Ctrl+C` | Exit the dashboard; agents keep running |

Once attached, the child process is the regular Codex TUI—not a reimplementation. With tmux
available, Agents View parks that exact TUI on detach, including its screen, draft, modal, scroll
position, MCP connections, and App Server subscription. Reopening it attaches to the existing
process instead of running `codex resume` again. Agents View preloads active or pinned sessions,
warms other chats on their first open, and evicts older detached clients at a three-TUI cap.

Press `Shift+←` or `Ctrl+B` to return to Agents View without interrupting the daemon-owned turn.
Apart from these dedicated detach shortcuts, native keyboard behavior is unchanged. Plain `←`
remains Codex's normal cursor key, and Codex's own `Ctrl+C`, `/quit`, and `/exit` behavior passes
through unchanged. Exiting Agents View cleans up the warm TUI clients; daemon-owned agents continue.

## Worktrees

New tasks in Git repositories start from committed `HEAD` in detached worktrees under:

```text
~/.codex/agent-view/worktrees/<repository>/<task>-<id>
```

This prevents concurrent sessions from editing the same checkout. Uncommitted changes in the source
checkout are intentionally not copied. Use `--direct` when a task must work in the current checkout.

Worktrees are not deleted automatically. After preserving or discarding their changes, remove them
from the source repository with `git worktree remove <path>`.

## Local state

Codex Agents View stores only its own metadata:

```text
~/.codex/agent-view/preferences.json  # pins and ordering
~/.codex/agent-view/workspaces/      # concurrency-safe per-thread worktree mappings
```

It never writes Codex's SQLite database or rollout files directly. Conversation history and live
events come through the App Server protocol.

## Architecture

```text
Ink terminal UI
  -> Codex JSON-RPC client
     -> WebSocket over `codex app-server proxy`
        -> persistent `codex app-server daemon`
           -> Codex threads and turns
  -> native terminal handoff
     -> private bounded tmux pool
        -> warm official `codex resume --remote unix:// <thread>` TUIs
     -> transparent node-pty fallback when tmux is unavailable
```

The dashboard reconnects with `thread/resume`, which restores event subscriptions and replays
pending approval/input requests. A daemon process crash cannot restore an in-flight turn; persisted
conversation history remains resumable.

## Development

```bash
npm run dev -- -C /path/to/project
npm run typecheck
npm test
npm run build
npm run smoke
npm run check
```

The protocol surface is experimental and can change between Codex releases. Run the test suite and
the real-daemon smoke test after upgrading Codex.
