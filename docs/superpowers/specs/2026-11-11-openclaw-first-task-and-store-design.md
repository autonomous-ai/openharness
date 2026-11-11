# OpenClaw: a first task that is never lost, and a store that is never silently wrong

Two OpenClaw faults seen on a lamp running `lamp-tasks` (2026-11-11), both in Harness:

1. **The first task is lost.** `harness new openclaw -- <task>` while the Gateway is still starting: the harness is
   created, OpenClaw never gets the task, and nothing says so.
2. **The agent says `idle` / "No turn yet" while OpenClaw works.** Harness reads an OpenClaw store that is not the one
   the Gateway writes.

Platforms: macOS, Linux, Windows (CLI daemon only; no client change).

## Why each happens

### 1. The first task

Harness hands a first task to OpenClaw as `openclaw tui --session harness-<agentId> --message <task>`
(`OPENCLAW_LAUNCH`, `firstPromptArgs`). OpenClaw 2026.11.2's TUI sends `--message` exactly once, right after its
first Gateway connection (`state.autoMessageSent` in `dist/tui-*.mjs`), and never again:

- a send the Gateway fails or times out (a Gateway choking at 700 MB took 158 s to start and stalled 18 s at a time)
  leaves one system line in the TUI's chat log;
- a send its admission check blocks leaves "initial message not sent — retry it after the session is ready".

Harness reads neither. Every later message reaches OpenClaw another way: typed into the pane through the session
input (`lib/sessionInput.ts`), confirmed only when the store shows the new user row, retried within its bound, and
failed out loud ("The agent did not accept the message…") when it never lands. The first task is the one message
without that confirmation.

### 2. The store

The Gateway writes every session row to `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite`. Harness finds
`stateDir` from the file the TUI holds open (`<stateDir>/state/openclaw.sqlite`, `lib/openclawStore.ts`), else
`OPENCLAW_STATE_DIR`, else `~/.openclaw`. That is the TUI's state folder, which is the Gateway's only when both run
with the same environment. On the lamp the Gateway runs under systemd with its own `OPENCLAW_STATE_DIR`; the TUI
Harness starts inherits harnessd's environment and opens `~/.openclaw`. Harness reads a store that never gets the
session, finds no rows for the key, and treats that as a session not yet begun: `idle`, "No turn yet", no error.

Two defects:

- **Silent:** a store with no rows for the key while the pane shows OpenClaw working is a fault, said nowhere.
- **The default is not OpenClaw's:** OpenClaw resolves its state folder as `OPENCLAW_STATE_DIR` (`~` expanded against
  the home below), else `<home>/.openclaw`, where home is `OPENCLAW_HOME` (`~` expanded) when set, else the OS home.
  Harness's default ignores `OPENCLAW_HOME`. It is used only where the TUI's open files cannot be read (Windows).

## Goals

- A first task given to an OpenClaw harness is typed into it at most once, once its Gateway answers, and confirmed
  like every later message.
- An OpenClaw harness whose store Harness cannot find says so, with what to do, instead of `idle`.
- Harness's default state folder is the one OpenClaw itself would use.

## Non-goals

- Finding the Gateway's state folder by itself (its process's open files, a Gateway RPC). The Gateway may run as
  another user (root under systemd on the lamp), whose files Harness cannot read. The named state tells the person to
  give Harness the Gateway's `OPENCLAW_STATE_DIR`; a TUI Harness starts then inherits it and agrees with the Gateway.
- Memory: Harness does not start the Gateway; its memory limit and the check before starting it are the lamp's.
- Any other engine's first task.

## Anti-goals

- A task typed twice. A duplicate task does the work twice on the person's quota.
- A task silently dropped because the Gateway was slow or the daemon restarted.
- A new switch or setting for either fix.
- A second way to hand OpenClaw its first task beside the one below: `--message` goes.

## Design

### First task through the session input

- OpenClaw still takes a first task everywhere a launch carries one today: New, `harness new`, a Swarm launch, the
  restore launch's `continue` (`core/main.ts`), and a fork should OpenClaw ever take one. `supportsFirstPrompt('openclaw')`
  stays true, so no caller is refused with `PROMPT_UNSUPPORTED`; the engine's launch contract says its first prompt is
  typed rather than given in argv (the shape is the builder's call), and every such launch takes the path below.
- Its launch no longer carries `--message`: the TUI starts as `openclaw tui --session harness-<agentId>`.
- The task is kept on the agent's registry row (a new optional field, the task's text) until it is handed to the
  session input. It is handed over once the agent is bound and its pane reads `ready`
  (`readOpenclawScreen(...).state === 'ready'`), on the bind pass that already reads the pane (`core/agents/bind.ts`):
  no poll of its own. The field is removed from the row **before** the task is handed over, so a daemon restart after
  that never types it again (at most once); a restart before it finds the field and hands it over on the next `ready`.
- It is typed as the person's own message, as `--message` was (Enter retried within the session input's bound), Swarm
  launches included. From there the existing path applies: confirmation by the store's user row, bounded retry, and
  its existing failure (`onError`, delivery `unknown`).
- No timeout while it waits. While the pane cannot take it, the agent already says why (`no-gateway`, `no-token`,
  `remote` holds); the task goes in once the Gateway answers, however late. A relaunch keeps a field not yet handed
  over; deleting the agent drops it.
- The confirmation window covers a Gateway that stalls 18 s: OpenClaw's submit verification (`OPENCLAW_SUBMIT_VERIFY_MS`
  and its retries) gives the user row at least **30 s** before the session input gives up, for every message to
  OpenClaw, not only the first (same cause).
- Log lines name the agent by its short id and the outcome (`kept`, `handed over`), never the task's text.

### Store that holds no session while the pane works

- Detected and said by the store stream (`engines/openclaw/live.ts`, the reader that already sets `unsupported` and
  `harnessNode`), as one more store hold in `OPENCLAW_STORE_HOLDS`: a hold the stream sets and clears while it keeps
  reading, unlike the screen holds that keep an agent from binding.
- The condition: the pane's status reads a run in progress (`running` or `streaming`; `connecting` does not count) and
  the store has no session node for the key, continuously for **30 s**. The bind pass already hands the stream each
  pane reading (`openclawPaneRead`); it now also says whether a run is in progress.
- The agent then says `Harness cannot find this OpenClaw's sessions. Start Harness with the Gateway's
  OPENCLAW_STATE_DIR, then restart this agent.` (a new `OPENCLAW_STATES` entry). The restart is needed because a TUI
  keeps its state folder for life and the binding keeps the folder it read (`openclawStateDir`).
- It clears once the store shows the session.
- A fresh session before its first message reads `ready` with no node: no state. A Gateway that is only slow writes
  the node within 30 s of the run starting.
- An idle pane is read every 30 s, not every pass; one a message was typed into is read on every pass until the
  message is confirmed, so the run it starts is counted from its start. A run the person starts in the pane itself
  can be seen up to 30 s late.
- The daemon logs once per agent the folder it looked in (local log only; telemetry carries no path).
- A TUI Harness starts gets harnessd's `OPENCLAW_STATE_DIR` and `OPENCLAW_HOME`, so a daemon given the Gateway's
  variable starts TUIs that agree with the Gateway.

### Default state folder

- `lib/openclawStore.ts`'s fallback follows OpenClaw: `OPENCLAW_STATE_DIR` (trimmed, `~` expanded against the home
  below), else `<OPENCLAW_HOME or OS home>/.openclaw`.
- `OPENCLAW_HOME` joins `OPENCLAW_STATE_DIR` among the variables `inspectNativeLaunch` checks for OpenClaw
  (`ENGINE_LOCATIONS`), so a Windows network path there is refused like the other.
- The open file the TUI holds still wins over the default, as today.

## Tests (red first)

- Launch argv for a first task has no `--message` (`engines/openclaw/launch.spec.ts`); `supportsFirstPrompt` stays true.
- A first task is kept on the row, handed over on the first `ready` pass, not while the pane reads `no-gateway`;
  confirmed by a user row; handed over once even if the pane flips ready → busy → ready.
- Restart: a row with the field hands it over on the next `ready`; a row without it (handed over before the restart)
  types nothing.
- The restore launch's `continue` and a Swarm launch take the same path.
- OpenClaw's confirmation waits at least 30 s for the user row (fake clock).
- Store: `running` for 30 s with no node: the hold; it clears once the node appears; `connecting` or `ready` with no
  node: nothing; `running` for 29 s: nothing.
- Default folder: `OPENCLAW_STATE_DIR=~/x`, `OPENCLAW_HOME=/h`, both, neither.
- A launched TUI's environment carries the daemon's `OPENCLAW_STATE_DIR` and `OPENCLAW_HOME`.
- End to end on this Mac with OpenClaw 2026.11.2: a Gateway stopped, `harness new openclaw -- <task>`, the Gateway
  started 60 s later: the task is answered. A Gateway with its own `OPENCLAW_STATE_DIR` and a daemon without it: the
  store hold shows; the daemon given the variable and the agent restarted: it goes and the turn shows.

## Data and design

- Growth: at most one first task per agent on its registry row, removed when handed over; deleting the agent removes it.
- Concurrency: written and removed by the core, which owns the registry; the session input's per-session queue after.
- Read cost: rides the existing bind pass and store reader; no new poll.
- Scale: N/A, per agent on one machine.
- Compatibility: daemon only; clients and backend unchanged. `harness new` answers as before. The row field is
  optional and new; an older daemon ignores it.
- Migration and rollback: none. A rollback with a first task still on a row drops that task (the older daemon does not
  read the field); reverting restores `--message`.
- Audience, identity: unchanged; the task is typed into the agent's own pane as the person's own message.
- Failure: each fault above has its named state and a log line.
- Platforms: macOS, Linux, Windows. Windows reads no open files, so it relies on the default folder.
