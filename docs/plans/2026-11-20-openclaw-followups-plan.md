# OpenClaw follow-ups after #4499: a refused tell, sign-in screens, close copy, pushes, the watcher, a restart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges. Every task but Task 1 ends green (Task 1 is the goal test: its rows 21-27, 21b and row 22's `watch` assertion included, stay red until the fixes land).

**Goal:** The seven things #4499 left open on the path a client drives (`new openclaw … -- <task>`, `show`/`wait`/`watch`, `tell`, `close`) are fixed: a refused message is cleared and sent once, a person's draft that blocks one holds the agent with what to do, each sign-in screen names its own fix, `close` says no conversation was kept exactly when none was, every time-based change is pushed (to `wait`/`watch` too), the new-pane watcher confirms an OpenClaw launch itself, and a first task survives a daemon restart.

**Architecture:**
- **OpenClaw's screen** (`engines/openclaw/contract.ts`) reads the activity a Gateway-lost status line carries (`signIn`), and says whether a box holds exactly a message, whole (`openclawBoxExactly`), and how many Ctrl+U clear it (`openclawClearKeys`). The binding pass (`core/agents/bind.ts`) holds with the two sign-in sentences on the Gateway hold's timing, holds a box with text Harness did not type (on a `no-history` pane and on a `ready` one), announces `starting`'s end, and settles a first task typed before a restart from OpenClaw's store.
- **The submission controller** (`lib/sessionInput.ts`) clears a message OpenClaw refused into a `no-history` box (Ctrl+U, once a message) and sends it once from an empty box; it adopts a first task an earlier daemon typed. **The registry** (`lib/registry.ts`) keeps a durable `firstTaskTyped: { text, at }` from the paste to the confirmation.
- **Claims with no turn open** are pushed by the heartbeats (`core/turns/heartbeats.ts`), told by `TurnActivity` (`lib/turnActivity.ts`): one frame at the claim's start, one at its end. **Close** asks OpenClaw's store whether it holds a user row (`lib/openclawStore.ts`, `lib/closeAgentService.ts`). **The new-pane watcher** (`core/agents/newPane.ts`) goes round again when the pane's process changes before publication. **Tool watches** (`core/toolWatches.ts`) are told, from the `agent_synced` the core announces, when an agent's `starting`, its launch failing or its hold changes, so `wait`/`watch` (`agentClient/daemon.ts`'s pushed set) wake then, not at their 60 s backstop.

**Tech Stack:** TypeScript (Node 24, vitest) in `cli/`; the `.mjs` fake OpenClaw for the end-to-end test; a temporary GitHub Actions workflow. No Dart change.

**Spec:** `docs/plans/2026-11-20-openclaw-followups-design.md` (approved, with the orchestrator's four notes and its three answers to this plan's questions: decisions 1, 2 and 5). Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` ("Protect the core", Rules 4-9), `cli/src/core/AGENTS.md` (rules 1, 5, 6) and `docs/validation-and-release.md`.

## Base

- `fix/openclaw-followups` at `7687138398`. The spec and this plan are untracked; the main session commits them, no task does.
- Nothing is installed in this worktree (no `cli/node_modules`): the first task to run, whichever it is, runs `npm ci` in `cli/`.
- Line numbers are the base's. A task follows the expression it names when a line has moved.
- OpenClaw 2026.11.2 is installed at `/opt/homebrew/lib/node_modules/openclaw` (read only, never patched). What it does, checked for this plan:
  - pi-tui's editor (`node_modules/@earendil-works/pi-tui/dist/components/editor.js`): `setText` puts the cursor at the end (921-933, 371) and clears its paste markers; Ctrl+U (`tui.editor.deleteToLineStart`, `keybindings.js` 63) runs `deleteToStartOfLine` (1358-1384): it deletes from the cursor to the line's start, and at column 0 joins the line above, the cursor at that line's old end. So n lines with the cursor at the end clear in at most 2n−1 presses; one more on an empty box changes nothing.
  - A refused message goes back as `setText(newerDraft ? \`${value}\n${newerDraft}\` : value)` (`dist/tui-DRVGqw2R.mjs` 6164-6167): a draft typed meanwhile follows it, and the box shows the whole text, never a paste marker.
  - A refused connect (tui 7625-7655): `setConnectionStatus(<connectionStatus>, 5 s)` then `disconnected`, the activity kept, the remedy printed once (`chatLog.addSystem`). `resolveGatewayDisconnectState` (6636-6647) gives the activity `device approval needed: preview latest request` (pairing required), `gateway authentication temporarily rate-limited`, `identity-aware proxy rejected connection`, `gateway authentication needs attention` (any other failure with a remedy: token or scope mismatch), else `idle`; the reasons and remedies are in `dist/connect-error-details-DhaB57zU.mjs` (59-90, 167-169, 234-292).
  - A send that fails draws ` send failed: <error>` and the activity `error`, with no store row (tui 3313, 3388-3389, 3418-3419).
  - `openclaw.mjs` (112-149) may start the TUI again as a child (`runRespawnedChild`: compile cache, Node host), the launcher waiting for it.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The fake follows OpenClaw further; goal rows 21-27 | `cli/e2e/harness/fakeOpenclaw.mjs`, `cli/e2e/openclawShow.e2e.ts`, `cli/ci-e2e-durations.json` | none | xhigh | itself: rows 21-27 (21b and row 22's `watch` assertion included) red on the base and committed red |
| 2 Temporary workflow (Linux) | `.github/workflows/tmp-openclaw-followups.yml` (new) | 1 | medium | none: temporary, one commit, removed before the merge |
| 3 OpenClaw's screen: sign-in activity, the box read whole, three sentences | `cli/src/engines/openclaw/contract.ts`, `contract.spec.ts`, new `__fixtures__/screen-pairing.txt`, `screen-pairing-bare.txt`, `screen-token-mismatch.txt`, `__fixtures__/MISSING.md` | none | high | `contract.spec.ts` (new cases) |
| 4 The binding pass holds each sign-in screen with its own sentence | `cli/src/core/agents/bind.ts`, `bind.spec.ts` | 3 | high | `bind.spec.ts` (new cases) |
| 5 Whether OpenClaw's store holds a user row for a key | `cli/src/lib/openclawStore.ts`, `openclawStore.spec.ts` | none | medium | `openclawStore.spec.ts` (new cases) |
| 6 Close says none was kept when OpenClaw's store holds none | `cli/src/lib/closeAgentService.ts`, `closeAgentService.spec.ts`, `cli/src/core/agents/close.ts`, `close.spec.ts` | 5 | high | `closeAgentService.spec.ts`, `close.spec.ts` |
| 7 A claim with no turn open is pushed at its start and its end | `cli/src/lib/turnActivity.ts`, `turnActivity.spec.ts`, `cli/src/core/turns/heartbeats.ts`, `heartbeats.spec.ts`, `cli/src/core/turns/activity.ts`, `activity.spec.ts`, `cli/src/core/main.ts` | none | xhigh | `turnActivity.spec.ts`, `heartbeats.spec.ts`, `activity.spec.ts` |
| 8 `starting`'s end is announced by the binding pass | `cli/src/lib/agentFrame.ts`, `agentFrame.spec.ts`, `cli/src/core/agents/bind.ts`, `bind.spec.ts` | none | high | `agentFrame.spec.ts`, `bind.spec.ts` |
| 9 The registry keeps a first task typed, durably | `cli/src/lib/registry.ts`, `registry.spec.ts` | none | xhigh | `registry.spec.ts` (new cases) |
| 10 A message refused into a no-history box is cleared and sent once | `cli/src/lib/sessionInput.ts`, `sessionInput.spec.ts` | 3 | xhigh | `sessionInput.spec.ts` (new cases) |
| 11 The controller adopts a first task typed before a restart; wiring | `cli/src/lib/sessionInput.ts`, `sessionInput.spec.ts`, `cli/src/core/input.ts`, `input.spec.ts`, `cli/src/core/main.ts` | 9, 10 | xhigh | `sessionInput.spec.ts`, `input.spec.ts` |
| 12 The binding pass holds a box with text Harness did not type (`no-history` and `ready` panes) | `cli/src/core/agents/bind.ts`, `bind.spec.ts` | 3, 10 | high | `bind.spec.ts` (new cases) |
| 13 The binding pass settles a first task typed before a restart | `cli/src/core/agents/bind.ts`, `bind.spec.ts`, `cli/src/lib/agentFrame.ts`, `agentFrame.spec.ts`, `cli/src/core/main.ts` | 5, 9, 11 | xhigh | `bind.spec.ts`, `agentFrame.spec.ts` |
| 14 The new-pane watcher goes round again (cause confirmed first) | `cli/src/core/agents/newPane.ts`, `newPane.spec.ts`; only if the confirmation needs them: `cli/src/lib/processTable.ts`, `processTable.spec.ts`, `cli/e2e/harness/fakeOpenclaw.mjs` | 1 | xhigh | `newPane.spec.ts` (and `processTable.spec.ts` when changed) |
| 15 Tool watches are told a start, a failed launch or a hold changing | `cli/src/core/toolWatches.ts`, `toolWatches.spec.ts`, `cli/src/agentClient/daemon.ts`, `daemon.spec.ts`, `cli/src/backendSocket.toolWatch.spec.ts` (a case only) | none | xhigh | `toolWatches.spec.ts`, `daemon.spec.ts`, `backendSocket.toolWatch.spec.ts` (new cases) |

**Longest chain:** 3 → 10 → 11 → 13 (four tasks); also 9 → 11 → 13 and 5 → 13. Tasks 1, 3, 5, 7, 8, 9 and 15 start at once.

**Shared files** (no two run at once; whichever runs second builds on the first's edit, in either order unless a dependency above orders them):
`bind.ts`/`bind.spec.ts`: 4, 8, 12, 13 · `sessionInput.ts`/`sessionInput.spec.ts`: 10, then 11 · `agentFrame.ts`/`agentFrame.spec.ts`: 8, 13 · `core/main.ts`: 7, 11, 13 (a wiring line or two each) · `fakeOpenclaw.mjs`: 1, then 14 (only if 14 needs it). Task 15 shares no file.

## Global Constraints

- Exact copy, byte for byte (in `OPENCLAW_STATES`, so the frame's `namedState` carries them and `agentClient/model.ts` `HELD` makes each `held`, `needsPerson: true`, `wait` exit 3):
  - `approval`: `OpenClaw is waiting for this device to be approved. Run openclaw devices approve --latest.`
  - `signInRefused`: `OpenClaw's Gateway refused its sign-in. Its terminal says how to fix it.`
  - `boxHeld`: `OpenClaw's input box holds text Harness did not type. Clear it so Harness can send the message.`
  - close: the existing `It had not started a conversation, so none was kept.` and `--json` `conversationKept: false` (`agentClient/commands.ts` 2035-2045, unchanged).
  - Unchanged: `OpenClaw Gateway is not running. Start it with openclaw gateway.` (now only when the activity says nothing of a sign-in).
- Numbers: sign-in holds on the Gateway hold's timing (`GATEWAY_HOLD_MS` 10 s, held through the bare `disconnected | …` lines, cleared by a line the Gateway answered); Ctrl+U presses 2n−1 for an n-line message (`\r\n` and `\r` read as `\n`), none for over 64 lines; one clear a message; a tell's bound 180 s (`OPENCLAW_NOT_READY_MAX_MS`) from its first paste, never restarted; a first task's bound 180 s (`FIRST_TASK_BOUND_MS`), paused while held or starting but not for the `boxHeld` hold; the claim beat 5 s (`TURN_HEARTBEAT_MS`), at most two frames a claim; `starting` for an unbound OpenClaw 60 s (`OPENCLAW_STARTING_MS`); a tool watch is told one `agent_synced` a harness when it first sees one after the watch began and one each time its standing (`starting`, failed launch, hold) changes, within the existing `TOOL_WATCHES_MAX` (64) × `TOOL_WATCH_MAX_AGENTS` (8); every new in-memory set bounded at 256 and cleared rather than aged.
- Never Ctrl+C into OpenClaw (it exits on it while disconnected). Nothing is pasted twice; a box with anything but exactly Harness's own message, read whole, is never cleared.
- `firstTaskTyped` is never on the frame, never sent, never logged (log lines say `first task typed`, by the agent's short id). No `schemaVersion` bump.
- The core's process gains no file: `git diff --exit-code 7687138398 -- cli/src/architecture.coreFiles.txt` is empty after every task. `src/core` stays at 100% per file: a task that touches a core file runs `npx vitest run --config vitest.core.config.ts <its core specs> --coverage.include=<its core files>` and it reports no threshold error. Wiring only in `core/main.ts`.
- Hermes and every other engine read exactly as before: `cli/src/engines/__fixtures__/other-screens.golden.json` is unchanged. It reads every multi-line pane literal in `lib/sessionInput.spec.ts`, `lib/closeAgentService.spec.ts` and `lib/runtimeActivity.spec.ts`, so new tests there build panes from `src/engines/openclaw/__fixtures__/screen-*.txt` (read, then `.replace()`d), never as a new multi-line literal; `npx vitest run src/engines/otherScreens.golden.spec.ts` passes.
- OpenClaw is never patched. Its own two bugs (it sends nothing while its history flag is down; its launcher's respawn) are named in the PR body, reported, not worked around in it.
- No new state word, command, verb, setting, frame field or protocol change; no Desktop or mobile change. The one addition (decision 5): a tool connection is now told `agent_synced`, as `{ type: 'agent_synced', agentId, payload: { agentId } }` and nothing else of the frame (a tool hears names and states only, `core/toolWatches.ts`); a client older than this ignores it, and a daemon older than this never sends it (the client then wakes at its backstop, as today).
- Commits, code, tests and the PR describe the client generically ("a client that drives OpenClaw through Harness") and name no customer, device or product of theirs.
- Platforms: shared TypeScript (macOS, Linux, Windows). The goal test runs on macOS and Linux; Windows is covered by the unit tests.

## Decided here, where the spec left it to the builder

- **The paste marker.** "No paste marker it cannot count" is read strictly: a box showing a paste marker is never cleared, and it holds. OpenClaw puts a refused message back with `setText`, which shows the whole text and drops paste markers (editor.js 921-933), so a marker there is never Harness's refused message.
- **The bound on Ctrl+U:** `openclawClearKeys(message)` = 2n−1, null over 64 lines (a box shows at most 30% of the pane's rows, so a whole box of more lines does not occur on a pane under 213 rows). The box is read once more after the presses: empty, the message goes on; anything left, nothing more is pressed.
- **The "cleared once" mark** is in the controller's per-agent state, in memory as a tell is: for a tell, until it is confirmed or given up; for a first task, until the first task ends (it survives the hand-over again). After a daemon restart one more clear can happen; the first task's bound bounds it.
- **Who sets the `boxHeld` hold:** the binding pass, which owns OpenClaw's holds. Set when the pane reads `no-history` or `ready`, a message of Harness's waits (the pass's `waiting`: on a `ready` pane, one held back `openclaw_not_ready` because the box is not empty, `core/input.ts` `openclawHold`), the box is not empty and the controller does not own it (`input.ownsBox`: false while nothing of Harness's is being typed and the box is not exactly its awaiting message, whole). So a person's draft that blocks a message, and a refused message with the person's draft after it, both hold. Cleared once the box reads empty or nothing of Harness's waits; the message then goes the usual way. OpenClaw only; the pass never types into or clears the person's draft.
- **How the heartbeats learn of a claim:** `TurnActivity` calls `claimed(sessionId)` when a session turns working with no turn open; `core/main.ts` binds it late to `heartbeats.watchClaim`. A claim watch lives in the heartbeats' own map (so shutdown and a turn's `startHeartbeat` replace it), never calls `stopHeartbeat` and never forgets the runtime reader (`runtimeActivity.forget`).
- **What a tool watch is told, and when:** `agent_synced` joins `TOLD` in `core/toolWatches.ts`; its harness is `payload.agent.id`; its standing is one key of the frame's `starting === true`, its `launch.state === 'failed'` with `launch.error`, and its `identityHold` (which carries `namedState`); `Told` keeps the last key told. A watch's first `agent_synced` of a harness is told whatever it says (the watch cannot know what its client last read, and a hold that ended before any sync must still wake it); after that only a changed key. The frame told carries the id alone, never the agent's frame. No wiring: `backendSocket.ts` already hands every `send` and `sendCommander` frame to `toolWatches.tell` (629, 764), so a sync sent down both is told once. `agentClient/commands.ts` is unchanged: `pushedBy`'s listener wakes the sleep on any pushed event of a followed harness (1432-1436), and `watch`'s held or failed look is the one that sleeps the backstop (1764); `wait` settles on `held` and looks every interval while `starting` (1571), as before.
- **The bounded set for `starting`'s announcement** is in `bind.ts` (agents announced, 256, cleared rather than aged); the deadline is `openclawStartingUntil(s)` in `lib/agentFrame.ts`, which `agentStarting` uses too.
- **Confirmation after a restart:** the binding pass asks OpenClaw's store, on each pass while the row holds `firstTaskTyped`, whether a user row for the key was written after `at` (`openclawUserRowSince`, Task 5: one `LIMIT 1` query on the core's read threads). That sees a row written while the daemon was down. A turn the stream starts confirms it too, through the controller. The controller is handed the typed task once per daemon (`adoptTypedFirstTask`), only when this daemon did not type it (a bounded set of the agents it handed a task to), so the Enter and the clear take the controller's one path.
- **Removal of `firstTaskTyped`:** on a turn that takes it (controller → `registry.firstTaskTaken`), on the store's user row (binding pass), by `takeFirstTask` on a failed launch (`failFirstTask`, which already calls it: a failed launch's task is dropped, both fields), by `untypeFirstTask` before a clear, with the row. A cancel or a forget does not remove it: the store or the bound settles it.
- **Close reads the store before the stop** (`conversationEmpty`), and the answer for a harness closed already reads it too, so a second close says the same.
- **The fake's respawning launcher is an option** (`respawn: true`, row 26 and Task 14), default off, so rows 1-20 run as they did on main.
- **Row 23's failed launch is row 5's:** one more soft assertion on row 5's `close`, not a second 3.5-minute run.
- **The numbers' workload (decision 4):** 6 agents each of the Claude Code, Codex and OpenClaw fakes (18), signed out, `E2E_BUNDLE=1`, a tool connection watching 8 of them (`agents_watch`); a 60 s idle window and a 60 s window with one of each engine turning; base and branch back to back on this Mac (Verification).

## Review Focus

1. **The person types into the box between Harness's read and its Ctrl+U.** The box is read again after the presses; anything left stops the presses, and the message keeps its bound. Test: Task 10, "the box changed under the presses".
2. **A multi-line message, blank lines and a long wrapped line:** 2n−1 presses for n editor lines, one press for one long line however it wraps. Test: Task 3 (`openclawClearKeys`), Task 10 (presses counted).
3. **A tell sent while a first task typed before a restart is unconfirmed** waits behind it and is never pasted ahead of it. Test: Task 11.
4. **A mark an older daemon left after a rollback:** a task long taken is removed on the first pass and the agent never reads `starting` past it; one never taken fails `FIRST_TASK_NOT_TAKEN` at the bound. Test: Task 13.
5. **The bare `disconnected | device approval needed…` line read first** (the 5 s `gateway disconnected:` line between two passes): still the approval sentence once the outage passed 10 s. Test: Task 4.

---

### Task 1: The fake follows OpenClaw further; goal rows 21-27

**Files:**
- Modify: `cli/e2e/harness/fakeOpenclaw.mjs`
- Modify: `cli/e2e/openclawShow.e2e.ts`
- Modify: `cli/ci-e2e-durations.json` (`e2e/openclawShow.e2e.ts`'s hint, from this task's measured run)

**Interfaces:**
- Produces, in the fake (each cited in its doc comment, as its other behaviors are):
  - The box as the editor keeps it: lines and a cursor, the cursor at the end after text, a paste or a refused message put back. `C-u` (`\x15`) as `deleteToStartOfLine`. Logs `{"keyed":"C-u","box":<box text after>}`.
  - A refused message is put back as `<message>\n<newer draft>` when the box held newer text.
  - Step `{"gateway":"pairing"|"token"|"rate-limited"|"proxy"}`: as `down`, every try refused, drawn `gateway disconnected: <reason> | <activity>` for 5 s and `disconnected | <activity>` between tries, the remedy printed once; `{"gateway":"up"}` connects. Reasons, activities and remedies as OpenClaw's classifier gives them (pairing: `device pairing required (requestId: <uuid>)`).
  - `next.reply: "send-failed"` with `sendMs`: `sending`, then the waiting phrase until `sendMs`, then ` send failed: <error>` and `connected | error`; no row.
  - `fakeOpenclawScript({ …, respawn?: boolean })`: with `respawn`, the `openclaw` launcher runs the TUI as a child of itself (the same script and arguments, an env mark), waits, and exits with its code; the child renames itself `openclaw`, the launcher keeps its node argv.
  - In the test's rig: `launch(name, task?)`, no `--` when there is no task (if the CLI requires one, the window's create request with none, through `LocalClient`); `typeAsPerson(name, text)` and `keyAsPerson(name, key)` through the rig's tmux server (`send-keys -l`, `send-keys C-u`), which the fake takes as typed keys into its box at the cursor (no paste), for row 21b.
- Consumes: the rig of #4499's test (`rig`, `look`, `reached`, `sample`, `logged`, `step`, `answered`, `keepsWaiting`), `LocalClient` frames, `IsolatedDaemon.restart()`/`kill()`/`start()` (the panes and the fake TUI outlive the daemon), `OPENCLAW_STATES` (its new keys come with Task 3: until then the test writes the sentences as literals and Task 3 does not change the test).

- [ ] **Step 1: Write the fake's steps and the rows.** One `it` per row group, each with its own daemon and timeout, `expect.soft` for each claim so a red row says all it gets wrong:
  - **row 21** (after the first task is answered; a person's message, as row 13 sends one, typed while a reconnect's history load runs and then fails): Ctrl+U is pressed (`keyed` events) and leaves the box empty; then `/session <key>`; the message `accepted` exactly once; `wait --timeout 2m` exits 0 with its answer; no `submitted` or `keyed` box holds the message twice.
  - **row 21b** (the same agent, idle after row 21, its pane ready: a person's draft typed into the box through the rig's tmux server, `send-keys -l`, as a person types; then a `tell`): within 15 s of the tell, `held` with `boxHeld` (show line 2, `--json` `namedState`, ps) and `wait` exits 3 with `<n>: held · <sentence> Only the person can fix this.`; the fake's box still the draft, byte for byte, with no `keyed` and no `submitted` from Harness; then the test clears the box (`C-u` through `send-keys` until the fake logs an empty box, as a person would): within 10 s not held, the tell typed once into the empty box and `accepted` exactly once; the draft never `submitted`.
  - **row 22** (pairing over 10 s, `up`, then the token screen over 10 s, `up`, on the same agent: every TUI of a rig reads the same steps): `held` with `approval`, then with `signInRefused` (show line 2, `--json` `namedState`, ps); `wait` exits 3 with `<n>: held · <sentence> Only the person can fix this.`; no sample says `OpenClaw Gateway is not running`; after `up`, not held. **`watch` on the held agent:** a `watch x` started once `show` reads held on the token screen prints its next line (the one after its `held` line) within 15 s of the second `up`, not at the 60 s backstop.
  - **row 23** (a second agent launched with no task, closed once it reads idle; and row 5's `close`, one more soft assertion there): `close` says `It had not started a conversation, so none was kept.`; `close --json` has `conversationKept: false`.
  - **row 24** (an idle agent after its first task; a message with `next: send-failed, sendMs: 3000`): `wait x --timeout 2m` started at the paste returns within 40 s of the paste; a `watch x --json` started with it prints the line after `working` within 40 s.
  - **row 25** ((a) the no-task agent of row 23 before its close; (b) a message with `next: plain, hold: "send"`): (a) a `LocalClient` frame `agent_synced` for it with `starting: false` within 70 s of the launch; (b) an `agent_activity` frame with `activity.state: 'working'` within 2 s of the fake's `submitted`.
  - **row 26** (`respawn: true`): the daemon log has no `create watch failed`; `[agent] create ready · openclaw` within 10 s of `[agent] create pane open · openclaw`; the task taken once.
  - **row 27a** (`next: plain, hold: "send"`; the daemon restarted after `accepted`, then `release`): one `accepted`; every look from the launch to the release `starting` (across the restart); then `working`, then idle with the ask.
  - **row 27b** (`refuseNext: "disconnected", historyMs: 40000`; the daemon restarted while the task is in the box, before the reconnect): after it, one Enter (`submitted` is the task, no paste of it) and `accepted` once.
  - **row 27c** (`refuseNext: "disconnected"` with `history: "fail"` for the reconnect's load, so the task sits in a `no-history` box; the daemon restarted; then loads work): Ctrl+U leaves the box empty, `/session`, the task pasted once more from an empty box, `accepted` once; no box holds it twice.
- [ ] **Step 2: Run the whole file on the base.** In a throwaway worktree, `git worktree add <scratchpad>/base 7687138398`, copy in the two e2e files, `cd cli && npm ci && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts`. Expected: rows 1-20 green but row 5's row-23 assertion; rows 21-27 red, each as the spec's "`main` today" column says; row 21b red as never held (the tell waits `openclaw_not_ready` behind the draft, held by nothing, until its bound); row 22's `watch` assertion red, its next line only at the 60 s backstop. A row 1-20 red, or a row 21-27 (or 21b, or row 22's `watch` assertion) green, is reported with its output before committing: the fake is wrong (fix the fake, never the assertion) or the spec's column was. Then `git worktree remove <scratchpad>/base` (that worktree only).
- [ ] **Step 3: Run the new rows on the branch head** (`-t 'row (5|2[1-7])'`): the same red; rows 1-20 green with the new fake.
- [ ] **Step 4: Commit (red)** `test(openclaw): the goal test meets a refused tell, a person's draft, sign-in screens, close, pushes, a respawning launcher and a restart (red)`; the report lists each row red or green on the base with its first failing assertion, and the durations hint.

### Task 2: Temporary workflow (Linux)

**TEMPORARY: removed before the merge.** One commit, no red test.

**Files:** Create `.github/workflows/tmp-openclaw-followups.yml`.

- [ ] **Step 1: Write it**, its first line `# TEMPORARY (fix/openclaw-followups): remove before the merge.`, set up as `cli-e2e.yml`'s `e2e` job is and nothing more: `on: push: branches: [fix/openclaw-followups]` only; `permissions: contents: read`; no secrets; one job on `ubuntu-24.04`, `timeout-minutes: 90`, `defaults.run.working-directory: cli`, env `LANG: C.UTF-8`, `SHELL: /bin/zsh`; `actions/checkout@v7`, `actions/setup-node@v7` with `node-version: 24.22.2` and npm cache on `cli/package-lock.json`; the tmux/zsh/tcsh/dash/lsof install, inotify `sysctl` and `compaudit` fix copied from `cli-e2e.yml`; `npm ci --no-audit --no-fund`; then, with `E2E_BUNDLE: '1'` and `E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs`: `npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts e2e/agentClient.e2e.ts e2e/identityHoldVisible.e2e.ts e2e/hermesAdmission.e2e.ts e2e/hermesTerminalRecord.e2e.ts e2e/otherEngines.e2e.ts` (`identityHoldVisible` skips on Linux and stays listed so the run says so); on failure `actions/upload-artifact@v4` of that folder, 7 days. Nothing released, published, deployed or written outside the run.
- [ ] **Step 2:** `actionlint .github/workflows/tmp-openclaw-followups.yml` reports nothing.
- [ ] **Step 3: Commit** `ci(tmp): run the OpenClaw goal test and the other engines' end-to-end files on Linux (temporary, remove before merge)`. It runs only when the branch is pushed, which waits for the orchestrator's go (Verification).

### Task 3: OpenClaw's screen: sign-in activity, the box read whole, three sentences

**Files:**
- Modify: `cli/src/engines/openclaw/contract.ts` (`OpenclawScreen`, `NOTHING`, `readOpenclawScreen`, `OPENCLAW_STATES`, new exports)
- Test: `cli/src/engines/openclaw/contract.spec.ts`
- Create: `cli/src/engines/openclaw/__fixtures__/screen-pairing.txt`, `screen-pairing-bare.txt`, `screen-token-mismatch.txt`; Modify: `__fixtures__/MISSING.md`

**Interfaces:**
- Produces:
  - `OpenclawScreen.signIn: 'approval' | 'refused' | null`: the activity after ` | ` on a status line that reads the Gateway gone (`no-gateway`, or `gatewayLost` with no state): `device approval needed…` → `'approval'`; `gateway authentication needs attention`, `gateway authentication temporarily rate-limited`, `identity-aware proxy rejected connection` → `'refused'`; null on any other line. Read off the status line only, never the chat.
  - `OPENCLAW_STATES.approval`, `.signInRefused`, `.boxHeld` (Global Constraints).
  - `export function openclawBoxExactly(box: string | null, hidden: OpenclawBoxHidden, message: string): boolean`: true only when nothing is hidden above or below, the box is no paste marker, and its text with all whitespace removed is the message's, not empty.
  - `export function openclawClearKeys(message: string): number | null`: 2n−1 for the message's n lines, null over 64.

- [ ] **Step 1: Record the screens** from a real OpenClaw 2026.11.2 on this Mac, isolated (Verification, "The real OpenClaw"): a TUI whose device the Gateway has not approved (`screen-pairing.txt` with the 5 s line, `screen-pairing-bare.txt` with `disconnected | …`), and one whose token does not match (`screen-token-mismatch.txt`). Redact nothing a request id leaves; replace the throwaway paths with the ones the other fixtures use. A screen the rig cannot reach is composed as `MISSING.md`'s "Composed" section does, from the source lines in Base, and listed there.
- [ ] **Step 2: Write the failing tests:** `screen-pairing` reads `state: 'no-gateway'`, `gatewayLost: true`, `signIn: 'approval'`; `screen-pairing-bare` reads `state: null`, `gatewayLost: true`, `signIn: 'approval'`; `screen-token-mismatch` `signIn: 'refused'`; the token screen with its activity replaced by the rate-limit and proxy activities, `'refused'`; `screen-no-gateway`, `screen-plain` and a ready screen whose chat holds `device approval needed: preview latest request`, `signIn: null`. `openclawBoxExactly`: `screen-history-refused`'s box against its message true; one more character false; `{ above: 1, below: 0 }` and `{ above: 0, below: 1 }` false; `[paste #1 +12 lines]` against a 12-line message false; `''` false; the message re-wrapped with other spaces true. `openclawClearKeys('a')` 1, `('a\nb')` 3, `('a\r\nb\rc')` 5, 64 lines 127, 65 lines null. The three sentences byte for byte.
- [ ] **Step 3: Run:** `cd cli && npx vitest run src/engines/openclaw/contract.spec.ts` fails on the new cases only.
- [ ] **Step 4: Implement** in `contract.ts`.
- [ ] **Step 5: Run** the spec, `npx vitest run src/engines/openclaw src/engines/otherScreens.golden.spec.ts` and `npm run typecheck`: pass.
- [ ] **Step 6: Commit** red, then `OpenClaw's screen says which sign-in its Gateway refused, and whether its box holds exactly a message`.

### Task 4: The binding pass holds each sign-in screen with its own sentence

**Files:** Modify `cli/src/core/agents/bind.ts` (`OPENCLAW_HOLDS`, `openclawScreenHold`, the hold's clear rule ~631); Test `cli/src/core/agents/bind.spec.ts`.

**Interfaces:** Consumes Task 3's `signIn` and sentences. Produces: a Gateway gone ≥ `GATEWAY_HOLD_MS` holds with `approval` when `signIn === 'approval'`, `signInRefused` when `'refused'`, else `noGateway`; all three are cleared by `openclawGatewayAnswered`; a change of sentence within one outage is set (`setIdentityHold`) and logged once.

- [ ] **Step 1: Failing tests** (fake `Date`, a pass every 5 s, panes from Task 3's fixtures): pairing for 10 s → held with `approval`, logged once, `announceSession` once; nothing held before 10 s; bare lines only from the first pass → `approval` after 10 s (Review Focus 5); token → `signInRefused`; an outage that began `connect ECONNREFUSED` and turns to pairing → `noGateway`, then `approval`; a connected line clears either; a `--local` run never; the first task's clock pauses while held (as for `noGateway`).
- [ ] **Step 2: Run** `npx vitest run src/core/agents/bind.spec.ts`: the new cases fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec and `npx vitest run --config vitest.core.config.ts src/core/agents/bind.spec.ts --coverage.include=src/core/agents/bind.ts`: pass, 100%.
- [ ] **Step 5: Commit** red, then `An OpenClaw waiting for its device's approval or refused its sign-in is held with what to do, not "Gateway not running"`.

### Task 5: Whether OpenClaw's store holds a user row for a key

**Files:** Modify `cli/src/lib/openclawStore.ts`; Test `cli/src/lib/openclawStore.spec.ts`.

**Interfaces:** Produces `export async function openclawUserRowSince(key: string, pane: { pid: number; stateDir?: string | null }, since: number, openFiles?: (pid: number) => Promise<string[]>): Promise<boolean | null>`: the database `openclawSessionDb` names; `SELECT 1 FROM transcript_events WHERE message_role = 'user' AND created_at > ? AND session_id IN (SELECT session_id FROM session_windows WHERE session_key = ?) LIMIT 1` through `sqliteReadAll`; true for a row, false when the file does not exist or holds none, null for a key that is not one or a read that fails.

- [ ] **Step 1: Failing tests** on a temporary store built from `__fixtures__/schema.sql` and `plain.sql`: its key since 0 true; since the user row's `created_at` false; another key false; no file false; a file that is not SQLite null; `main` (not a key) null.
- [ ] **Step 2: Run** `npx vitest run src/lib/openclawStore.spec.ts`: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run:** pass; `npm run typecheck`.
- [ ] **Step 5: Commit** red, then `Harness can ask whether OpenClaw's store holds a user message for a session since a time`.

### Task 6: Close says none was kept when OpenClaw's store holds none

**Files:** Modify `cli/src/lib/closeAgentService.ts` (`CloseAgentServiceDeps`, `attempt`'s checkpoint wrapper ~347, `changed` ~218); Modify `cli/src/core/agents/close.ts` (~97); Tests `closeAgentService.spec.ts`, `close.spec.ts`.

**Interfaces:** Consumes Task 5. Produces `CloseAgentServiceDeps.conversationEmpty?(s: RegisteredSession): Promise<boolean>`: true when the engine's own store holds nothing a resume would bring back. Read before the stop (with `keptNone`, in the `before` checkpoint) and in `changed()` (now async) for a harness closed already. A read that throws counts as kept. `close.ts` wires `s.engine === 'openclaw' && !!s.sessionId && await openclawUserRowSince(s.sessionId, { pid: s.processIdentity?.pid ?? 0, stateDir: s.openclawStateDir }, 0) === false`.

- [ ] **Step 1: Failing tests:** a bound OpenClaw row with `conversationEmpty` true closes `{ closed: true, withoutConversation: true }`, false `{ closed: true }`, throwing `{ closed: true }`; the closed-already answer the same; `close.spec.ts`: no user row → true, one → false, another engine false with no store read.
- [ ] **Step 2: Run** `npx vitest run src/lib/closeAgentService.spec.ts src/core/agents/close.spec.ts`: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both and `npx vitest run --config vitest.core.config.ts src/core/agents/close.spec.ts --coverage.include=src/core/agents/close.ts`: pass, 100%.
- [ ] **Step 5: Commit** red, then `Closing an OpenClaw agent that never took a task says no conversation was kept`.

### Task 7: A claim with no turn open is pushed at its start and its end

**Files:** Modify `cli/src/lib/turnActivity.ts`, `cli/src/core/turns/activity.ts` (`TurnActivityDeps`), `cli/src/core/turns/heartbeats.ts`, `cli/src/core/main.ts` (~1345 and ~1948: a late-bound `claimed`); Tests `turnActivity.spec.ts`, `activity.spec.ts`, `heartbeats.spec.ts`.

**Interfaces:**
- `TurnActivity` deps gain `claimed?(sessionId: string): void`: called each time an entry turns working from any other state (by `observe` or `check`) while its runtime says no turn is open; never on a renewal.
- `TurnActivityDeps.claimed?: (sessionId: string) => void`, passed through.
- `createHeartbeats(...)` returns `watchClaim(sessionId: string): void`: nothing when a beat already runs for the session; else `tell(sessionId)` at once, then on each 5 s beat: the row inactive, or a turn open, ends the watch; a snapshot that is not working is told once if it differs from what was sent, and ends the watch. A claim watch's end clears its own timer and `lastSent` only. No `turn_heartbeat`, probe, `turns.beat` or `mirror.heartbeat` in it.

- [ ] **Step 1: Failing tests:** `turnActivity.spec.ts`: `observe('turn_started')` with no turn open calls `claimed` once; progress while working does not; with a turn open never; again after the claim expired and a new one starts; a `check` that reads working with no turn open calls it. `heartbeats.spec.ts` (fake timers): **a claim with no turn open sends two frames at most**: `watchClaim` sends `agent_activity` working at once; observes every 5 s for 25 s send nothing; the claim's end sends one `agent_activity` idle within one beat; two frames in all and no `turn_heartbeat`; a second `watchClaim` while one runs sends nothing; a turn's `startHeartbeat` during a claim watch replaces it with no double frame (Review Focus); `runtimeActivity.forget` is never called by a claim watch; an inactive row ends it. `activity.spec.ts`: a busy pane read with no turn open reaches `claimed`.
- [ ] **Step 2: Run** `npx vitest run src/lib/turnActivity.spec.ts src/core/turns/heartbeats.spec.ts src/core/turns/activity.spec.ts`: fails.
- [ ] **Step 3: Implement**, and wire `claimed` in `core/main.ts` (a reference set once `turnBeats` exists).
- [ ] **Step 4: Run** the three specs and `npx vitest run --config vitest.core.config.ts src/core/turns/heartbeats.spec.ts src/core/turns/activity.spec.ts --coverage.include=src/core/turns/heartbeats.ts --coverage.include=src/core/turns/activity.ts`; `npm run typecheck`: pass, 100%.
- [ ] **Step 5: Commit** red, then `Working with no turn open is pushed when it starts and when it ends, two frames a claim`. The numbers (Verification) go in the PR, not this task.

### Task 8: `starting`'s end is announced by the binding pass

**Files:** Modify `cli/src/lib/agentFrame.ts` (~210-224), `cli/src/core/agents/bind.ts` (the OpenClaw pass); Tests `agentFrame.spec.ts`, `bind.spec.ts`.

**Interfaces:** Produces `export function openclawStartingUntil(s: RegisteredSession): number | null`: for an OpenClaw with no session, the later of `registeredAt` and its process's start plus `OPENCLAW_STARTING_MS`; null otherwise. `agentStarting` uses it. In the pass over an unbound OpenClaw with no first task waiting, the first pass at or after that time calls `announceSession(agent)` once (bounded set).

- [ ] **Step 1: Failing tests:** `openclawStartingUntil` for a row, a later process start, a bound row (null) and Codex (null); `agentStarting` as before. `bind.spec.ts`: no announcement at 59 s, one at 61 s, none at 66 s; none with a first task on the row; none once bound.
- [ ] **Step 2: Run** `npx vitest run src/lib/agentFrame.spec.ts src/core/agents/bind.spec.ts`: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both, and bind's core coverage as in Task 4: pass, 100%.
- [ ] **Step 5: Commit** red, then `An OpenClaw launched with no task is announced when its starting minute ends`.

### Task 9: The registry keeps a first task typed, durably

**Files:** Modify `cli/src/lib/registry.ts` (`RegisteredSession` ~299, the row reader ~723 and ~1488, `register` ~2392, the engine-exit path ~2593, `takeFirstTask` ~2786, new methods); Test `cli/src/lib/registry.spec.ts`.

**Interfaces:**
- `RegisteredSession.firstTaskTyped?: { text: string; at: number }`, its doc comment the spec's Design 7 in two sentences. A row holds `firstTask` or `firstTaskTyped`, never both; read with both, `firstTaskTyped` is kept (at most once).
- `takeFirstTask(agentId): Promise<string | null>`: on a bound row, moves the task in one write to `firstTaskTyped: { text, at: Date.now() }` and returns it once durable; on a row whose launch failed, drops both fields (as `failFirstTask` needs); else null.
- `untypeFirstTask(agentId: string, text: string): Promise<boolean>`: moves `firstTaskTyped` back to `firstTask` in one write, only while its text is [text]; true once durable.
- `firstTaskTaken(agentId: string): Promise<boolean>`: removes `firstTaskTyped`; true once durable, false when there was none.
- Each under `ownerGuard`, through the writer, as `takeFirstTask` is. The reader keeps `firstTaskTyped` only as a non-empty `text` and a finite `at` > 0; `register` carries it as it carries `firstTask`; the engine-exit path drops it with `firstTask`. `schemaVersion` unchanged. Logs `[agent] <sid> first task typed`, no text.

- [ ] **Step 1: Failing tests:** take moves it (the saved file has `firstTaskTyped`, no `firstTask`), returns once, a second take null; a failed launch's take drops both; untype only with the same text, back to `firstTask`; taken removes it, false the second time; the reader drops a malformed mark and keeps the typed one beside a `firstTask`; a register keeps it; an engine exit drops it; a file written and read again keeps it; a writer that fails leaves `firstTask` in place (Design 9).
- [ ] **Step 2: Run** `npx vitest run src/lib/registry.spec.ts`: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec, `npx vitest run src/core/agents/bind.spec.ts` (its mocks still fit) and `npm run typecheck`: pass.
- [ ] **Step 5: Commit** red, then `The registry keeps a typed first task until it is confirmed, so a restart cannot lose it or type it twice`.

### Task 10: A message refused into a no-history box is cleared and sent once

**Files:** Modify `cli/src/lib/sessionInput.ts` (`InputState`, `SessionInputDeps`, `retryOpenclaw` ~1256, `injectWhenLeased` ~350, new `ownsBox`); Test `cli/src/lib/sessionInput.spec.ts`.

**Interfaces:**
- Consumes Task 3: `openclawBoxExactly`, `openclawClearKeys`.
- `SessionInputDeps.untypeFirstTask?: (id: string, text: string) => Promise<boolean>`: the first task's durable move back to waiting untyped; false, or absent, and nothing is pressed.
- `SessionInputController.ownsBox(id: string, box: string | null, hidden: OpenclawBoxHidden): boolean`: true while a write or a command of Harness's is being typed into the pane, or the box shows exactly, whole, the message awaiting confirmation.
- `retryOpenclaw`: on a `no-history` pane whose box is exactly the awaiting message (`openclawBoxExactly`), not cleared before, with `openclawClearKeys` not null: for a first task, `untypeFirstTask` first; then `sendKey(agentId, 'C-u')` that many times (stopping at one that fails), the pane read again: empty → a tell waits untyped again through `injectWhenLeased`, its bound counted from its first paste, ahead of anything queued after it; a first task's wait ends with no error and its first-task flag kept (the binding pass types it again from the row). Anything left → nothing more pressed, the bound as before. Logs `[inject] <sid> openclaw · refused message cleared · <n> keys`.

- [ ] **Step 1: Failing tests** (panes from `screen-history-refused.txt`, the box `.replace()`d): **the exact box is cleared and the tell sent once** (C-u × `openclawClearKeys`, the pane read again empty, `inject` refused `openclaw_not_ready` until a ready pane, then typed once, confirmed by `onTurnStarted`, no `onError`, never `C-c`); **one more character: not cleared**, held to the bound; **a scrolled box: not cleared**; **a paste marker: not cleared**; cleared once a message (refused again after its second paste: no second clear, `The agent did not accept the message. Please try again.` 180 s after the first paste); a 3-line message gets 5 presses, a 65-line one none; the box changed under the presses (Review Focus 1): no more presses; a first task: `untypeFirstTask` before the first C-u, false → no press, its wait ends silently on success and `firstTaskWaiting` stays true; a message queued behind a cleared tell is typed after it; `ownsBox` true during a write and for the exact box, false for other text.
- [ ] **Step 2: Run** `npx vitest run src/lib/sessionInput.spec.ts`: fails on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec, `npx vitest run src/engines/otherScreens.golden.spec.ts`, `npm run typecheck`: pass.
- [ ] **Step 5: Commit** red, then `A message OpenClaw refused into its box while its history failed is cleared and sent once`.

### Task 11: The controller adopts a first task typed before a restart; wiring

**Files:** Modify `cli/src/lib/sessionInput.ts`, `cli/src/core/input.ts` (`InputDeps`, `sessionInputDeps` ~176), `cli/src/core/main.ts` (the input's deps ~1460); Tests `sessionInput.spec.ts`, `cli/src/core/input.spec.ts`.

**Interfaces:**
- `SessionInputController.adoptTypedFirstTask(id: string, text: string): boolean`: awaits [text] as a first task typed now (first-task flag, awaiting fingerprint and content, its window armed), never pasting it; false when a first task or a message already awaits for [id].
- `SessionInputController.firstTaskConfirmed(id: string): void`: the store holds its user row: the wait ends as taken (`settle('taken')`, no error, the first task ended).
- `SessionInputDeps.onFirstTaskTaken?: (id: string) => void`: once, when a turn takes the first task (`onTurnStarted`); not on a cancel or a forget.
- `InputDeps.firstTask?: { untype(agentId: string, text: string): Promise<boolean>; taken(agentId: string): void }`, mapped to `untypeFirstTask` and `onFirstTaskTaken`; `core/main.ts` wires them to `registry.untypeFirstTask` and `registry.firstTaskTaken` (its failure logged by kind).

- [ ] **Step 1: Failing tests:** adopted, a ready pane whose box holds exactly the task gets one Enter and no paste; a `no-history` box holding it is untyped, then cleared (Task 10's path); an empty box on a ready pane gets no key; adopt twice false; a message sent after the adoption waits behind it (Review Focus 3); `onTurnStarted` with the task calls `onFirstTaskTaken` once; a cancel does not; `firstTaskConfirmed` ends it with no error. `input.spec.ts`: the two deps reach `firstTask.untype` and `firstTask.taken`.
- [ ] **Step 2: Run** `npx vitest run src/lib/sessionInput.spec.ts src/core/input.spec.ts`: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both and `npx vitest run --config vitest.core.config.ts src/core/input.spec.ts --coverage.include=src/core/input.ts`; `npm run typecheck`: pass, 100%.
- [ ] **Step 5: Commit** red, then `A first task typed before a restart is awaited again, given one Enter or cleared, never pasted twice`.

### Task 12: The binding pass holds a box with text Harness did not type (`no-history` and `ready` panes)

**Files:** Modify `cli/src/core/agents/bind.ts` (`BindDeps.input` Pick, `OPENCLAW_HOLDS`, the OpenClaw pass's hold, `firstTaskOverdue` ~226); Test `bind.spec.ts`.

**Interfaces:** Consumes `input.ownsBox` (Task 10), `OPENCLAW_STATES.boxHeld` (Task 3). Produces the hold rule in "Decided here", on a `no-history` pane and on a `ready` one; `firstTaskOverdue` does not pause while the row's hold is `boxHeld`.

- [ ] **Step 1: Failing tests.** On a `no-history` pane (`screen-history-refused.txt` with the box replaced): the person's text with a first task waiting → `boxHeld`, logged once, announced; the box exactly Harness's awaiting message (`ownsBox` true) → no hold; while Harness types (`ownsBox` true) → none; the box emptied → cleared; nothing of Harness's waiting → none (the person's own TUI); at the bound with `boxHeld` set → `FIRST_TASK_NOT_TAKEN`, no task typed; `/session` still never typed into a box with text. On a `ready` pane (`screen-plain.txt` with the box replaced): **a person's draft with a tell waiting holds** (`boxHeld`, logged once, `announceSession` once, no `sendKey` or `sendLine` from the pass); a refused message with the person's draft after it (`<message>\n<draft>`, `ownsBox` false) holds the same; **it releases when the box empties** (cleared, announced once, the pass types nothing: the controller sends the tell); a draft with nothing of Harness's waiting → none; the box exactly Harness's awaiting message (`ownsBox` true) → none; a first task waiting behind a draft holds and its clock does not pause.
- [ ] **Step 2: Run** the spec: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec and bind's core coverage: pass, 100%.
- [ ] **Step 5: Commit** red, then `An OpenClaw whose box holds the person's text while Harness's message waits is held with what to do, whether or not it can send`.

### Task 13: The binding pass settles a first task typed before a restart

**Files:** Modify `cli/src/core/agents/bind.ts` (`BindDeps`, `firstTaskWaits` ~219, `handOverFirstTask` ~446, the OpenClaw pass), `cli/src/lib/agentFrame.ts` (`agentStarting`), `cli/src/core/main.ts` (bind's deps); Tests `bind.spec.ts`, `agentFrame.spec.ts`.

**Interfaces:**
- Consumes `openclawUserRowSince` (Task 5); `registry.firstTaskTaken` (Task 9); `input.adoptTypedFirstTask`, `input.firstTaskConfirmed` (Task 11).
- `BindDeps.openclawUserRowSince: typeof openclawUserRowSince`; `BindDeps.registry` Pick adds `'firstTaskTaken'`; `BindDeps.input` Pick adds `'adoptTypedFirstTask' | 'firstTaskConfirmed'`.
- `firstTaskWaits` counts `firstTaskTyped`. On each pass over a row with `firstTaskTyped`: the store's answer since `at` true → `registry.firstTaskTaken` (after the pass's transaction, as `takeFirstTask` is), `input.firstTaskConfirmed`, `announceSession`, `[agent] <sid> first task confirmed`; false or null → when this daemon did not hand it over (a bounded set `handOverFirstTask` adds to), `input.adoptTypedFirstTask(agentId, text)` once, `[agent] <sid> first task typed before a restart · awaiting confirmation`; then the bound as today, from this daemon's first pass over the row.
- `agentStarting(s, …)` is true while `s.firstTaskTyped` is set.

- [ ] **Step 1: Failing tests:** a typed row, store false, pane busy → adopted once, never `submitFirstTask`, `starting`; store true later → `firstTaskTaken`, `firstTaskConfirmed`, announced; **a mark an older daemon left** (Review Focus 4): store true on the first pass → removed, never adopted; store false to the bound with an empty box → `FIRST_TASK_NOT_TAKEN` and the row loses the mark, never a paste; store null → nothing decided, the bound still runs; a task this daemon handed over is never adopted. `agentFrame.spec.ts`: `firstTaskTyped` reads starting; the frame has no `firstTaskTyped`.
- [ ] **Step 2: Run** `npx vitest run src/core/agents/bind.spec.ts src/lib/agentFrame.spec.ts`: fails.
- [ ] **Step 3: Implement**, and wire `openclawUserRowSince` in `core/main.ts`.
- [ ] **Step 4: Run** both, bind's core coverage, `npm run typecheck`: pass, 100%.
- [ ] **Step 5: Commit** red, then `A first task typed before a daemon restart is confirmed from OpenClaw's store or failed visibly, and the agent reads starting across it`.

### Task 14: The new-pane watcher goes round again (cause confirmed first)

**Files:** Modify `cli/src/core/agents/newPane.ts` (`watchNewPane`'s confirm ~103-113 and its catch ~226); Test `newPane.spec.ts`. Only if Step 1 shows they are needed: `cli/src/lib/processTable.ts` (`selectEngineProcess` or OpenClaw's names ~762) and `processTable.spec.ts`; `cli/e2e/harness/fakeOpenclaw.mjs` (its `respawn` shape made to match the real launcher's, cited).

- [ ] **Step 1: Confirm the cause** on a real OpenClaw 2026.11.2 launch on this Mac, isolated (Verification, "The real OpenClaw"): `harness new openclaw` through a scratch `IsolatedDaemon` file with `OPENCLAW_PATH=/opt/homebrew/bin/openclaw`; record the `create watch failed · openclaw · readiness publication unavailable · <errorKind>` line, and the pane's process tree (`ps -o pid,ppid,lstart,comm,args`) every 100 ms from `create pane open` until ready. Report which process the watcher found first, which `refresh` saw, and which discovery bound. Nothing of the scratch file is committed.
- [ ] **Step 2: Failing test** from what Step 1 found. For the expected cause: the resolver returns the launcher, then the TUI child; `confirmLaunch`'s `refresh` throws `IdentityReadUnavailable`; today the watch ends with the line. Expected: the watcher goes round again within its budget, confirms the TUI's process (not the launcher's), logs `[agent] create ready · openclaw`, and no `create watch failed`; any other error still ends it with the line. If the TUI is not what the resolver selects, a `processTable.spec.ts` case: launcher and TUI child in one pane → the TUI; every other engine's selection unchanged.
- [ ] **Step 3: Run** `npx vitest run src/core/agents/newPane.spec.ts` (and `src/lib/processTable.spec.ts`): fails.
- [ ] **Step 4: Implement:** an `IdentityReadUnavailable` from the confirm sends the loop round again (the `unknown` pane's backoff, the same budget); the selection fix only if Step 2 needs it; the fake's launcher only if Step 1 showed it differs. A cause that is another gets the same rule: the watcher ends only on a real outcome.
- [ ] **Step 5: Run** the specs, `npx vitest run --config vitest.core.config.ts src/core/agents/newPane.spec.ts --coverage.include=src/core/agents/newPane.ts`, `npx vitest run src/engines/discovery.golden.spec.ts` (unchanged), and row 26 (`TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts -t 'row 26'`): pass.
- [ ] **Step 6: Commit** red, then `The new-pane watcher confirms an OpenClaw launch whose launcher starts its TUI as a child, within seconds`; the report gives Step 1's findings for the PR.

### Task 15: Tool watches are told a start, a failed launch or a hold changing

**Files:** Modify `cli/src/core/toolWatches.ts` (`TOLD`, `Told`, `toldOf`, `tell`'s agent id), `cli/src/agentClient/daemon.ts` (`PUSHED` ~54); Tests `cli/src/core/toolWatches.spec.ts`, `cli/src/agentClient/daemon.spec.ts`, `cli/src/backendSocket.toolWatch.spec.ts` (one case, no source change in `backendSocket.ts`). Not `core/main.ts` and not `agentClient/commands.ts` ("Decided here").

**Interfaces:**
- Produces: a watch naming a harness is sent `{ type: 'agent_synced', agentId, payload: { agentId } }` on its first `agent_synced` after the watch began, and on each later one whose standing key ("Decided here") differs from the last told; nothing else of the frame. `Told.standing?: string`.
- `agentClient/daemon.ts`: `PUSHED` gains `'agent_synced'`, so `Daemon.watch`'s listener hears it as any pushed event.
- Consumes: nothing from another task. Task 8's announcement is what makes `starting`'s end reach it, and Task 4's and Task 12's holds what make a reason change reach it; this task's tests build the frames themselves.

- [ ] **Step 1: Failing tests.** `toolWatches.spec.ts` (an `agent_synced` built as `sessionSync` sends it, `{ type: 'agent_synced', payload: { agent: { id, starting, launch, identityHold, namedState, name, title, … } } }`): **a hold's end is told once**: synced held, held again, then not held → two frames to the watch (first sighting, then the end), each exactly `{ type: 'agent_synced', agentId: 'a', payload: { agentId: 'a' } }`; a new hold reason (one sentence to another) told once; `starting` true then false told once; `launch.state` turning `failed` told once; a sync that changes only the name, the title or token usage after the first is told nothing; the same sync through `send` and `sendCommander` (two `tell`s) told once; another harness's sync told nothing; the existing "never gets a harness's words" case still sends nothing for an `agent_synced` with no `agent`; nothing of the agent's frame (`name`, `title`, the hold's sentence) in any frame told. `backendSocket.toolWatch.spec.ts`: an `agent_synced` through `socket.send` reaches the tool as `{ type: 'agent_synced', agentId: 'a', payload: { agentId: 'a' } }` and the window whole. `daemon.spec.ts` (beside "names the harnesses, and hears each pushed state event of one of them"): a pushed `{ type: 'agent_synced', agentId: 'a', payload: { agentId: 'a' } }` reaches the listener for `a`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/toolWatches.spec.ts src/agentClient/daemon.spec.ts src/backendSocket.toolWatch.spec.ts`: the new cases fail.
- [ ] **Step 3: Implement** in `toolWatches.ts` and `daemon.ts`.
- [ ] **Step 4: Run** the three specs, `npx vitest run src/agentClient/commands.spec.ts` (unchanged, passing), `npx vitest run --config vitest.core.config.ts src/core/toolWatches.spec.ts --coverage.include=src/core/toolWatches.ts` and `npm run typecheck`: pass, 100%.
- [ ] **Step 5: Commit** red, then `wait and watch hear at once when an agent's start, failed launch or hold changes, not a minute later`. The frame count goes in the PR with decision 4's numbers (Verification), not this task.

## Verification

**Per task (this Mac, nothing outside the worktree):** the unit tests and targeted core coverage each task names; `npm run typecheck`.

**Local gates PR CI does not run (receipts in the PR body, once, at the final head, from a clean tree):** `python3 scripts/local-checks.py --run` (plans `cli-core` and the others the paths need: `npm run test:core` at 100% per file for `bind.ts`, `close.ts`, `input.ts`, `newPane.ts`, `turns/heartbeats.ts`, `turns/activity.ts`, `toolWatches.ts`), `npm run test:portability`, `npm run typecheck`; and `git diff --exit-code 7687138398 -- cli/src/architecture.coreFiles.txt`, `npx vitest run src/architecture.spec.ts src/engines/otherScreens.golden.spec.ts src/engines/discovery.golden.spec.ts`.

**The goal test.**
- *Red on the base:* Task 1 Step 2; the PR lists each row's result and first failing assertion.
- *Green on this Mac:* at the final head, `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts`, then again with `E2E_BUNDLE=1`; and `e2e/agentClient.e2e.ts e2e/identityHoldVisible.e2e.ts e2e/hermesAdmission.e2e.ts e2e/hermesTerminalRecord.e2e.ts e2e/otherEngines.e2e.ts` unchanged and passing.
- *Green on Linux:* the temporary workflow (Task 2) runs on the branch's push, `ubuntu-24.04`, the same files. The push, and so this heavy run, waits for the orchestrator's go, which the main session asks for. Report the run's link.
- Isolation is `IsolatedDaemon`'s own: a private root, home, data and runtime folders, its own port and tmux server, signed out, the backend at `ws://127.0.0.1:9`, the fake at `OPENCLAW_PATH` with its state folder under the root. No account, no real OpenClaw, Gateway or model; the computer's own daemon (port 18473), tmux and `~/.openclaw` are never touched.

**The real OpenClaw, isolated (tester, this Mac, not in CI; Tasks 3 and 14 use the same rig for their first steps).** #4499's rig (a Gateway start/stop script, a WebSocket proxy that drops one `chat.history`, a stub OpenAI-compatible model, a scratch `IsolatedDaemon` e2e file), whose folder the main session hands over, copied into the tester's own scratchpad (never edited in place); rebuilt with the same parts when it is gone. Isolation: `HOME` and `OPENCLAW_STATE_DIR` in that scratch copy, `env -i` with only `PATH`, `HOME`, `OPENCLAW_STATE_DIR` and `TERM`; `openclaw gateway --port <a free port>` (asked of the OS, never 18789); the stub model on a free loopback port; the scratch e2e file copied into `cli/e2e/` for the run only and deleted after. On the branch head:
- item 6: the `create watch failed` line gone and `create ready` from the watcher within seconds (Task 14 recorded the cause on the base);
- the pairing screen (a TUI whose device the Gateway has not approved) held with `approval`, and a token mismatch held with `signInRefused`, each after 10 s, cleared when fixed;
- a person's message refused while the proxy drops a reconnect's `chat.history`: cleared, `/session`, delivered once (the stub logs it once).
Stop only the pids the rig's own files recorded.

**The slow-device box (tester, this Mac, Podman).** The rig the main session hands the tester (arm64 Debian 12, CPU-limited, 4 GB, throttled disk), on the one Podman machine named in the tester's brief; no other Podman machine, container runtime or computer. 10 runs of `new` + polling `show` on `7687138398` and on the branch head: how often the watcher's line appears, the time from `create pane open` to `create ready`, the first task's time to taken; one daemon restart in the typing window (after the task is typed, before its user row): `starting` across it, typed once, then `working`; stub model by default. Two real-model runs only with a key file the main session hands over (**needs the user**: their own model key), piped into the box only, owner-only, removed and checked gone afterwards. The PR gets base against branch from the rig's summaries. Afterwards the rig's own stop commands, nothing else.

**Numbers (decision 4, a hot path; tester, this Mac).** A scratch e2e file (never committed), the same on a throwaway worktree at `7687138398` and on the branch head, back to back, same toolchain, `E2E_BUNDLE=1`: an `IsolatedDaemon` with 6 Claude Code and 6 Codex fakes (`e2e/harness/fakeEngine.mjs`) and 6 OpenClaw fakes; a `LocalClient` counting `agent_activity` and `turn_heartbeat` frames a second; a tool connection (`tool: true`, `agents_watch` on 8 of the agents, 2 of each engine and 2 more OpenClaw) counting the frames it is told a second, by type (`agent_synced` among them on the branch); and the core's CPU (`ps -o time=` on the core's pid, as `e2e/perf.e2e.ts` reads it), over a 60 s idle window and a 60 s window with one agent of each engine turning; the time from a claim's end to `wait`'s return (row 24's workload, five times); and the time from a hold's end to a held agent's `watch` printing its next line (row 22's workload, five times). The PR gets the table, base against branch.

**Nothing against production, no real person's account:** every check is local, on the slow-device box, or a GitHub run of this branch; signed out throughout.
