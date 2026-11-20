# OpenClaw follow-ups after #4499: a refused tell, sign-in screens, close copy, pushes, the watcher, a restart

Status: approved by the orchestrator, with its four notes (decisions 1, 4, 6, Design 7) and three plan answers (decisions 1, 2, 5) · 2026-11-20 · branch `fix/openclaw-followups`

## Why

#4499 (CLI 0.6.74) made the first task reach OpenClaw and made `show`, `ps`, `wait` and `watch` say the right state
from launch on. Its PR listed seven things it left open. A client that drives OpenClaw through Harness (`harness new
openclaw … -- <task>`, then `show`/`wait`/`watch`, later `tell`, finally `close`) still meets each of them: a message
that never arrives, advice that sends the person to the wrong fix, a close that claims a conversation was kept, a
`wait` that sleeps up to a minute past the change, a launch confirmed 17-28 s late, and a first task lost when the
daemon restarts at the wrong moment. This PR fixes all seven, and every other bug found on this path, in one PR,
driven by #4499's goal test (`cli/e2e/openclawShow.e2e.ts` with the fake OpenClaw), extended with one row per item,
each red on `main`.

## What the code shows today

1. **A refused `tell` while history failed cannot recover.** A message typed while OpenClaw's history load is still
   running is refused (`session history not ready — wait or retry /session`) and put back in its input box (OpenClaw
   tui `setText`). When the load then fails, the pane reads `no-history` with the message in the box. Harness types
   `/session` only into an empty box (`core/agents/bind.ts` around 671; `core/input.ts` `commandHold`, `box_not_empty`),
   and never pastes a message twice, so nothing happens: `retryOpenclaw` (`lib/sessionInput.ts`) waits, and 180 s after
   the paste gives up with "The agent did not accept the message". The text stays in the box for good, every later
   `tell` waits 180 s untyped and fails the same way, `show` says `idle` ("It has not taken the work you told it"),
   and `wait` reads a draft and runs to its `--timeout` (exit 124). The first task takes the same path and fails
   `FIRST_TASK_NOT_TAKEN` after 3 minutes.
2. **The pairing and sign-in screens read as "Gateway not running".** OpenClaw 2026.11.2 draws a refused connect as
   `gateway disconnected: <reason> | <activity>` for 5 s, then `disconnected | <activity>` (tui
   `resolveGatewayDisconnectState`, `renderStatus`, `setConnectionStatus`), where `<activity>` is
   `device approval needed: preview latest request` (pairing required), `gateway authentication needs attention`
   (a token mismatch or scope mismatch), `gateway authentication temporarily rate-limited` or `identity-aware proxy
   rejected connection`, and it prints its own remedy once in the chat (`openclaw devices approve --latest`, rotate the
   token, …). Harness matches only `^gateway disconnected` (`engines/openclaw/contract.ts` `STATUS.noGateway`) and holds
   the agent with "OpenClaw Gateway is not running. Start it with openclaw gateway.": the wrong fix.
3. **Closing an agent that never took a task says "Its conversation is kept; the person can resume it."** An OpenClaw
   row has its session key from the footer as soon as it is bound, so `keptNone` (`lib/closeAgentService.ts`, no
   `sessionId`) is false, though OpenClaw's store holds nothing for that key (`lib/sessionCheckpoint.ts` saves nothing
   for it).
4. **An expired working claim with no turn open is pushed to no one.** A claim expires lazily (`lib/turnActivity.ts`
   `entry()`); the 5 s heartbeat that reads it and sends `agent_activity` runs only while a turn is open
   (`core/turns/heartbeats.ts`). Claims with no turn open (the paste-time mark, a pane read as busy, late progress)
   expire silently, and `wait`/`watch`, which sleep up to `PUSHED_BACKSTOP_MS` (60 s, `agentClient/commands.ts`) while
   the agent reads working, wake at the backstop. `wait`/`watch` hear `agent_activity`, `turn_heartbeat`, `turn_ended`,
   the question frames and `agent_deleted` (`core/toolWatches.ts`, `agentClient/daemon.ts`), not `agent_synced`.
5. **The 60 s `starting` expiry and the paste-time `working` mark are not pushed.** `starting` for an unbound OpenClaw
   with no task ends at `OPENCLAW_STARTING_MS` (`lib/agentFrame.ts` `agentStarting`) only when a frame is next built;
   no `agent_synced` goes out at the deadline. The paste-time mark (`core/input.ts` `onSubmitted` → `turnActivity.observe`
   in `core/main.ts`) sets a claim and sends nothing, so windows and tool watches learn of the run only at its first
   store row (15-45 s on a slow Gateway).
6. **"create watch failed · openclaw · readiness publication unavailable" on most launches, and a late launch.** On
   the slow-device box of #4499 every logged launch, on `main` and on its branch, printed it 0.5-0.7 s after
   `create pane open`; the launch was then confirmed by discovery's pass 17-28 s later (`[launch] … ready → none ·
   register openclaw`) instead of by the new-pane watcher. The line is the watcher's catch-all (`core/agents/newPane.ts`
   `watchNewPane`): something in its loop threw and ended the watch. The cause, confirmed on a real OpenClaw 2026.11.2
   on this Mac (Task 14; 4 of 9 launches, 4 of 4 with the Mac slowed): the TUI starts as `node …/openclaw tui` and
   about 0.1 s later names itself (`process.title = "openclaw"`, `dist/entry.js`), same pid and start time. The watcher
   found it as `node`; `confirmLaunch`'s `refresh` then read `openclaw` and threw `IdentityReadUnavailable` ("the new
   pane changed before readiness publication"). The guess written first (the launcher starting the TUI as a child)
   does not fail: there the launcher, which keeps its name, is confirmed, by the watcher and by discovery alike.
7. **A daemon restart between typing the first task and its confirmation loses it.** `takeFirstTask`
   (`lib/registry.ts`) removes `firstTask` from the row durably before the paste; from then on "typed, not yet
   confirmed" lives only in memory (`lib/sessionInput.ts` controller, `bind.ts` `firstTaskClock`). After a restart in
   that window (a crash, or an update handoff, exit 75) nothing types it, no bound runs, `starting` drops, and `show`
   says `idle` with an empty ask: #4499's original bug, in a narrower window.

## Goals

- A message (a `tell` or the first task) OpenClaw refused into its box while its history did not load reaches OpenClaw
  once its history loads, sent once, with no copy left in the box.
- Each sign-in screen holds the agent with a sentence that names its own fix; "Gateway not running" only when it is not
  running.
- `close` says no conversation was kept exactly when none was.
- Every time-based change of what `wait`/`watch` and the windows read is pushed when it happens: a claim's end within
  one heartbeat (5 s), the paste-time mark at once, `starting`'s end in the binding pass that sees it (5 s).
- The new-pane watcher confirms an OpenClaw launch itself, within seconds, and the log line is gone.
- A first task typed before a daemon restart is never sent twice nor pasted over itself, is confirmed or failed
  visibly after it, and the agent reads `starting` across the restart.
- Hermes and the other engines read exactly as before (their e2e files rerun, unchanged).

## Non-goals

- OpenClaw's own bugs (the history flag, its respawns): reported, not patched.
- No new state word, command or verb. No Desktop or mobile change: they already read `agent_activity`, `agent_synced`,
  `launch` and `namedState`.
- #4499's rows 1-20 keep their assertions; they change only where an item here changes what they should say.

## Anti-goals

- Two sends of one message, or a box holding a message twice. Clearing the box of the person's own text.
- `needsPerson` (wait exit 3) on a state Harness recovers from by itself.
- A poll or a fixed sleep where a push is the fix; a fake shaped to the code (the fake draws only what OpenClaw
  2026.11.2 draws, from its recorded screens or its source, cited).

## Decisions (the child's, each reversible; the orchestrator delegated them)

1. **Clear, then type once (item 1).** When an OpenClaw pane reads `no-history` and its box holds exactly a message
   Harness typed and is waiting on, with nothing scrolled out (`openclawBoxHolds`), it was not sent (OpenClaw sends
   nothing while its history is not loaded and puts a refused message back in the box). Harness presses Ctrl+U until
   the box is empty (OpenClaw's editor deletes to the line start, and at column 0 joins the line above, so 2n−1 presses
   for n lines; bounded, and the box read again after), once per message. The message then waits untyped as any
   message does while the pane cannot send, so the existing `/session` remedy runs, and it is pasted once into an empty
   box when the pane reads ready. The refused paste was never sent, so this is its one send. Harness clears only a box
   whose text, read from the screen whole (not scrolled, no paste marker it cannot count), is exactly the message it
   typed itself. When the box holds anything else (the person typed, before or after the refusal) or cannot be read
   for sure, it is never cleared: the agent is held with `OpenClaw's input box holds text Harness did not type. Clear
   it so Harness can send the message.` (the orchestrator's note; cleared once the box is empty, when the message goes
   the usual way), and the bound still fails the message visibly if nobody does. The same hold and the same release
   apply on a pane that can send, where a person's draft blocks a message of Harness's (the same cause; OpenClaw only;
   a person's draft is never cleared). A unit test for each: the exact box
   cleared; a box with one more character, and one scrolled, held and not cleared. Never Ctrl+C (OpenClaw exits on it
   while disconnected). The same path serves the first task, whose move back to "waiting untyped" is written to the row
   before the first Ctrl+U (decision 7). A `tell`'s 3-minute bound runs from its first paste and is not restarted. The
   fake's Ctrl+U is made to match OpenClaw's (today it clears the whole box).
2. **Two sign-in sentences (item 2), read from OpenClaw's activity after the `|`.**
   `device approval needed…` holds with `OpenClaw is waiting for this device to be approved. Run openclaw devices
   approve --latest.`; `gateway authentication needs attention`, `… temporarily rate-limited` and `identity-aware proxy
   rejected connection` hold with `OpenClaw's Gateway refused its sign-in. Its terminal says how to fix it.` Both use
   the Gateway hold's timing (set once the refused connect has lasted 10 s, held through the bare `disconnected | …`
   lines, cleared by a connected line), so a one-off refusal does not hold. A rate limit counts as a refused sign-in:
   OpenClaw sets it only after failed sign-ins, which need the person, and its own remedy (printed in the terminal)
   names the wait; the hold clears by itself when the lockout ends and the TUI connects. The sentences live in
   `OPENCLAW_STATES` and reach clients as `namedState`, as the Gateway one does; `docs/cli.md`, the harness `SKILL.md`
   and their website copies list no held sentence (they say `held` with `namedState`), so no doc changes.
3. **"None was kept" from OpenClaw's store (item 3).** A close of an OpenClaw agent reports `withoutConversation` (the
   existing `It had not started a conversation, so none was kept.`, `conversationKept: false`) when OpenClaw's store
   holds no user row for its key, which covers a launch failed `FIRST_TASK_NOT_TAKEN` or `OPENCLAW_NO_TOKEN`, a launch
   given no task, and one closed while its first task still waits. The store, not a flag on the row, is the truth.
4. **One push for every claim with no turn open (items 4 and 5b), every engine.** The cause (a claim with no turn
   open ends unpushed) is not OpenClaw's, so the fix is not gated on it. `TurnActivity` tells the heartbeats when a
   session turns working with no turn open; they send one `agent_activity` at once, then check it on their 5 s beat
   while the claim lasts and send one more when it changes (its end), so its end is told within 5 s. Such a session
   gets no `turn_heartbeat` beats (those stay for open turns), and renewals tell nothing: two frames a claim at most,
   against the day's 33k `agent_activity` the heartbeat module notes. This reuses the heartbeat timer; no new timer,
   no poll. It is a hot path (idle daemon work, frames to every window), so the PR gives numbers before and after on
   the same workload and toolchain (`e2e/perf.e2e.ts` or a scripted equivalent): frames a second (`agent_activity`,
   `turn_heartbeat`) and the idle daemon's CPU with N agents (Claude Code, Codex and OpenClaw fakes), and a unit test
   holds the two-frames-a-claim bound.
5. **`starting`'s end announced by the binding pass (item 5a).** The 5 s pass, which already reads every unbound
   OpenClaw, announces the agent (`agent_synced`) once in the pass that finds its starting minute over; the deadline is
   worked out by one helper `agentStarting` uses too. Remembered in a bounded set, as `firstTaskClock` is.
   **Tool watches are told too** (the orchestrator's answer): `wait`/`watch` hear no `agent_synced`, so while an agent
   is held or failed they look once a minute and learn a hold's end, or its new reason, up to 60 s late (the cause of
   item 4). `core/toolWatches.ts` tells a tool watch when an agent's `starting`, its launch failing, or its hold
   reason changes: once per change, from the frame the core announces, no poll; counted with decision 4's numbers.
6. **The watcher goes around again (item 6).** First the cause is confirmed on a real OpenClaw 2026.11.2 launch (the
   log now names the error kind). If it is the launcher's child process, a process change before publication sends the
   watcher round its loop again (bounded by its budget, as a pane read as `unknown` is), and the process it confirms is
   the TUI's, not the launcher waiting for it; the fake starts its TUI as a child of its launcher, as OpenClaw does. If
   the cause is another, the same rule holds: the watcher ends only on a real outcome, and the fix covers that cause.
   A cause in OpenClaw's own launcher is not patched (OpenClaw is never touched); Harness's watcher retrying is the fix.
7. **A durable "typed" mark (item 7).** `takeFirstTask` moves the task, in the same write, from `firstTask` to a new
   row field `firstTaskTyped: { text, at }` instead of deleting it. The row then always says where the task stands:
   `firstTask`, waiting untyped (typed only into an empty box on a pane that can send, the existing path); or
   `firstTaskTyped`, typed and not yet confirmed, which a daemon never pastes. A daemon that finds `firstTaskTyped`
   after a restart:
   - counts it confirmed, and removes it, once OpenClaw's store holds a user row for the key written after `at`
     (though the daemon was down when it landed);
   - reads the agent `starting` until then, with the 3-minute bound started again in memory at the restart and paused
     while held or starting, as today (a Gateway that comes back late still gets the task);
   - on a pane that can send with a box holding exactly the task, gives the one Enter the confirmation path gives;
   - on a `no-history` pane with a box holding exactly the task, moves it back to `firstTask` in one write, then clears
     the box (decision 1), so the task is pasted once more only from an empty box;
   - with an empty box and no user row at the bound, fails `FIRST_TASK_NOT_TAKEN`, visibly (never a second paste).
   It is removed on confirmation, on `failFirstTask`, and with the row. No age cutoff: the store decides, so a mark an
   older daemon left after a rollback is removed at once when the task was taken, and fails visibly when it was not. A
   new field, not `firstTask`, so an older daemon cannot paste it again.

## The goal test: new rows (`cli/e2e/openclawShow.e2e.ts`)

Each row is red on `main` (run once at the base with the new fake copied in; the PR lists what failed). The
choreography of each is the builder's; what it asserts is this:

| # | Item | What the fake does | Asserted | `main` today |
|---|---|---|---|---|
| 21 | 1 | After the first task is done, a `tell` is refused into the box while the history load fails | Ctrl+U clears it, `/session`, the tell accepted exactly once, `wait` exits 0 with its answer; the box never held it twice | never accepted; `wait` 124 |
| 22 | 2 | The pairing screen, then (another agent or later) the sign-in screen, each lasting > 10 s, then a reconnect | `held` with the approval sentence, then with the sign-in sentence; `wait` exit 3 with it; never "Gateway is not running"; cleared on reconnect | "Gateway is not running" |
| 23 | 3 | An agent that never took a task (row 5's failed launch, and one launched with no task) | `close` says `It had not started a conversation, so none was kept.`; `--json` `conversationKept: false` | "Its conversation is kept" |
| 24 | 4 | A run on screen with no turn open that ends with no row | `wait` returns within 30 s + 10 s of the claim's start, not at the 60 s backstop; `watch` prints the change as soon | 60 s or `--timeout` |
| 25 | 5 | (a) an unbound agent with no task past its minute; (b) a paste held at `sending` | (a) an `agent_synced` with `starting: false` within 70 s of the launch; (b) `agent_activity` working within 2 s of the paste | neither pushed |
| 26 | 6 | Its TUI started as a child of its launcher, as OpenClaw's is | no `create watch failed` in the daemon log; `[agent] create ready` from the watcher within 10 s of `create pane open` | the line; ready only from discovery |
| 27 | 7 | (a) The task typed and held at `sending`, the daemon restarted, then accepted; (b) refused into the box by a Gateway drop before the restart, the pane able to send after it; (c) refused into a `no-history` box before the restart | (a) typed once (one accepted event), `starting` on every look across the restart, then `working`; (b) one Enter after the restart, accepted once; (c) cleared, `/session`, typed once more from an empty box, accepted once; never two copies in the box | `idle`, empty ask; or never taken |

## Approaches

1. **Fix each where its cause is, driven by the goal test (chosen).** Each item is a small change in the module that
   owns it (`sessionInput.ts`, `contract.ts` and `bind.ts`, `closeAgentService.ts`/`sessionCheckpoint.ts`,
   `turnActivity.ts`/`heartbeats.ts`, `agentFrame.ts`/`bind.ts`, `newPane.ts`, `registry.ts`), with a red unit test at
   that layer and a red goal-test row. Nothing new in the core's process.
2. **A per-agent timer for every deadline (rejected).** Exact pushes, but a new timer per agent beside the heartbeat
   and the binding pass that already run; more state to clear, no visible gain at a 5 s grain.
3. **Client-side: `wait`/`watch` cap their sleep at the claim's lifetime (rejected).** Doubles their requests during
   long turns, leaves the windows unpushed, and does nothing for items 1-3, 6 and 7.
4. **For item 1, Ctrl+U then Ctrl+Y to put the text back without a paste (rejected).** It relies on pi-tui's kill ring,
   which the fake would have to copy and a later OpenClaw may change; the cleared-then-pasted message is sent once
   either way.
5. **For item 7, guess from the pane after a restart (rejected).** Text in the box cannot be told from the person's
   own draft without the task's text.

## Design (docs/feature-design-rules.md): the `firstTaskTyped` row field (item 7)

The one change that stores data. Items 1-6 store, sync and expose nothing new (two new hold sentences go out as
`namedState`, which carries such sentences already).

1. **Growth.** Created by `takeFirstTask`, in the write that removes `firstTask`. Removed: on confirmation (a user row
   after `at`), by `failFirstTask`, by the move back to `firstTask` before a clear (decision 1), and when the row is
   forgotten, closed or purged. At most one per agent, one launch task's text (bounded as the launch's task already
   is). A row holds `firstTask` or `firstTaskTyped`, never both.
2. **Concurrency.** Written and removed through the registry writer under the row's owner guard, as `firstTask` is;
   the confirmation, the failure and the move back each change it only on the row they read (the same guard
   `takeFirstTask` uses). The move back is durable before the first Ctrl+U, so a restart at any point leaves the row
   saying whether the task may be pasted (only `firstTask`, only into an empty box).
3. **Read cost.** Read only by the binding pass and the frame's `starting` from the row in memory; never on the frame,
   never sent.
4. **Scale.** One short string per starting OpenClaw agent; ten times the agents is ten more strings in the registry
   file for under 3 minutes each.
5. **Compatibility.** Readers: `registry.ts` (both row readers, `strictPersistedRow` and `load()`, through one
   helper), `bind.ts`, `agentFrame.ts`, `sessionInput.ts` (all changed here). An older daemon rebuilds each row field
   by field as it loads, so it drops the field: it reads that agent as today's known limit, and never pastes the task
   twice, since `firstTask` is already gone. No frame or protocol change.
6. **Migration and rollback.** None; no `schemaVersion` bump (a bump would refuse older writers). A rollback drops the
   field on load (line 5), so a roll forward finds none to settle; a field a newer daemon wrote and an older one did
   not load again is settled by the store on the first pass: removed when the task was taken (a user row after `at`),
   failed visibly at the bound when it was not, so a long-done agent never reads `starting` for long. No production
   data involved (a local file on each computer).
7. **Audience, and where it is kept.** The text is the prompt the launch carried, already kept on the same row
   (`firstTask`) until it is typed; this keeps it until it is confirmed, at most the bound plus the time held. It
   lives in the registry file alone, which the registry's own writer writes whole (a temporary file made `O_EXCL`,
   mode 0600, then renamed: the whole-file rule #4489 set for state files), in the owner-only (0700) data folder; no
   new file. Never on the frame, never sent, never logged (log lines say "first task typed", no text). Removed once
   confirmed, failed, or the agent is closed or forgotten. An older daemon drops the field (line 5). A hash and length are
   not enough: after a restart the text is needed to tell the task from the person's text in a box shown in part (a
   tall box scrolls, decision 1 and #4499), and to paste it once more after a clear (27c); confirmation itself uses
   none of it (a user row after `at`).
8. **Identity.** N/A: nothing runs as anyone; the paste is the existing one.
9. **Failure.** A restart in the window: the agent reads `starting`, then `working` once confirmed, or `failed` with
   `FIRST_TASK_NOT_TAKEN` at the bound, which `show`, `wait` (exit 1) and the windows say. A write that fails leaves
   `firstTask` in place and nothing typed, as today.
10. **Platforms.** Shared TypeScript: macOS, Linux and Windows alike.

## Constraints

- The core rules (`cli/AGENTS.md`, `cli/src/core/AGENTS.md`): fixes in the modules that own the behavior, factories with
  explicit dependencies, no new file in the core's process (`architecture.coreFiles.txt` unchanged), 100% coverage
  (`npm run test:core`), wiring only in `core/main.ts`.
- Nothing typed twice; every retry, key press and wait bounded; push, not poll; no fixed sleeps in tests.
- The PR, commits, code and tests describe the client generically and name no customer, device or product of theirs.
- Platforms: macOS and Linux end to end; Windows by the unit tests (shared TypeScript).

## Verification

- **Red on `main`:** rows 21-27 run once at the base with the new fake; the PR lists the rows that failed.
- **Green on the branch:** the goal test (all rows), `e2e/agentClient.e2e.ts` and the Hermes and other-engine e2e
  files, on Linux (GitHub `ubuntu-24.04`, through a temporary workflow that runs only those files, as #4499 did) and
  on this Mac.
- **Real OpenClaw 2026.11.2** on this Mac, isolated (throwaway home and state folder, a Gateway on a free port, a stub
  model): item 6's cause confirmed before its fix and the line gone after it; the pairing screen (a TUI whose device is
  not approved) and a token mismatch, each held with its sentence; a refused `tell` during a dropped history load
  delivered once.
- **The slow-device box** (the Podman machine of #4499's check: arm64 Debian 12, CPU-limited, 4 GB, throttled disk):
  10 runs of `new` + polling `show` on `main` and on the branch: the watcher's line, the time to `create ready`, the
  first task's time to taken; one daemon restart in the typing window; two real-model runs (a key file piped into the
  box only, owner-only, removed afterwards).
- **Numbers (decision 4, a hot path):** before and after, same workload and toolchain: frames a second
  (`agent_activity`, `turn_heartbeat`) and the idle daemon's CPU with N agents of Claude Code, Codex and OpenClaw
  fakes; the time from a claim's end to `wait`'s return.
- **Local gates:** `npm run typecheck`, the unit tests of what changed, `npm run test:core`, `npm run test:portability`.

## Left to the builder

The fake's new steps and how each row is choreographed; where a `tell`'s "cleared once" mark is kept (in memory, as a
tell is); the bound on Ctrl+U presses; how the heartbeats learn of a claim (a callback, a late-bound reference in `main.ts`); the
bounded set for `starting`'s announcement; how confirmation after a restart sees a user row written while the daemon
was down; the exact wording of the two sentences if `docs/cli.md`'s style needs it.
