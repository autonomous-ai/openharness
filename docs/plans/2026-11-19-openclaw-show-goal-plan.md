# OpenClaw in `harness show`: the first task, and every state, right — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges, and every task but Task 1 ends green (Task 1 is the goal test: it stays red until the fixes land).

**Goal:** An OpenClaw agent started with a task gets that task typed once, whenever its TUI can send it, and until it is taken every verb says `starting`; it fails visibly when it cannot; `show`, `ps`, `wait` and `watch` agree at every state of the matrix; the Gateway hold holds only a lasting outage.

**Architecture:**
- **One reading of the pane** (`cli/src/engines/openclaw/contract.ts` `readOpenclawScreen`) gains the states `starting` (`connecting`, `starting up`) and `no-history` (a ready status line over `history failed:` / `session history not ready` system lines), a busy pattern for any spinner line with a `• Ns` timer, the status line itself and the input box's text. Everything else asks it.
- **The core's binding pass** (`cli/src/core/agents/bind.ts`) holds `noGateway` only after 10 s, types `/session <key>` into an empty box when history failed, hands the first task over in the pass that clears a hold or binds the session, and fails the launch `FIRST_TASK_NOT_TAKEN` once 3 minutes have passed since the TUI started, not counting time the agent was held. The **submission controller** (`cli/src/lib/sessionInput.ts`) presses Enter on a refused OpenClaw message only when the pane reads ready with the text in its box, and never gives a first task up before that bound.
- **The frame carries `starting: boolean`** (not `launch: starting`, see "Decided here"); the verbs read `starting`, `failed` and `held` through one function, `listedStateOf` in `cli/src/agentClient/model.ts`. OpenClaw's changing run timer is work evidence for inspect and for the runtime activity reader, fed by the heartbeat during an open turn and by the binding pass's own capture otherwise.

**Tech Stack:** TypeScript (Node 24, vitest) in `cli/`; a Node `.mjs` fake TUI for the end-to-end test; a GitHub Actions workflow (temporary). No Dart change.

**Spec:** `docs/plans/2026-11-19-openclaw-show-goal-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` ("Protect the core", Rules 4-6), `cli/src/core/AGENTS.md` (rule 6: evidence newer than the state it contradicts) and `docs/validation-and-release.md`.

## Base

- `fix/openclaw-show-goal` at `60aa30b528`. The spec and this plan are untracked; the main session commits them, no task does.
- Nothing is installed in this worktree (no `cli/node_modules`): the first task to run, whichever it is, runs `npm ci` in `cli/`.
- Line numbers are the base's. A task follows the expression it names when a line has moved.
- Reference only, never copied into the repo: the reproduction in
  `/private/tmp/claude-502/-Users-nqhieu84-orca-workspaces-openharness-openclaw-show-goal/ea4def4d-3035-400e-bbcc-c55800dd92e1/scratchpad/repro/`
  (`timeline-*.txt`, `pane-*.txt`, `daemon-*.log`) and OpenClaw 2026.11.2's TUI,
  `/opt/homebrew/lib/node_modules/openclaw/dist/tui-DRVGqw2R.mjs`. What it says, checked for this plan:
  - `onConnected` (7556-7615) awaits `loadHistory` before it sets `isConnected` and draws `gateway connected` /
    `gateway reconnected` (4 s, then `connected`); a failed load prints `history failed: <error>` (6031-6036) and the
    TUI still draws connected, with `historyLoaded` false.
  - A message refused for any reason (`not connected to gateway — message not sent`, `session history not ready — wait
    or retry /session`, `agent is busy — press Esc to abort before sending a new message`) goes back into the input box
    (`restoreBlockedEditor`, 6164-6188). A slash command is never refused there and leaves the box empty.
  - `/session <key>` runs `setSession(key)` (3027-3029, 3148): when the key changed or history is not loaded it loads
    history again. A load that succeeds clears the chat (`chatLog.clearAll()`) and adds ` session <key>`, so a stale
    `history failed:` line is gone from the screen; one that fails adds another `history failed:` line. `/session`
    with no key opens a picker: Harness always passes the key.
  - Busy statuses (6740-6747): `sending`, `waiting` (drawn as a random phrase with `…`), `streaming`, `running`,
    `finishing context`, `starting up`, each drawn `<spinner> <status> • <elapsed> | <connection>`, the elapsed time
    `Ns` or `Nm Ns` (7087-7091), restarting when the status changes.
  - System lines in the chat are drawn with one leading space (` session agent:main:plain`, ` history failed: …`,
    ` run error: …`); the person's and the model's text start at column 0 (`__fixtures__/screen-plain.txt`,
    `screen-fail.txt`, `screen-approval.txt`).

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The goal test and the fake OpenClaw | `cli/e2e/harness/fakeOpenclaw.mjs` (new), `cli/e2e/openclawShow.e2e.ts` (new) | none | xhigh | itself: committed red (rows listed in the task) |
| 2 Temporary workflow (Linux, Node 24.22.2) | `.github/workflows/tmp-openclaw-show-goal.yml` (new) | 1 | medium | none: temporary, one commit, removed before the merge |
| 3 One reading of OpenClaw's screen | `cli/src/engines/openclaw/contract.ts`, `contract.spec.ts`, `runtimeProfile.ts`, `runtimeProfile.spec.ts`, new `__fixtures__/screen-*.txt`, `__fixtures__/MISSING.md`, `cli/src/engines/__fixtures__/other-screens.golden.json` | none | high | `contract.spec.ts`, `runtimeProfile.spec.ts` (new cases) |
| 4 The verbs read starting, failed and held from one function | `cli/src/agentClient/model.ts`, `model.spec.ts`, `commands.ts`, `commands.spec.ts` | none | high | `model.spec.ts`, `commands.spec.ts` (new cases) |
| 5 An OpenClaw run reads as work on its screen | `cli/src/engines/openclaw/runtimeProfile.ts`, `runtimeProfile.spec.ts`, `cli/src/lib/legacyScreen.ts`, `other-screens.golden.json` | 3 | high | `runtimeProfile.spec.ts` (new cases) |
| 6 The run timer reaches the frame's activity | `cli/src/lib/runtimeActivity.ts`, `runtimeActivity.spec.ts`, `cli/src/lib/turnActivity.ts`, `turnActivity.spec.ts`, `cli/src/core/turns/activity.ts`, `activity.spec.ts`, `cli/src/core/main.ts` | 5 | high | `runtimeActivity.spec.ts`, `turnActivity.spec.ts`, `activity.spec.ts` |
| 7 The Gateway hold waits 10 s and holds through the outage | `cli/src/core/agents/bind.ts`, `bind.spec.ts` | 3 | xhigh | `bind.spec.ts` (new cases) |
| 8 An OpenClaw message waits for a ready pane; the first task is tracked | `cli/src/lib/sessionInput.ts`, `sessionInput.spec.ts`, `cli/src/core/input.ts`, `input.spec.ts` | 3 | xhigh | `sessionInput.spec.ts`, `input.spec.ts` (new cases) |
| 9 The binding pass: `/session`, one pass, the 3-minute bound | `cli/src/core/agents/bind.ts`, `bind.spec.ts`, `cli/src/core/main.ts` | 3, 7, 8 | xhigh | `bind.spec.ts` (new cases) |
| 10 A failed OpenClaw launch is kept and shown | `cli/src/core/agents/newPane.ts`, `newPane.spec.ts`, `cli/src/core/agents/discovery.ts`, `discovery.spec.ts`, `cli/src/core/main.ts` | 3 | xhigh | `newPane.spec.ts`, `discovery.spec.ts` (new cases) |
| 11 The frame says starting | `cli/src/lib/agentFrame.ts`, `agentFrame.spec.ts`, `cli/src/lib/cloudAgents.ts`, `cli/src/core/main.ts` | 8 | high | `agentFrame.spec.ts` (new cases) |
| 12 No question parse on OpenClaw's chat (only if Task 1 shows one) | `cli/src/lib/questionPane.ts`, `cli/src/lib/questionPane.spec.ts` (new), `__fixtures__/screen-numbered-list.txt` (new), `other-screens.golden.json` | 1 | medium | a new case; skipped with no commit when rows 14/14b are green on the base |
| 13 Copy: `failed` and exit 1 | `cli/src/agentClient/commands.ts` (`WAIT_USAGE`), `plugins/harness/skills/harness/SKILL.md`, `docs/cli.md`, `website/public/agents/index.html`, `website/public/llms.txt` | 4 | medium | none: copy, one commit |

**Longest chain:** 3 → 7 → 9, 3 → 8 → 9, 3 → 5 → 6 and 3 → 8 → 11 (three tasks each). Tasks 1, 3 and 4 start at once.

**Shared files, in this order** (the scheduler runs no two at once; a later task builds on the earlier one's edit):
`contract.ts`/`runtimeProfile.ts`: 3, then 5 · `other-screens.golden.json`: 3, 5, 12 (each re-records it) · `bind.ts`/`bind.spec.ts`: 7, then 9 ·
`core/main.ts`: 6, 9, 10, 11 (each a wiring line or two) · `commands.ts`: 4, then 13.

## Global Constraints

- Exact copy, byte for byte:
  - failure, frame `launch`: `{ state: 'failed', error: 'FIRST_TASK_NOT_TAKEN', detail: 'OpenClaw did not take the first task. Close it and start it again.' }`
  - no token: `{ state: 'failed', error: 'OPENCLAW_NO_TOKEN', detail: OPENCLAW_STATES.noToken }` (`OpenClaw has no Gateway token. Run openclaw onboard.`)
  - `show` line 1: `<n> on <m>: <state> · OpenClaw · started by <who>`; a failure's line: `failed: <detail>` (existing `failedLine`)
  - `wait`, a harness here whose launch failed: `<n>: failed · <detail>`; held: `<n>: held · <sentence> Only the person can fix this.` (existing)
  - the history remedy typed into the pane: `/session <key>`, `<key>` the full `agent:<id>:<key>` the footer names
- Numbers: Gateway hold after 10 s of `gateway disconnected`; `/session` at most once every 20 s and 5 times in a row; the first task's bound 3 minutes from the TUI's start, paused while the agent is held; one try of a submission keeps its 30 s (three 10 s windows, `OPENCLAW_SUBMIT_VERIFY_MS`); an unbound OpenClaw is `starting` for 60 s from its launch.
- The core's process gains no file: `cli/src/architecture.coreFiles.txt` is unchanged (every task checks `git diff --exit-code 60aa30b528 -- cli/src/architecture.coreFiles.txt`). `src/core` and `src/services` stay at 100% per file (`npm run test:core`).
- Nothing is pasted twice: a retry is Enter only, and only on a ready pane whose box holds the message. Every wait and retry is bounded. No fixed sleeps in tests (wait on a condition with `until`).
- Hermes and every other engine read exactly as before: the golden re-records change OpenClaw's entries only (new inputs add rows for every engine; no existing row of another engine changes).
- No new state word or command, no Desktop or mobile change, no new setting. No measured field: `FIRST_TASK_NOT_TAKEN` and `OPENCLAW_NO_TOKEN` count as `unlisted` in product usage (`launchErrorCode`), as `OPENCLAW_FOLDER_IN_USE` does.
- Commits and the PR describe the client generically ("a client polling show after new") and name no customer.
- Platforms: shared TypeScript (macOS, Linux, Windows). The goal test runs on macOS and Linux (tmux); Windows is covered by the unit tests.

## Decided here, where the spec left it to the builder

- **A boolean frame field, not `launch: starting` (decision 4's escape clause).** `launch.state === 'starting'` on a live row changes: discovery's exit handling (`core/agents/discovery.ts:347`, dormant instead of retained), the reconciler's probe (`lib/terminalAgentReconciler.ts:325,471`, a missing process is not an exit), runtime validation (`lib/terminalBackendCoordinator.ts:130`), the parked-shell check (`core/terminals/sessions.ts:23`), the Store's runtime (`core/wifiAgents.ts:41`), restore with a native token (`lib/restoreAgents.ts:485,532`), `harness ensure` (`agentClient/ensure.ts:98,194`) and the gateway's launch-state measure (`gateway/gateway.ts:359`); and discovery's `confirmLaunch` would set it back to `ready` on its next pass. So the frame gets `starting: boolean` (always present, as the frame's fields are), and the row's `launch` is left alone.
- **Who is starting** (`agentStarting`): the row still holds its first task; or the first task was typed and its user row has not confirmed it (the controller's `firstTaskWaiting`); or an OpenClaw row with no session bound within 60 s of its launch (the later of `registeredAt` and the bound process's `startMarker`).
- **The fake's step file:** JSON lines the test appends to, read from the file's end at start, as `fakeHermes.mjs` does; and an event log the fake writes, which the test reads (Task 1 Interfaces).
- **The 10 s hold's bookkeeping:** in memory in `bind.ts`, per agent, the time the first `gateway disconnected` line was read since the last ready line; bounded at 256 entries like `openclawFolderReads`.
- **The `/session` tries:** in memory in `bind.ts`, per agent `{ tries, lastAt }`; a pass that reads any state but `no-history` starts the count again ("per connection": a reconnect or a load that succeeded ends the run of failed loads).
- **Where the bound is kept:** the binding pass enforces it, for a task still on the row and for one typed and unconfirmed, from the latest of the TUI process's start (`observed.processIdentity.startMarker`, ignored when it does not parse), the row's `registeredAt` and this daemon's first pass over the row. A resume keeps its old `registeredAt`, so the row's own time would fail a resumed task at once.
- **The bound pauses while held (decision 11):** it counts only the time the row carries no `identityHold` (every named held state the frame shows, `agentFrame.ts:265`, comes from it). The bookkeeping is in memory in `bind.ts`, per agent `{ seenAt, heldMs, heldSince? }`, bounded at 256 entries like `openclawFolderReads`; holds are in memory too (`registry.ts:712`), so after a daemon restart the bound starts again from the new daemon's first pass (never early, at worst late).
- **`launch: failed` on a live row (decision 11):** `registry.setLaunch` makes a failed row inactive (`registry.ts:2730`), and discovery's next pass over the still-running TUI would call `confirmLaunch` (`discovery.ts:193,236`), setting it back to `ready` and active. So discovery leaves a launch failed `FIRST_TASK_NOT_TAKEN` alone while the same TUI process runs (the row stays inactive, the Desktop shows its failed launch); a new process in the pane confirms as usual (Task 10).
- **Known limit: a daemon restart while a typed first task awaits its user row (decision 11).** The row lost the task when it was typed (at-most-once) and the wait is in memory only, with no registry change: after a restart in that window the agent reads `idle` with no ask, the text possibly left in OpenClaw's box. The PR body says so.
- **Every OpenClaw submission waits for a ready pane, not only the first task:** a pane that is not ready is not counted against the retries, and that wait is bounded at 3 minutes from the paste (`OPENCLAW_NOT_READY_MAX_MS = 180_000`); for a first task the binding pass's bound from the launch comes first. A non-first message keeps today's 30 s try and its "did not accept" error on a ready pane.
- **Row 13's `ps`:** with no turn open nothing probes the runtime, so the binding pass, which already captures an OpenClaw pane every pass while a message awaits confirmation (`bind.ts:455`), hands that capture to the runtime activity reader (`TurnActivity.check` with the reading as its probe): no second capture.
- **`running` keeps its meaning** (`running`, `streaming`): `sending` and a waiting phrase are busy but not `running`, so the store-mismatch check (`live.ts` `NO_SESSION_MS`, 30 s) never fires on a Gateway that is only slow to write the first row (15-45 s measured).
- **`wait` and `watch` read up to four pages** for the last turn, as `show` does (`readLastTurn(t)`): it stops at the first page with a turn, so the usual cost is one page.
- **`wait` exits 1 only for a launch that failed on its machine (decision 11):** a frame that is not a cloud harness with `launch.state === 'failed'` (`FIRST_TASK_NOT_TAKEN`, `OPENCLAW_NO_TOKEN`, and any other launch failed there). A harness that never started (the ledger's refused creation) and a cloud harness that failed keep exit 4, which existing clients rely on. Precedence 124, 3, 1, 4, 0.
- **Row 20 is end to end:** the fake answers `--version` with the old-Node warning (`__fixtures__/version-old-node-darwin.txt`), which costs nothing.
- **The "create watch failed · readiness publication unavailable" line** is on this path (the create watch of every launch) and names no cause: Task 10 makes it name the error's class and message (control characters out, 200 characters at most). The reproduction logged it once and the scratch logs no longer hold it; a tester greps for it (Verification).

## Review Focus

1. **The person types into the TUI while the first task waits.** Harness never types `/session` into a box with text, and never presses Enter on a box that holds anything but the message. Tests: Task 9 (`/session` only into an empty box), Task 8 (no Enter on other text).
2. **A model's answer containing `history failed:`** (at column 0) must not read as `no-history`: only system lines (one leading space, exact text) do. Test: Task 3.
3. **A FIRST_TASK_NOT_TAKEN agent can still be closed**, and discovery does not bring it back to `ready`. Tests: Task 1 row 5 (`harness close` exits 0, the row goes `stopped`), Task 10 (discovery leaves it).
4. **A reconnect between two disconnects** starts the 10 s again; a remote, no-token or local-stop hold keeps its own set and clear rules. Test: Task 7.
5. **A resumed OpenClaw with a first task** is bounded from its TUI's start, not its old `registeredAt`. Test: Task 9.

---

### Task 1: The goal test and the fake OpenClaw

**Files:**
- Create: `cli/e2e/harness/fakeOpenclaw.mjs`
- Create: `cli/e2e/openclawShow.e2e.ts`

**Interfaces:**
- Produces, in `fakeOpenclaw.mjs` (built as `fakeHermes.mjs` is, its doc comment saying what it does of OpenClaw 2026.11.2 and what it does not):
  - `export function fakeOpenclawScript(options: { steps: string, events: string, version?: string, oldNode?: boolean, noToken?: boolean, startup?: 'auto' | 'manual', history?: 'ok' | 'fail' | 'fail-always' }): string` — the text of the `openclaw` the test writes at `OPENCLAW_PATH`.
  - `export function run(options)`: `--version` prints `OpenClaw 2026.11.2 (b556fdf)` (with `oldNode`, the text of `src/engines/openclaw/__fixtures__/version-old-node-darwin.txt`) and exits 0. `tui [--session <key> | <agent:id:key>] [--local]`: sets `process.title = 'openclaw'`; resolves the state folder as `openclawDefaultStateDir` does; keeps `<state>/state/openclaw.sqlite` open for its whole run; creates `<state>/agents/main/agent/openclaw-agent.sqlite` from `__fixtures__/schema.sql` when missing. With `noToken` it prints `screen-no-token.txt`'s lines and exits 1 at once.
  - It draws whole screens in raw mode at the pane's width, only shapes recorded in `__fixtures__/screen-*.txt` or the strings the spec quotes: the banner (`🦞 OpenClaw 2026.11.2 (b556fdf) — <tagline>`, no footer), then the title, chat (system lines with one leading space), status line, footer, and the input box between two rules. Startup: banner → `connecting | idle` → `⠙ starting up • Ns | subscribing to session events` (history loading) → ` history failed: gateway request timeout for chat.history` when the load fails → `gateway connected | idle` (or `gateway reconnected | idle`), which becomes `connected | idle` 4 s later. `auto` walks it within about 2 s; `manual` waits for `{"advance":true}` at each step. A busy line redraws each second with its timer.
  - Input as the TUI takes it: printable and bracketed-paste text into the box, Enter submits, `C-u` clears. A message is refused when not connected (`not connected to gateway — message not sent`), when history is not loaded (`session history not ready — wait or retry /session`) or while a run is pending (`agent is busy — press Esc to abort before sending a new message`), and goes back into the box. `/session <key>` reloads history (by the `history` mode) and leaves the box empty; a load that succeeds clears the chat and adds ` session <key>`.
  - An accepted message: writes its user row and the run's rows into the agent store shaped as `plain.sql` (`reply: plain`), `tool.sql` (`tool`), `fail.sql` (`fail`: ` run error: …`, `connected | error`, node `failed`), `approval.sql` (`approval`: the Gateway's denial), with the key, ids, times and the message substituted; draws `⠋ sending • 0s | connected`, a waiting phrase (`⠼ flibbertigibbeting… • Ns | connected`), `⠦ running • Ns | connected`, the answer, then `connected | idle`.
  - Steps (one JSON object a line in `options.steps`): `{"advance":true}`; `{"gateway":"down"|"up"}` (down: the TUI's reconnect tries at 1, 2, 4, 8, 16, then 30 s, each failed one drawn `gateway disconnected: connect ECONNREFUSED 127.0.0.1:<port> | idle` for 5 s and `disconnected | idle` between; up: the next try connects through startup); `{"blip":<ms>}` (a drop that reconnects by itself after `<ms>`); `{"history":"ok"|"fail"|"fail-always","historyMs"?:<ms>}`; `{"next":{"reply":"plain"|"tool"|"list"|"approval"|"fail","quietMs"?:<ms>,"hold"?:"send","heartbeats"?:<n>}}` (what the next accepted message does: `quietMs` a tool step that writes nothing for that long; `hold: "send"` stays in `sending`/the waiting phrase with no row until `{"release":"send"}`; `heartbeats` that many heartbeat runs shaped as `main-heartbeat.sql` after the answer; `list` answers with a numbered list); `{"refuseNext":"disconnected","historyMs":<ms>}` (the next submit meets a Gateway drop: refused, text back in the box, reconnect at once with a history load of `<ms>`); `{"localStop":"<reason>"}` (`local runtime stopped: <reason> | idle` for 5 s, then `local stopped | idle`); `{"exit":<code>}`.
  - Event log (`options.events`, JSON lines, each with `at` in ms): `{"drawn":<status line>}` on each status change, `{"submitted":<box text>}`, `{"accepted":<text>}`, `{"refused":<reason>}`, `{"command":"/session <key>"}`, `{"history":"ok"|"failed"}`.
- Consumes: `IsolatedDaemon`, `until`, `LocalClient` (`e2e/harness/`); the `harness()` runner of `e2e/identityHoldVisible.e2e.ts` (a person's shell, `TMUX_PANE: ''`); `client.send('message', { agentId, content })` for a person's later message; `OPENCLAW_STATES`, `openclawLocalStopped` (`src/engines/openclaw/contract.ts`).
- The test's rig sets `d.env.OPENCLAW_PATH`, `d.env.OPENCLAW_STATE_DIR` (under `d.root`) and writes whatever `harness new openclaw` reads before launching (find it from `src/engines/nativeLaunch.ts` and `src/engines/openclaw/`), all inside `d.root`. `describe.runIf(process.platform !== 'win32')`.

- [ ] **Step 1: Write the fake and the test.** Helpers in the test: `rig({ ...fakeOptions })`, `step(obj)`, `events()`, `look(name)` → `{ line1, text, json, ps }` from `show <n>`, `show <n> --json` and `ps --json`'s row; `waited(name, timeout)` → `{ code, out }`; `keepsWaiting(name)` asserts `wait <n> --timeout 3s` exits 124; `sample(name, until)` polls `look` about once a second and returns every sample. One `it` per group, each with its own daemon and timeout:
  - **rows 1-3** (`startup: manual`): banner, then `connecting`, then `starting up`, each: line 1 `x on <m>: starting · OpenClaw · started by person`, JSON `state: 'starting'`, `next[0].run` a `wait`, ps `starting`, `keepsWaiting`. Then `advance` to connected and `sample` until the fake logs `accepted`: every sample `starting`. A `watch x --json --timeout 20s` started at launch prints `started` first.
  - **row 4** (`history: fail`, then ok): the fake logs `{"history":"failed"}`, then a `/session agent:main:harness-<id>` command, then the task `accepted` once; every sample before it `starting`; then `working`, then `idle`; `wait x --timeout 2m` exits 0.
  - **row 5** (`history: fail-always`): `/session` commands at least 20 s apart and at most 5; within 3 min 30 s, show `state: 'failed'`, line `failed: OpenClaw did not take the first task. Close it and start it again.`, `failure.error: 'FIRST_TASK_NOT_TAKEN'`; ps `failed`; `wait` exits 1 with `x: failed · OpenClaw did not take the first task. Close it and start it again.`; the task never `accepted`; then `harness close x` exits 0 and `ps --all --json` shows it `stopped` (timeout 5 min).
  - **row 6** (`next` plain, `refuseNext: disconnected, historyMs: 25000`): the fake logs `refused`, then `accepted` once; the box never held the task twice (`submitted` texts); `starting` until accepted, then `working`; `wait` 0 at the end.
  - **row 7** (the Gateway down at launch, `up` 20 s after the launch): ps and show never `held` before 10 s after the first `gateway disconnected` draw; `held` (`needsPerson: true`, `namedState` the noGateway sentence) by the time the outage passed 15 s, and `wait` exits 3 then; after `up`: `starting`, then `working`; the task `accepted` once, less than 10 s after the fake's `gateway connected` draw (main needs three 5 s passes); no sample `failed`. (An agent held longer than 3 minutes that then recovers is covered by Task 9's unit test: the fake runs on the real clock, so it would add 3.5 minutes to every run.)
  - **row 8** (an agent idle after a first turn; `gateway: down` 40 s, then up): once `held`, every sample until the fake draws connected says `held`, line 2 `held: OpenClaw Gateway is not running. Start it with openclaw gateway.`, `next[0].tell` `tell the person: <sentence>`; `wait` exits 3 with `x: held · <sentence> Only the person can fix this.`; idle again after.
  - **row 9** (idle after a first turn; `blip: 4000`): no sample `held`; a `wait x --timeout 30s` started with the blip does not exit 3.
  - **row 10** (`noToken`): show `failed`, line `failed: OpenClaw has no Gateway token. Run openclaw onboard.`, `failure.error: 'OPENCLAW_NO_TOKEN'`; ps `failed`; `wait` exits 1.
  - **rows 11, 12, 13, 15, 16** (one agent): first task with `next: tool, quietMs: 45000` — every sample from the fake's `running` draw to the end of the quiet step says `working` in show and ps (rows 11, 12); idle after with `asked:`/`answer:` lines and `wait` 0 with `x: idle · read it: harness show x` (row 15); a person's message (`client.send('message', …)`) with `next: plain, hold: send`: show and ps `working` while the fake holds it (row 13), then `release`; a message with `next: tool, heartbeats: 90`: show `answer (after N tool calls):` the text after the last tool; `wait --json` ends 0 and `watch x --json --timeout 60s` prints a `done` line whose answer is that text (row 16).
  - **rows 14, 14b, 17** (one agent each, `reply: approval`, `list`, `fail`): show `idle`, never `needs the person`, the answer carries the denial / the list / OpenClaw's error; ps `idle`; `wait` 0.
  - **row 18** (`--local` run; `localStop: "out of memory"`): `held`, `namedState: openclawLocalStopped('out of memory')`, `wait` exits 3. If a `--local` launch needs more of OpenClaw than the fake can give, say so in the test and the report (the row stays covered by `bind.spec.ts`).
  - **row 19**: `harness close x` → show `stopped`, ps hides it and `ps --all` shows it, `wait` exits 0 for the closer (a second agent whose TUI exits, `{"exit":0}`: `wait` exits 4).
  - **row 20** (`oldNode`): `harness new openclaw …` refuses: non-zero exit with `OpenClaw needs Node 24.` in its output; no harness listed.
  - `onTestFailed` prints the daemon log's last 200 lines and the fake's event log.
- [ ] **Step 2: Run it on the base and record which rows fail.** `cd cli && npm ci && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts`. Expected red: rows 1-3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16. Expected green: 11, 15, 18, 19, 20. Decided by the run: 14, 14b, 17 (if 14 or 14b shows `needs the person`, Task 12 runs). A row green that was expected red, or a red one expected green, is reported with its output before committing: either the fake is wrong (fix the fake, never the assertion) or the spec's "Today" was.
- [ ] **Step 3: Commit (red)** `test(openclaw): the goal test walks an OpenClaw agent through every state of show, ps, wait and watch (red)`; the report lists each row red or green on the base.

### Task 2: Temporary workflow (Linux, Node 24.22.2)

**TEMPORARY: removed before the merge.** One commit, no red test.

**Files:** Create `.github/workflows/tmp-openclaw-show-goal.yml`.

- [ ] **Step 1: Write it**, its first comment line `# TEMPORARY (fix/openclaw-show-goal): remove before the merge.` Set up as `cli-e2e.yml`'s `e2e` job does, nothing more:
  - `on: push: branches: [fix/openclaw-show-goal]` only; `permissions: contents: read`; no secrets; one job on `ubuntu-latest`, `timeout-minutes: 60`, `working-directory: cli`, env `LANG: C.UTF-8`, `SHELL: /bin/zsh`.
  - Steps: `actions/checkout@v7`; `actions/setup-node@v7` with `node-version: 24.22.2`, npm cache on `cli/package-lock.json`; the tmux/zsh/tcsh/dash/lsof install, inotify `sysctl` and `compaudit` fix copied from `cli-e2e.yml`; `npm ci --no-audit --no-fund`.
  - Run, with `E2E_BUNDLE: '1'` and `E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs`:
    `npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts e2e/agentClient.e2e.ts e2e/identityHoldVisible.e2e.ts e2e/hermesAdmission.e2e.ts e2e/hermesTerminalRecord.e2e.ts e2e/otherEngines.e2e.ts`
    (`identityHoldVisible` skips on Linux; it stays listed so the run says so).
  - On failure, `actions/upload-artifact@v4` of that folder (7 days). Nothing released, published, deployed or written outside the run.
- [ ] **Step 2:** `actionlint .github/workflows/tmp-openclaw-show-goal.yml` (installed on this Mac) reports nothing.
- [ ] **Step 3: Commit** `ci(tmp): run the OpenClaw goal test and the other engines' e2e on Linux (temporary, remove before merge)`.

### Task 3: One reading of OpenClaw's screen

**Files:**
- Modify: `cli/src/engines/openclaw/contract.ts:48-59` (`STATUS`), `:71-95` (`OpenclawPaneState`, `OpenclawScreen`), `:151-182` (`readOpenclawScreen`)
- Modify: `cli/src/engines/openclaw/runtimeProfile.ts:48-54` (`inspectOpenclawPane` reads the box through `screen.box`)
- Create: `cli/src/engines/openclaw/__fixtures__/screen-banner.txt`, `screen-connecting.txt`, `screen-starting-up.txt`, `screen-sending.txt`, `screen-waiting.txt`, `screen-running-quiet.txt` (`⠦ running • 45s | connected`), `screen-history-failed.txt`, `screen-history-refused.txt` (two not-ready lines, `connected | idle`, the task in the box), `screen-disconnected.txt`, `screen-startup-failed.txt`, `screen-answer-history-words.txt` (a model line `history failed: …` at column 0 over `connected | idle`) — each built from `screen-plain-start.txt`'s title, footer and rules (session `plain`) with the status and chat strings this plan's Base quotes; `MISSING.md` says they are composed from the reproduction's recorded strings
- Modify: `cli/src/engines/__fixtures__/other-screens.golden.json` (re-recorded)
- Test: `cli/src/engines/openclaw/contract.spec.ts`, `runtimeProfile.spec.ts`

**Interfaces (produced):**
- `export type OpenclawPaneState = 'ready' | 'busy' | 'starting' | 'no-history' | 'no-gateway' | 'no-token' | 'remote' | 'local-stopped'`
- `OpenclawScreen` gains `status: string | null` (the status line as drawn, trimmed; null with no live footer) and `box: string | null` (the lines between the last two rules, each trimmed, blank ones dropped, joined with one space; `''` when empty; null with no live footer).
- States: `starting` for `connecting | idle`, `<spinner> starting up • … | …`, `<spinner> connecting…` and `starting local runtime` (out of `busy`); `busy` for any other `<spinner> <words> • <N>s|<N>m <N>s | <connection>`; `no-history` for a `STATUS.ready` line when a line above it in the chat is exactly ` history failed: …` or ` session history not ready — wait or retry /session` (one leading space). `running` is unchanged (`running`, `streaming`); `gatewayLost` unchanged.
- `export function openclawBoxHolds(box: string | null, message: string): boolean` — the box, whitespace runs collapsed, starts with the message's first 32 characters whitespace-collapsed (the whole message when shorter).
- `export const OPENCLAW_FIRST_TASK = { error: 'FIRST_TASK_NOT_TAKEN', detail: 'OpenClaw did not take the first task. Close it and start it again.' } as const`

- [ ] **Step 1: Write the failing tests** in `contract.spec.ts`: `it.each` over the new fixtures → `{ state, status, box, running }` (`banner` → state null, key null; `connecting`, `starting-up` → `starting`; `sending`, `waiting`, `running-quiet` → `busy`, `running` true only for `running-quiet`; `history-failed`, `history-refused` → `no-history`, box `''` and the task; `disconnected`, `startup-failed` → state null, `gatewayLost` true for `disconnected` only; `answer-history-words` → `ready`). The existing `starting local runtime` expectation moves from `busy` to `starting`. `openclawBoxHolds`: a wrapped box holds its message; another text does not; empty does not. `runtimeProfile.spec.ts`: `inspectOpenclawPane` on `history-refused` → `{ idle: false, draft: true }`; on `history-failed` → `{ idle: false, draft: false }`.
- [ ] **Step 2:** `npx vitest run src/engines/openclaw/contract.spec.ts src/engines/openclaw/runtimeProfile.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement** as in Interfaces; comments name the TUI lines this plan's Base quotes. Re-record the golden: `RECORD_OTHER_ENGINES_GOLDEN=1 npx vitest run src/engines/otherScreens.golden.spec.ts`, then check its diff changes no existing entry of another engine.
- [ ] **Step 4:** the two specs, `src/engines/otherScreens.golden.spec.ts`, `src/engines/openclaw/` and `npx vitest run src/core/agents/bind.spec.ts src/engines/openclaw/live.spec.ts` pass; `npm run typecheck`.
- [ ] **Step 5: Commit** `OpenClaw's screen reads starting, a run, and a history that did not load`.

### Task 4: The verbs read starting, failed and held from one function

**Files:**
- Modify: `cli/src/agentClient/model.ts:14-48` (`Frame.starting?: boolean`), `:209-242` (`rowsOf`)
- Modify: `cli/src/agentClient/commands.ts:968-1049` (show), `:1460-1683` (wait), `:1714-1790` (watch)
- Test: `cli/src/agentClient/model.spec.ts`, `commands.spec.ts`

**Interfaces (produced):** `export function listedStateOf(frame: Frame): State` — `stateOf(frame)` when it is `stopped` or the harness is in the cloud; else `failed` when `failureOf(frame)`; else `held` when `namedStateOf(frame)?.held`; else `starting` when `frame.starting === true`; else `stateOf(frame)`. `stateOf` is unchanged, so `reply`, `route`, `tell` and `close` behave as today.

- [ ] **Step 1: Write the failing tests.**
  - `model.spec.ts`: `listedStateOf` for each branch, in that order (a failed offline frame → `failed`; failed and held → `failed`; held and starting → `held`; stopped and failed → `stopped`; cloud → its state).
  - `commands.spec.ts`:
    - show of a `starting` frame: line 1 `… starting · OpenClaw · …`, JSON `state: 'starting'`, a `wait` next step, and no `agent_close` request (no inspect); of a frame with launch `OPENCLAW_FIRST_TASK`: `state: 'failed'`, `failure`, the `failed:` line, no inspect.
    - ps: `starting` and `failed` rows.
    - wait: keeps waiting on a `starting` frame (timeout 124); ends on a failed launch here with exit 1, text `x: failed · <detail>`, JSON with `failure` (both `OPENCLAW_FIRST_TASK` and another launch error, e.g. `OPENCLAW_FOLDER_IN_USE`); a failed launch beside a stopped harness (`--any` off) exits 1 (1 before 4), beside a held one exits 3.
    - watch: prints `started` for a `starting` frame, `failed` for a failed one.
    - wait and watch: a first history page of heartbeat-only events (no `user_message`) and the turn on the second → wait idle with that turn's answer, watch `done` with it.
    - The existing never-started and cloud-failed waits (`commands.spec.ts:1577`, `:2118`) still expect `EXIT.stopped`, unchanged (decision 11: existing clients rely on 4).
- [ ] **Step 2:** `npx vitest run src/agentClient/model.spec.ts src/agentClient/commands.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.** `rowsOf`, show, wait's and watch's looks use `listedStateOf`; show skips `inspect` for `starting` and `failed` as for `held`; wait's look returns `'failed'` for `failed` and `null` (idle looks dropped) for `starting`; watch returns `failed` / `started`; the wait line for a failed harness here is `<n>: failed · <detail>` (the cloud line stays for a cloud harness); `EXIT.failed` only for a frame that is not a cloud harness with `launch.state === 'failed'`, a never-started or cloud failure keeps `EXIT.stopped`; exit precedence 124, 3, 1, 4, 0; `readLastTurn(t)` with its default pages in wait's look and watch's `turnNow`.
- [ ] **Step 4:** the same run and `npx vitest run src/agentClient` pass; `npm run typecheck`.
- [ ] **Step 5: Commit** `Agent verbs say starting until a harness takes its task, and failed with why; wait exits 1 on a failed launch`.

### Task 5: An OpenClaw run reads as work on its screen

**Files:**
- Modify: `cli/src/engines/openclaw/runtimeProfile.ts` (new export), `cli/src/lib/legacyScreen.ts:9-12`
- Modify: `cli/src/engines/__fixtures__/other-screens.golden.json` (re-recorded)
- Test: `cli/src/engines/openclaw/runtimeProfile.spec.ts`

**Interfaces:** Consumes `readOpenclawScreen` (`state`, `status`) from Task 3. Produces `export function openclawActivity(capture: string): { label: string; indicator: string } | null` — for a `busy` pane `{ label: <the status word, e.g. 'running'>, indicator: screen.status }`, else null; `legacyScreen('openclaw', capture)` passes it as `assembleScreen`'s `activity`, so `busy` is true and `inspectCloseActivity` answers `working`. Every other engine passes null, as today.

- [ ] **Step 1: Write the failing tests** in `runtimeProfile.spec.ts`: `openclawActivity` on `screen-sending.txt`, `screen-waiting.txt`, `screen-running-quiet.txt` → indicator the status line; on `screen-starting-up.txt`, `screen-connecting.txt`, `screen-plain.txt` → null; `legacyScreen('openclaw', <running-quiet>).busy` true and `inspectCloseActivity(<openclaw row, turnOpen false>, that reading, false, false)` → `'working'`.
- [ ] **Step 2:** `npx vitest run src/engines/openclaw/runtimeProfile.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement**; re-record the golden as in Task 3 and check only OpenClaw's busy entries changed.
- [ ] **Step 4:** the spec, `src/engines/otherScreens.golden.spec.ts` and `src/lib/closeAgentService.spec.ts` pass; `npm run typecheck`.
- [ ] **Step 5: Commit** `An OpenClaw run on screen reads as working`.

### Task 6: The run timer reaches the frame's activity

**Files:**
- Modify: `cli/src/lib/runtimeActivity.ts:20-36`, `cli/src/lib/turnActivity.ts:91-104` (`check`), `cli/src/core/turns/activity.ts:30-57`, `cli/src/core/main.ts:2047-2053` (`openclawPaneRead`)
- Test: `cli/src/lib/runtimeActivity.spec.ts`, `cli/src/lib/turnActivity.spec.ts`, `cli/src/core/turns/activity.spec.ts`

**Interfaces:**
- Consumes `ScreenReading.activity` for OpenClaw (Task 5).
- `RuntimeActivityReader.observe(session: RegisteredSession, capture: string | null): Promise<ActivityState>` — the comparison `read` does today (same runtime key, a changed indicator → `working`, a stopped goal twice → `idle`, else `unknown`); `read(session)` captures and calls it, for `claude`, `codex` and `openclaw` (every other engine stays `unknown`).
- `TurnActivity.check(sessionId: string, probe?: () => Promise<ActivityState>): Promise<void>` — `probe` replaces `deps.probe` for this check; the drain, the revision fence and the pending check are as today.
- `createTurnActivity(...)` also returns `paneRead(session: RegisteredSession, capture: string): Promise<void>` = `turnActivity.check(session.sessionId, () => runtimeActivity.observe(session, capture))`, and `withheld` still answers `unknown`.
- `main.ts`: `openclawPaneRead` adds one line, `if (session) void activity.paneRead(session, capture).catch(() => undefined)`.

- [ ] **Step 1: Write the failing tests.**
  - `runtimeActivity.spec.ts`: an OpenClaw session whose two captures draw `⠦ running • 41s` then `• 46s` → `working`; the same timer twice → `unknown`; a ready pane → `unknown`; the existing claude/codex cases unchanged, and `hermes` stays `unknown`.
  - `turnActivity.spec.ts`: `check(id, probe)` uses the given probe; a `turn_ended` observed while it runs wins over its `working`.
  - `activity.spec.ts`: `paneRead` of two busy OpenClaw captures sets the snapshot `working` with no turn open; of a ready capture leaves it as it was.
- [ ] **Step 2:** `npx vitest run src/lib/runtimeActivity.spec.ts src/lib/turnActivity.spec.ts src/core/turns/activity.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement**; a comment in `activity.ts` says why the binding pass's capture is used (no turn is open, so nothing probes; the pass already captured it).
- [ ] **Step 4:** the run passes; `npm run test:core` (`core/turns/activity.ts` at 100%); `npm run typecheck`.
- [ ] **Step 5: Commit** `An OpenClaw run's changing timer keeps it working, in ps too, through a quiet step and before its first row`.

### Task 7: The Gateway hold waits 10 s and holds through the outage

**Files:**
- Modify: `cli/src/core/agents/bind.ts:41-56` (`openclawScreenHold`), `:462-484` (set and clear)
- Test: `cli/src/core/agents/bind.spec.ts`

**Interfaces:** `GATEWAY_HOLD_MS = 10_000` in `bind.ts`. Per agent, in memory: when the pass first read `no-gateway` since the last pass whose status line matched `STATUS.ready` (pane state `ready` or `no-history`). The noGateway hold is set on a pass reading `no-gateway` at least 10 s after that time; it is cleared only by a pass whose state is `ready` or `no-history`, which also forgets the time. A pass reading state null (`disconnected | idle`, `startup failed | idle`), `starting` or `busy` neither sets, clears nor resets it. The remote, no-token and local-stop holds keep today's set and clear rules. The map is cleared at 256 entries.

- [ ] **Step 1: Write the failing tests** in `bind.spec.ts`, with a fake clock (`vi.useFakeTimers`, `Date.now`): `gateway disconnected` at 0 s and 5 s → no hold; at 10 s → held, logged once; `disconnected | idle` between keeps it held (no "working again"); `startup failed | idle` too; a ready line clears it and a `gateway disconnected` 2 s later does not hold again before 12 s; a drop of 4 s followed by `gateway reconnected | idle` never holds; a remote TUI is held at its first read as today; a local stop as today.
- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts` — FAIL; existing cases that expect an immediate noGateway hold are updated and listed in the report. Commit red.
- [ ] **Step 3: Implement**; the comment names the reproduction (`gateway disconnected` redrawn at each reconnect try and bare `disconnected | idle` between, which cleared and set the hold every few seconds).
- [ ] **Step 4:** `npx vitest run src/core/agents/bind.spec.ts` passes; `npm run test:core` with `bind.ts` at 100%.
- [ ] **Step 5: Commit** `The OpenClaw Gateway hold waits 10 s, holds through the outage, and clears only on a connected line`.

### Task 8: An OpenClaw message waits for a ready pane; the first task is tracked

**Files:**
- Modify: `cli/src/lib/sessionInput.ts:60-65` (constant), `:129-158` (`InputState.firstTask`), `:390` (`submit`), `:1022-1150` (`retrySubmit`'s OpenClaw branch), new methods
- Modify: `cli/src/core/input.ts:273-291` (`submitFirstTask`)
- Test: `cli/src/lib/sessionInput.spec.ts`, `cli/src/core/input.spec.ts`

**Interfaces:**
- Consumes `readOpenclawScreen` (`state`, `box`) and `openclawBoxHolds` (Task 3).
- `submit(sessionId, content, deliveryId?, receipt?, options?: { firstTask?: boolean })`; the paste marks `state.firstTask` and calls `onWaitChanged`, and so do its confirmation, `forget` and any settle.
- `firstTaskWaiting(id: string): boolean` — a first task is typed and its user row has not confirmed it.
- `typeCommand(id: string, line: string): Promise<boolean>` — types `line` and Enter through `inject` under the pane's write lock only while nothing is pending for the pane (no message awaiting confirmation or being written, no queue, no caller holding control, no open turn); false otherwise or when the write failed.
- `OPENCLAW_NOT_READY_MAX_MS = 180_000`. OpenClaw's branch of `retrySubmit`, after each 10 s window: capture; a pane whose state is not `ready` → re-arm without counting, until 3 minutes from the paste (then, for a message that is not a first task, today's give-up and "did not accept"); `ready` and `openclawBoxHolds(box, message)` → Enter (a retry); `ready` and an empty box → no Enter (the TUI took it), the window counts; `ready` with other text in the box → no Enter, the window counts; no capture → today's behaviour. After `SUBMIT_MAX_RETRIES` windows a non-first message is given up as today; a first task never is: it keeps observing until confirmed or forgotten (the binding pass's bound, Task 9).
- `core/input.ts`: `submitFirstTask(agentId: string, task: string): void` — `submitAgent`'s path with `{ firstTask: true }`; returned beside `submitAgent`.

- [ ] **Step 1: Write the failing tests** in `sessionInput.spec.ts` `describe('OpenClaw confirmation window')`, captures from Task 3's fixtures:
  - refused into the box while `starting up` for 25 s, then ready with the text in the box → one Enter at the first ready read, `inject` once, no error;
  - other text in the box on a ready pane → no Enter;
  - an empty box on a ready pane → no Enter;
  - a first task: no error after 5 minutes, `firstTaskWaiting` true, false after `onTurnStarted`, and `onWaitChanged` at both ends;
  - a message not ready for 3 minutes → "did not accept";
  - `typeCommand` refused while a message awaits confirmation, typed once when nothing is pending;
  - the two existing OpenClaw cases still pass.
  - `input.spec.ts`: `submitFirstTask` submits with `{ firstTask: true }`.
- [ ] **Step 2:** `npx vitest run src/lib/sessionInput.spec.ts src/core/input.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement**; the comment names the reproduction (the task pasted once, two Enters on a pane that could not send, then given up with a log line only).
- [ ] **Step 4:** the run passes; `npm run test:core` (`core/input.ts` at 100%); `npm run typecheck`.
- [ ] **Step 5: Commit** `An OpenClaw message is sent with Enter once its pane can send it, and a first task is never given up early`.

### Task 9: The binding pass: `/session`, one pass, the 3-minute bound

**Files:**
- Modify: `cli/src/core/agents/bind.ts:78-110` (`BindDeps`), `:326-341` (`handOverFirstTask`), `:439-529` (the OpenClaw pass)
- Modify: `cli/src/core/main.ts:2041` (`submitFirstTask: inputs.submitFirstTask`)
- Test: `cli/src/core/agents/bind.spec.ts`

**Interfaces:**
- Consumes: Task 3's states and `box`, `OPENCLAW_FIRST_TASK`; Task 7's clear rule; Task 8's `submitFirstTask`, `firstTaskWaiting`, `typeCommand`.
- `BindDeps.submitAgent` becomes `submitFirstTask: (agentId: string, task: string) => void`; `input: Pick<SessionInputController, 'forget' | 'awaitingConfirmation' | 'firstTaskWaiting' | 'typeCommand'>`; `registry` adds `'setLaunch'`.
- Constants: `SESSION_RETRY_MS = 20_000`, `SESSION_TRIES = 5`, `FIRST_TASK_BOUND_MS = 180_000`.
- **`/session`:** a pass reading `no-history` with `box === ''` and a key (the row's session, else the footer's) types `/session <key>` through `typeCommand` when the last try was 20 s ago or more and fewer than 5 were made; logs `[discovery] <sid> openclaw · history not loaded · /session <n>/5` (no key). A pass reading any other state starts the count again. No task is handed over on `no-history`.
- **One pass:** where a pass binds the session (`followRegistered`) or clears a hold and attaches, the attach's completion (not awaited by the pass) captures the pane once more and hands the task over when that reading is `ready` on the row's key and `openclawPaneRead` says a stream took it. `handOverFirstTask` stays the one path, at most once (`takeFirstTask`).
- **The bound's clock:** in memory, per agent, `firstTaskClock: Map<string, { seenAt: number; heldMs: number; heldSince?: number }>`, bounded at 256 entries (cleared at 256, as `openclawFolderReads`), the entry dropped once the row holds no task and `firstTaskWaiting` is false. Every pass over an OpenClaw row that holds its task or `firstTaskWaiting`, before any return (a held row's too): creates the entry with `seenAt = now`; a row carrying `identityHold` sets `heldSince ??= now`; one carrying none adds `now - heldSince` to `heldMs` and drops `heldSince`. Unheld time = `now - max(registeredAt, Date.parse(startMarker) when it parses, seenAt) - heldMs - (heldSince ? now - heldSince : 0)`.
- **The bound:** before the pass's early return for a quiet pane, when the row holds its task or `firstTaskWaiting`, carries no `identityHold`, and its unheld time is 3 minutes or more: take the task off the row when it is still there, `input.forget(agentId)`, `registry.setLaunch(agentId, { state: 'failed', ...OPENCLAW_FIRST_TASK })`, announce, log `[agent] <sid> first task not taken · FIRST_TASK_NOT_TAKEN`; nothing is typed after it.

- [ ] **Step 1: Write the failing tests** in `bind.spec.ts`:
  - a `history-failed` pane → no task typed, `/session agent:main:plain` typed once, again only 20 s later, 5 times at most, the count back to 0 after a `ready` pass;
  - `history-refused` (text in the box) → no `/session`;
  - the pass that binds a session on a ready pane types the task once the attach resolves, with no second pass;
  - the pass that clears a Gateway hold does the same;
  - a task on the row 3 minutes after the TUI's start → launch `FIRST_TASK_NOT_TAKEN`, task off the row, nothing typed;
  - a typed, unconfirmed task at the bound → `input.forget` and the same failure;
  - a resumed row (old `registeredAt`, new `startMarker`) is not failed at its first pass;
  - a row whose task was confirmed is never failed;
  - held through 5 minutes (noGateway set 10 s after the launch, the Gateway back at 5 min 10 s): never failed, and the task is typed in the pass that clears the hold;
  - held 2 minutes in the middle: not failed at 4 min 59 s of wall time (2 min 59 s unheld), failed at 5 min 1 s;
  - a new binding instance (a daemon restart) over a row whose TUI started 10 minutes ago with its task on the row: not failed at its first pass, failed 3 minutes after it;
  - a held row is never failed, even long past 3 minutes of wall time.
- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement**; comments name the reproduction (history timed out on a loaded Gateway; three passes before the task was typed).
- [ ] **Step 4:** `npx vitest run src/core/agents/bind.spec.ts` passes; `npm run test:core` with `bind.ts` at 100%; `npm run typecheck`; `git diff --exit-code 60aa30b528 -- cli/src/architecture.coreFiles.txt`.
- [ ] **Step 5: Commit** `OpenClaw's first task: history reloaded with /session, typed in the pass that can, and failed visibly after 3 minutes not held`.

### Task 10: A failed OpenClaw launch is kept and shown

**Files:**
- Modify: `cli/src/core/agents/newPane.ts:177-184` (the exit branch), `:236-238` (the watch's catch)
- Modify: `cli/src/core/agents/discovery.ts:188-240` (`onObserved`), `:324-340` (`onDormant`), its deps (`capturePane`)
- Modify: `cli/src/core/main.ts` (discovery's `capturePane: (agentId) => captureTerminal(agentId, 40)`)
- Test: `cli/src/core/agents/newPane.spec.ts`, `cli/src/core/agents/discovery.spec.ts`

**Interfaces:** Consumes `readOpenclawScreen(capture).state === 'no-token'` and `OPENCLAW_FIRST_TASK` (Task 3). Discovery deps add `capturePane: (agentId: string) => Promise<string | null>`.

- [ ] **Step 1: Write the failing tests.**
  - `newPane.spec.ts`: an OpenClaw (not local) whose engine exited before it was seen, with `screen-no-token.txt` on its pane → launch `{ state: 'failed', error: 'OPENCLAW_NO_TOKEN', detail: OPENCLAW_STATES.noToken }`, announced, not made a terminal (`confirmEngineExit` not called); the local folder-in-use case unchanged; a watch whose capture throws `new Error('boom')` logs `[agent] create watch failed · openclaw · readiness publication unavailable · Error: boom`.
  - `discovery.spec.ts`: an OpenClaw row with no session, seen running and then dormant, whose pane reads `no-token` → the same failed launch, not retained; a row whose launch failed `FIRST_TASK_NOT_TAKEN` observed again on the same process → `confirmLaunch` not called, row unchanged; on a new process → confirmed as today.
- [ ] **Step 2:** `npx vitest run src/core/agents/newPane.spec.ts src/core/agents/discovery.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement** (discovery's rule as "Decided here" states it); the catch's line adds `· <name>: <message>` with control characters removed, 200 characters at most.
- [ ] **Step 4:** the run passes; `npm run test:core` (both files at 100%); `npm run typecheck`.
- [ ] **Step 5: Commit** `A missing Gateway token fails the OpenClaw launch where show finds it, and a first task not taken stays failed`.

### Task 11: The frame says starting

**Files:**
- Modify: `cli/src/lib/agentFrame.ts:54-161` (`starting: boolean`), `:185-202` (`AgentFrameContext.starting?: () => boolean`), new `agentStarting`
- Modify: `cli/src/lib/cloudAgents.ts:244` (`starting: false`)
- Modify: `cli/src/core/main.ts:440-462` (`startingRef` set once the input exists, as `waitingForRef`)
- Test: `cli/src/lib/agentFrame.spec.ts`

**Interfaces:** `export const OPENCLAW_STARTING_MS = 60_000`; `export function agentStarting(s: RegisteredSession, firstTaskTyped: boolean, now: number): boolean` — `!!s.firstTask || firstTaskTyped || (s.engine === 'openclaw' && !s.sessionId && now - <the later of registeredAt and startMarker> < 60 s)`. `main.ts`: `starting: () => startingRef?.(s) ?? false` with `startingRef = (s) => agentStarting(s, input.firstTaskWaiting(s.agentId), Date.now())`. Consumes `firstTaskWaiting` (Task 8).

- [ ] **Step 1: Write the failing tests** in `agentFrame.spec.ts`: `agentStarting` true with a task on the row, true for a typed first task, true for an unbound OpenClaw 59 s after launch, false at 61 s, false for an unbound Codex, false for a bound OpenClaw with no task; the frame carries `starting` from its context and `false` without one; the task text is still never on the frame.
- [ ] **Step 2:** `npx vitest run src/lib/agentFrame.spec.ts` — FAIL. Commit red.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npx vitest run src/lib/agentFrame.spec.ts src/lib/agentFrame.parts.spec.ts src/lib/cloudAgents.spec.ts` pass; `npm run typecheck`.
- [ ] **Step 5: Commit** `An agent's frame says starting until it has taken its first task`.

### Task 12: No question parse on OpenClaw's chat (conditional)

**Runs only when Task 1's base run showed row 14 or 14b as `needs the person`.** Otherwise the implementer reports "not needed" and commits nothing.

**Files:** Modify `cli/src/lib/questionPane.ts:40` (`parseEngineQuestionPane`: `openclaw` → null, with a comment: its TUI draws no question or approval, `__fixtures__/MISSING.md`); create `cli/src/engines/openclaw/__fixtures__/screen-numbered-list.txt` (the screen Task 1's fake drew for row 14b); modify the golden; Test: create `cli/src/lib/questionPane.spec.ts` (no spec covers this file today).

- [ ] **Step 1:** the failing case: the screen Task 1 recorded for row 14b (as a fixture `screen-numbered-list.txt`) → `parseEngineQuestionPane('openclaw', …)` is null. Run — FAIL. Commit red.
- [ ] **Step 2:** implement; re-record the golden (only OpenClaw's question entries change); the case and `src/engines/otherScreens.golden.spec.ts` pass.
- [ ] **Step 3: Commit** `OpenClaw's chat is never read as a question`.

### Task 13: Copy: `failed` and exit 1

One commit, no red test. Exit 1 is for a launch that failed on its machine only; a harness that never started keeps 4 (decision 11), so the 4 lines name it. Copy, byte for byte:
- `WAIT_USAGE` (`commands.ts:116`): `Exit status: 0 idle or closed by you, 1 one's launch failed (harness show says why), 3 one needs the person (a question, a permission, or a problem only they can fix), 4 one stopped, never started or is gone,` (next line unchanged: `124 timed out.`).
- `SKILL.md:89-90`: `` - `wait` exits 0 when it is idle (or you closed it), 1 when its launch failed (`show` says why), 3 when it needs the person (…unchanged…), 4 when it stopped, never started or is gone, 124 on ``, the rest unchanged.
- `docs/cli.md`, after the `held` sentence (line 395): ``A harness is `starting` until it has taken its first task. One whose launch failed is `failed`, with why (`failure`): `wait` ends on it with exit 1; one that never started ends it with exit 4.``
- `website/public/agents/index.html:209`: `<tr><td><code>1</code></td><td>Failed. For <code>wait</code>: a harness's launch failed; <code>harness show</code> says why. Otherwise the message says what to run next.</td></tr>`; `:213`: `<tr><td><code>4</code></td><td><code>wait</code>: a harness stopped, never started or is gone.</td></tr>`; `:221`: `<p>When several apply, <code>wait</code> exits with the first of 124, 3, 1 and 4.</p>`
- `website/public/llms.txt:31`: `# exits 0 idle, 1 launch failed, 3 needs the person (a question, a permission, or a problem only they can fix), 4 stopped, never started or gone, 124 timed out`
- `harness help agents` already lists `starting` and `failed` and its generic exit codes (`1 failed`): unchanged.

- [ ] **Step 1:** edit; `npx vitest run src/agentClient/help.spec.ts src/agentClient/commands.spec.ts` pass.
- [ ] **Step 2: Commit** `Agents read that wait exits 1 on a failed launch and 4 on one that never started`. (Deploying the website is a separate step, not this PR's.)

## Verification

**Unit tests, per layer (each task's Step 4; on this Mac, nothing outside the worktree):** `npx vitest run src/engines/openclaw src/engines/otherScreens.golden.spec.ts src/lib/sessionInput.spec.ts src/lib/runtimeActivity.spec.ts src/lib/turnActivity.spec.ts src/lib/agentFrame.spec.ts src/agentClient src/core/agents src/core/turns/activity.spec.ts src/core/input.spec.ts`; `npm run typecheck`.

**Local gates PR CI does not run (receipts in the PR body):** `npm run test:core` at 100% per file (`bind.ts`, `newPane.ts`, `discovery.ts`, `input.ts`, `turns/activity.ts` change): `python3 scripts/local-checks.py --run` from a clean tree at the final head, which plans `cli-core` and prints the receipt. Also `git diff --exit-code 60aa30b528 -- cli/src/architecture.coreFiles.txt` and `npx vitest run src/architecture.spec.ts`.

**The goal test.**
- *Red on the base:* in a throwaway worktree at `60aa30b528` (`git worktree add <scratchpad>/base 60aa30b528`, Task 1's two files copied in, `npm ci`), `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/openclawShow.e2e.ts`; the PR lists the rows that failed. Remove only that worktree afterwards.
- *Green on this Mac:* the same command on the branch head, then again with `E2E_BUNDLE=1`.
- *Green on Linux:* the temporary workflow (Task 2) runs on the push of the branch; report its run link. It also runs `agentClient`, `identityHoldVisible` (skipped on Linux), `hermesAdmission`, `hermesTerminalRecord` and `otherEngines`: the other engines read as before.
- Isolation is `IsolatedDaemon`'s own: a private root, home, data and runtime folders, its own port and tmux server, signed out with the backend at `ws://127.0.0.1:9`; the fake OpenClaw at `OPENCLAW_PATH` with its state folder under the daemon's root. The computer's own OpenClaw, Gateway, daemon and tmux are never touched; no account.

**Other engines on this Mac:** `npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts e2e/identityHoldVisible.e2e.ts` passes.

**The real OpenClaw, isolated (tester, this Mac, not in CI):** the scratch rig in `…/scratchpad/repro/` (`gw.sh`, `wsProxy.mjs`, `stubModel.mjs`, `openclawRepro.e2e.ts`): an isolated HOME and state folder, a Gateway on port 28911 behind the proxy that drops one `chat.history`, the stub model, `IsolatedDaemon`. Copy `openclawRepro.e2e.ts` into the worktree's `cli/e2e/` for the run only (never committed; delete it after). Run `OC_SCENARIO=proxy-histdrop`, then `down` and `cold`, on the branch head. Expected: the history-drop run types `/session`, delivers the task (the stub logs its tag), and `show` goes `starting` → `working` → `idle` with the ask; `down` is held only after 10 s and types the task in the pass that clears the hold; no `create watch failed` line (if one appears, report the cause it now names). A TUI started on a state folder with no Gateway token: `show` says `failed` with `OpenClaw has no Gateway token. Run openclaw onboard.`. Stop the rig's Gateway, proxy and stub afterwards (only the pids its own files recorded).

**The slow-device box (tester, this Mac, Podman):** follow `…/scratchpad/lamp-rig/README.md` (it may still be being written; use its "Rerun against another SHA"): `./box.sh machine-up`, `./box.sh up 60aa30b528`, `./box.sh run 10 main-cpu0.6` (the README's `results/main-cpu0.6` may already hold this), then `./box.sh up <branch head>` and `./box.sh run 10 fix-<head>-cpu0.6`; optionally `CPU_QUOTA_US=3000` for both. The PR gets, from each `summary.md`: how often the first task was late (taken after 45 s) or lost, the time to `working`, and `show`'s states over time, main against the branch. Stub model by default; a real-model run only with a key file piped into the box (`or-key-in`), removed with `or-key-out` and checked gone. `./box.sh down; ./box.sh machine-down` afterwards. Only the `devcrew-lamp` Podman machine is used.

**Nothing against production, no real account:** every check above is local or a GitHub run of this branch.
