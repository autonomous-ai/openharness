# Background commands a harness still runs (issue #4194, second ask)

Date: 2026-11-12. Status: approved for planning (the maintainer delegated the open calls to the main session; each is
marked "our call" below).

## Why

A harness reads `idle` as soon as its engine ends its turn, even when the turn started a background command (a build, a
test suite, a long `sleep`) that is still running. Callers then treat it as finished:

- the lamp device's script (the issue's reporter, Hermes in a sandbox) closes finished harnesses and tells the person
  "done" too soon;
- since #4201 (CLI 0.6.47) stopping a harness ends the engine's whole process tree, so an early close now kills the
  build it was waiting on;
- `services/agentCleanup.ts` closes an idle harness another agent started after `IDLE_CLOSE_MS` (30 min), with the same
  effect.

The engines themselves already treat such work as unfinished: Claude Code and Hermes tell the agent when a background
command ends, and the agent usually starts a new turn to read it. So "idle with background commands running" is not done.

## Goal

`harness show`, `harness wait` and `harness watch` (and their `--json`) say how many background commands a harness
still has running when it reads idle, and treat a harness with any running as not finished yet. The cleanup's idle close
and `harness close` without `--now` do not close one that has any running (the cleanup only up to a ceiling, below).

## Non-goals

- The issue's first ask (a hook mode for sandboxed agents). A separate feature, in another session.
- Showing the count in Desktop, mobile or web. No frame field, no app change.
- Naming or listing the commands. A count is what was asked; command text is personal content and stays out.
- Killing, adopting or waiting on the commands from Harness.
- Changing Desktop's or the phone's Close (pane, tab) or "Stop after it finishes" (`after_task`). Those are a person's
  own choice, made while looking at the pane; `agent_close`'s `idle` and `after_task` modes keep today's rule.

## Anti-goals

- Saying `0` when Harness cannot know. Unknown is `null`, never `0`: a `0` that is wrong is exactly the early close
  this feature exists to stop.
- Counting an engine's own long-lived helpers (MCP servers, LSPs, plugin helpers, caffeinate, status-line commands,
  hooks) as background commands. A harness that never ran a background command must read `0`, or every Claude Code
  harness would look busy forever and the cleanup would never close one.
- A new poll or a per-frame count. The count is read on demand, only when something asks.

## What "background command" means, per engine (our call)

Each engine's own record is preferred where it keeps one; the process tree is used only where the commands really run
under the engine, and only the processes that engine's command tool starts are counted.

| Engine | Source | Counted |
|---|---|---|
| Hermes (any version, 0.22+ gateway included) | Hermes' own background-process checkpoint, `processes.json` in the Hermes home that holds the session (the profile's home for a profile session). Hermes rewrites it on every background spawn and every exit (`tools/process_registry.py` `_write_checkpoint`, `CHECKPOINT_PATH = get_hermes_home() / "processes.json"`) and lists only processes still running. | Entries whose `session_key` is the harness's Hermes session id or one of its ancestors (see below). For Hermes' CLI and its TUI gateway the session key is the session's id (`cli.py` `set_current_session_key(self.session_id)`, `tui_gateway/server.py` `session["session_key"]`). |
| Claude Code | The engine's process tree. Claude Code runs every Bash tool command, foreground or `run_in_background`, as a direct child shell that sources its shell snapshot: `/bin/zsh -c source '<config>/shell-snapshots/snapshot-zsh-….sh' … && eval '…'` (seen on this machine, 2026-11-12). | Direct children of the engine process whose argv is a command shell (`-c`) naming `/shell-snapshots/snapshot-`. MCP servers, `caffeinate` and other helpers are direct children too and are not shells of that form. |
| Codex and OpenClaw (any mode) | none for now (our call, after the planner's probe) | `null`. Their exec tools run `<shell> -lc <command>` / `<shell> -c <command>`, and a shell given one simple command, or a list ending in one (`cd x && npm run dev`), replaces itself with it (zsh 5.9, bash 3.2, sh, probed 2026-11-12), so no shell row is left to count and the command's own argv cannot be told from an MCP server. Counting the shells that happen to survive would undercount; telling a command from a helper by its terminal or session is a follow-up. Claude Code is unaffected: its command ends in `&& pwd -P >| …`, which keeps the shell alive. |
| Every other engine (OpenCode, agy, Pi, Kilo, Devin, cloud harnesses, …) | none | `null`. |
| Any process-tree engine on Windows | `engineDescendants` returns nothing on win32 by design | `null`. Hermes' file works on every platform. |

At idle, a foreground command has ended, so every live command shell of the forms above is a background command. A
command that daemonizes away from the engine (`nohup … &` whose shell exits, `setsid`, a double fork) re-parents to
init/launchd and is not seen: the count covers what the engine itself still runs, as the engine's own tools do. Docs say
so.

Claude Code's shape was confirmed on Claude Code 2.1.322 with a real `run_in_background` command and is recorded as
the test fixture.

Hermes, our calls:

- The file is trusted as written: its entries are host pids that Harness cannot check from outside a pid namespace (the
  reporter's sandbox), and after a gateway crash the processes Hermes started keep running (Hermes adopts them back
  from this file on restart), so the file is the better truth than a pid check. A stale entry is bounded by the
  cleanup's ceiling below.
- When Hermes compresses a conversation it carries on under a new session id whose `parent_session_id` (Hermes'
  `sessions` table) is the old one, and a process started before keeps the old id (Hermes' own TUI claims it through that
  chain, `tui_gateway/server.py` `_session_owns_notification_event`). So the count matches the harness's session id and
  its ancestors, walked through `parent_session_id` in the same `state.db` Harness already reads, at most 32 deep.
- Entries with an empty `session_key` cannot be tied to a session and are not counted.
- No file is `null`, not `0`: Hermes writes the file at its first background process and rewrites it (to `[]` when none
  run) from then on, so a missing file says nothing, and an older Hermes that never writes it can never read a wrong
  `0`. A file whose entries lack the `session_key` field (an older format) is `null`. So is an unresolvable home or
  session id, an unreadable or malformed file, or an unreadable `state.db`.
- The read is bounded: at most 1 MiB, at most 1,024 entries.

## How it is read (our call)

- On demand, in the reply to `agent_close` `inspect`, the request `show`, `wait` and `watch` already send when the frame
  does not read `working` (`lib/closeAgentService.ts`). The reply gains `backgroundCommands: number | null`, computed
  only when the activity it answers is `idle`; otherwise absent. An older daemon omits it, which the client reads as
  `null`.
- No frame field, no new poll, no app change, no backend change.
- The process-tree read reuses `processRows()` (one `ps`, concurrent reads shared). Cost is measured before and after
  on the `watch` loop of an idle Claude Code harness; `ps` costs 30-40 ms on this Mac. If a look happens more often than
  every few seconds, the count is cached per agent for a short bounded time; the planner picks it from the measured
  look cadence.

## What callers see

- `harness show <h>`: when it reads idle and N > 0, one line: `N background commands running` (`1 background command
  running`). Nothing for `0` or `null`. Its next-step hint does not offer to close while N > 0; it offers to wait.
  `--json` carries `backgroundCommands` (number or `null`) whenever it reads idle.
- `harness wait <h>`: does not settle while the harness reads idle with N > 0; it settles once N is `0` or `null`, by
  its existing rule. Its exit codes and timeout are unchanged (a timeout while N > 0 is a timeout, so a dev server left
  running ends `wait` at its timeout, as today for a harness that never goes idle). Its timeout line says the count
  (`… timeout · 2 background commands running; …`) and `--json` carries `backgroundCommands`.
- `harness watch <h>`: when the harness reads idle with N > 0 it emits a `background` event (state `idle`, with
  `backgroundCommands: N`) instead of `done`, again each time N changes, and `done` once N is `0` or `null`. `--json`
  events carry `backgroundCommands`.
- `harness close <h>` without `--now`: it inspects first (new: today it sends the idle close directly); when the harness reads idle with N > 0 it refuses on
  the client, sends no close, says `N background commands running; --now closes anyway`, and exits as it does for a
  harness that is not idle. `--now` is unchanged. A command that ends between the inspect and the refusal only costs a
  retry.
- The cleanup's idle close (`CoreApi.agents.closeStarted`, the cleanup's alone): a harness that reads idle with N > 0 is
  refused with `SESSION_NOT_IDLE` carrying `backgroundCommands: N`, and the cleanup asks again after `ASK_AGAIN_MS`, as
  for any harness that would not close, and logs one line (`left <name> open: N background commands running`). Ceiling (our call): once the harness has sat idle `BACKGROUND_CLOSE_MS`
  (2 hours) after its last answer, the cleanup closes it even with N > 0, and logs one line with the count. An agent
  often leaves a dev server or a watcher running on purpose, and a stale Hermes entry never ends; without a ceiling
  those harnesses, the ones costing most memory and CPU, would never be cleaned up. Two hours covers any build or test
  suite we have seen.
- Desktop and the phone are unchanged (non-goals).
- `null` never blocks anything: it behaves as today.

Copy follows docs/naming-system.md; the planner checks the exact words against it.

## Constraints

- Code standards in AGENTS.md: smallest change, red-then-green test at the layer where each behavior lives, no fixed
  sleeps, bounded reads.
- Per-engine knowledge lives in `cli/src/engines/<engine>/`; a pure dispatcher in `cli/src/lib/`; `closeAgentService`
  gets it as a dependency wired in `core/main.ts` (wiring only). Swarm code untouched.
- No content or identifiers in logs: a refusal logs the count, never command text or session ids.
- `src/core/` and `src/services/` stay at 100% per-file coverage (`npm run test:core`), run locally once and recorded.
- Docs updated in the same pull request: `docs/cli.md` (show, wait, watch, close) and
  `docs/design/2026-10-11-agent-client.md` (show/wait and the cleanup's idle close), including what the count includes
  and excludes.
- Platforms: macOS and Linux for Claude Code; every platform for Hermes; Windows reads `null` for Claude Code.

## Left to the builder

- How the cleanup's ceiling reaches the core (for example a flag on `closeStarted`'s `idle`), as long as only the
  cleanup can use it.
- Exact module and type names, the short cache (if the measured cadence needs one), and how the Hermes home and session
  id are looked up from existing Hermes readers (`engines/hermes/home.ts` and its neighbours).
- The fake engine (`cli/e2e/harness/fakeEngine.mjs`) gains a background command the way Claude Code runs one, for the
  end-to-end check.

## Verification (for the plan)

- End to end on the local e2e harness (private tmux, fake engine, throwaway home): a fake Claude Code harness ends its
  turn with a background `sleep` running under a snapshot-style shell; `show --json` reads `backgroundCommands: 1`,
  `watch --json` emits `background` then `done` after the sleep ends, `close` without `--now` refuses, the cleanup
  close is refused before the ceiling and closes after it. With no background command it reads `0` and closes.
- Hermes: a fixture Hermes home with `processes.json` entries for two sessions and a compressed session's parent; the
  harness's session reads its own and its ancestor's entries, nothing of the other session; no file reads `null`.
- Real argv shape: Claude Code's, confirmed read-only on this Mac (no new login, no production backend), recorded as the
  fixture the counting tests use.
