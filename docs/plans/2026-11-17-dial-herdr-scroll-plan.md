# A stroke on the dial scrolls Herdr's view of the shown agent's terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(devices): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** While Herdr is in front, the dial shows an agent whose terminal is in Herdr's window, and `herdr-app status` names that terminal as the one on screen, a stroke on the dial scrolls Herdr's view of it line by line and Harness's windows hear none of that stroke; in every other case the stroke goes to Harness's windows as `dial_scroll`, as today.

**Architecture:**
- **Shared with the VS Code branch, copied byte for byte:** the shown agent's id (`CableHost.dialShows?(dial, agent, agentId)`, `CableSession.reportShown`'s `shownId`, `DaemonCableHost.shownAgentId()`) and `cable/hosts/scrollLines.ts` (`SCROLL_SCALE`, `SCROLL_LINE_PX`, `createScrollLines`).
- **`HostAdapter` gains three optional members** (`canScroll`, `onScreen`, `scroll`), and the routing in `services/devices.ts` (`scrollTarget`, `stroke`, `routeScroll`) names no app: the first adapter that can scroll the shown agent's pane takes the stroke.
- **The Herdr adapter** (`cable/hosts/herdrApp.ts`) implements them through the `herdr-app` CLI it already runs: `status` once a stroke, `do terminal.scroll --terminal <address> --lines <n>` one run at a time per terminal. **The hc source** tells a listed agent's terminal (`HcSource.paneOf`).
- Everything is in the devices process. Nothing under `cli/src/core/` changes, and nothing is stored.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`). Herdr Core 0.1.21 (`~/.local/bin/herdr-core`) is used only as the e2e's private core; `herdr-app` is always a fake in tests.

**Spec:** `docs/plans/2026-11-17-dial-herdr-scroll-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, and the Herdr adapter's own design (`docs/plans/2026-11-16-herdr-app-design.md`).

**Open questions:** none left; the PM's answers (2026-11-17) are under "Open questions" below.

## Base

- `feat/dial-herdr-scroll` at `6e31e00202` (`main` after #4413; `origin/main` has since moved). The spec and this plan are untracked. The main session commits them; no task does.
- `cli/node_modules` is absent in this worktree: the orchestrator runs `cd cli && npm ci` once before the first task.
- **The VS Code worktree** is `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-vscode-ext` (`feat/dial-vscode-extension`, head `9c93b8951e` when this was written). It is only read, with `git -C <it> diff origin/main...HEAD -- <file>`. Its six shared diffs were checked against this base with `git apply --check` on 2026-11-17: all apply.
- The tasks name functions, never lines:
  - `cable/cableSession.ts`: `CableHost.dialShows`, `CableSession.reportShown`. `cable/cableHost.ts`: `DaemonCableHost.dialShows`, `latestFront`, `scrolled`.
  - `cable/hosts/adapter.ts`: `HostAdapter`, `Pane`. `herdrApp.ts`: `createHerdrAppAdapter`, `HerdrAppAdapter`, `binary`, `running`, `once`, `switchTo`. `hcClient.ts`: `HC_TERMINAL`. `hcSource.ts`: `HcSource.find`, `listed`, `shows`. `observed.ts`: `ObservedSource.paneOf(agentId, adapter)` (unchanged).
  - `herdrApp.spec.ts`: `recorder`, `holding`, `turn`, `pane`, `FORGED`, `FAKE_PATH_HERDR_APP`, `openCall`. `hcSource.spec.ts`: `setup`, `live`, `row`, `agent`, `server`.
  - `services/devices.ts`: `adapters`, `noting`, `herdrApp`, `herdrAppNoted`, `hcPane`, `hcSource`, `observed`, `outsideLine`, `cableHost`, `part.call`, the wiring's `scrolled`, the port's `scroll` and `stop`.
  - `devices.spec.ts`: `start`, `orca`, `orcaRuns`, `logs`, `harnessAgent`, and the describe `Herdr's agents, through Herdr Core`'s `withHc`, `terminal`, `hook`, `onMac`, `ID`, `host`, `said`, `listed`.
  - `cli/e2e/deviceHerdrApp.e2e.ts`: `fresh`, `coreFor`, `rowOf`, `said`, `herdrApps`, `FILTER`, `ORCA`, `HERDR`, `CLI_ENTRY`. `e2e/harness/client.ts`: `LocalClient`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- **Rebased (2026-11-18)** onto `origin/main` `86558dafad`, where the VS Code branch merged first (#4427). The shared
  parts are `main`'s from then on, and VS Code's terminal is on this branch's route (the spec's merge-order section).

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 A stroke's travel as whole lines | `cli/src/cable/hosts/scrollLines.ts` (new), `scrollLines.spec.ts` (new) | none | medium | `scrollLines.spec.ts` |
| 2 The host knows the shown agent's id | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts`, `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | none | medium | `cableSession.spec.ts`, `cableHost.spec.ts` |
| 3 `HostAdapter`'s scroll members, and the Herdr adapter's `canScroll` and `scroll` | `cli/src/cable/hosts/adapter.ts`, `herdrApp.ts`, `herdrApp.spec.ts` | none | xhigh | `herdrApp.spec.ts` |
| 4 The Herdr adapter's `onScreen` | `cli/src/cable/hosts/herdrApp.ts`, `herdrApp.spec.ts`, `cli/src/testing/herdrAppStatus.ts` (new) | 3 | high | `herdrApp.spec.ts` |
| 5 The hc source tells a listed agent's terminal | `cli/src/cable/hosts/hcSource.ts`, `hcSource.spec.ts` | none | medium | `hcSource.spec.ts` |
| 6 The devices route a stroke | `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 2, 4, 5 | xhigh | `devices.spec.ts` |
| 7 End to end, a private Herdr Core and a fake `herdr-app` | `cli/e2e/deviceHerdrApp.e2e.ts` | 6 | high | none: no behavior (the end-to-end test of Tasks 1 to 6), one commit |
| 8 Say it in the docs | `cli/AGENTS.md` | none | medium | none: docs only, one commit |

Longest chain: 3 → 4 → 6 → 7: four tasks.

- Tasks 1, 2, 3, 5 and 8 share no file and start at once.
- Shared files: `herdrApp.ts` and `herdrApp.spec.ts`, Tasks 3 and 4, ordered by the dependency above. No other file is in two tasks.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/cableSession.ts`, `cableHost.ts`, `cable/hosts/scrollLines.ts`, `adapter.ts`, `herdrApp.ts`, `hcSource.ts` | **Devices service process**, and only there | Their specs (PR CI `cli-tests`, Linux) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `cli/src/testing/herdrAppStatus.ts` | Test fixture | none |
| `cli/e2e/deviceHerdrApp.e2e.ts` | Test: the real daemon, a fake dial, a private hc, a fake `herdr-app` | Verification 1, locally on this Mac |
| `cli/AGENTS.md` | Repo file, no process | Review |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `cli/vitest.setup.ts`, `cable/hosts/observed.ts`, `open.ts`, `registry.ts`, `hcClient.ts`, `herdrClient.ts`, `herdr.ts`, `cli/e2e/harness/`, and the VS Code worktree. `vscode.ts` was in this list until the
rebase, which gave its adapter `canScroll` and `scroll` (with `vscode.spec.ts` and a fake's `scroll` in
`observed.spec.ts`).

## Global Constraints

- **Never the person's Herdr.** No task, spec or check runs a bare `herdr-app`, `hc` or `herdr-core`, reads `~/.config/herdr-app`, or reaches Diego's Herdr.app, its window or his default hc session. Unit tests use fakes; the e2e uses the private hc (`cli/e2e/harness/hcCore.ts`) and the fake `herdr-app` first on the daemon's `PATH`.
- **Nothing in `cli/src/core/`.** No new core file, list or record (cli/AGENTS.md rule 7).
- **The shared parts are copied, not rewritten** (Tasks 1 and 2): the VS Code branch's diff of each file, applied as it is. The VS Code worktree is never edited. No task rebases onto that branch; the rebase onto `main` came after the tasks.
- **The three conditions**, asked at a stroke's `down`: Herdr in front (`cableHost.latestFront() === 'herdr'`); the dial shows an agent with a terminal in Herdr's window (`hcSource.shows(address)`); `herdr-app status`'s `agent` equals that terminal. Else the whole stroke is `dial_scroll`.
- **The route** is chosen at `down` and kept to `up`. A `move` or `up` with no `down` before it chooses then.
- **A run.** No shell, each value one argument, deadline `SCROLL_TIMEOUT_MS = 2_000`:
  - `herdr-app status`;
  - `herdr-app do terminal.scroll --terminal <address> --lines <n>`, `n < 0` toward older lines.
  - The address is held to `HC_TERMINAL` (`/^t[0-9][0-9a-z]{0,15}$/`) again before either runs.
- **The queue.** One `terminal.scroll` run at a time per terminal; lines that come meanwhile are summed in a pending count clamped to ±100, which the next run carries. Its map is its own (`scrolling`), never `running` and `once()`.
- **`status`.** Stdout is one JSON object; only `agent` is read, and nothing else of it is kept or logged. True only for exit 0, an object, and `agent` a string equal to the pane's id.
- **Travel.** `SCROLL_SCALE = 2.5`, `SCROLL_LINE_PX = 16`, whole lines spent, the remainder kept, `down` resets. A fling is not played. `scrollReversed` is not applied.
- **Log lines**, fixed words and counts only, never an address, a name or text:
  - `[herdr-app] scroll · failed`, once until a run succeeds;
  - `[herdr-app] scroll · <lines> lines · <runs> runs · <failed> failed`, when a terminal's queue drains;
  - `[herdr-app] status · failed`, once until a read succeeds;
  - `[device] scroll · herdr-app · not on screen`, once per stroke that went to the windows for that reason;
  - `cable: scroll ↓` and `cable: scroll ↑ (v=…)` stay as they are.
- **Platforms.** macOS only. On Linux and Windows no Herdr verb runs and every stroke goes to Harness's windows.
- **Out of scope:** herdr 0.8.0, tmux, Orca, Terminal, iTerm2 and Ghostty tabs, a fling, `scrollReversed`, scrolling back to the bottom. Moving VS Code onto `HostAdapter.scroll` was out of the tasks; the rebase did it.
- **Repo rules.** Test first, at the layer where the behavior lives. No fixed sleeps. Every fan-out bounded. Comments say why. No promise of an adapter rejects. `src/services` stays at 100% per file.

## Review Focus

1. **The finger reverses, or stops, while a run is under way** (most strokes wobble). The lines that came meanwhile may sum to 0. A person expects no extra process and no stuck queue. Task 3, `lines that cancel while a run is under way run nothing more, and the queue drains`.
2. **A dial that sends `down` after `down` faster than `status` answers** (a firmware fault or a lossy link; its port allows 2,000 frames a second, `cableSession.ts` `BUDGET`). A person expects one `herdr-app status` process at a time, and nothing sent for the strokes left behind. Task 4, `asks while a read is under way are that one read, each answered for its own pane`; Task 6, `a newer down before the answer drops the stale one`.
3. **The devices stop while a stroke's `status` is under way** (a daemon update, the last device gone). A person expects nothing run or sent after the stop. Task 6, `the devices stopping drops a stroke still being decided`.
4. **A frame whose travel is no sane number** (`dy: 1e308` from a garbled frame makes `createScrollLines` answer `-Infinity`). A person expects that stroke to scroll nothing, never a `--lines -Infinity` argument. Task 3, `lines that are no whole number run nothing`.
5. **`run` rejects inside a verb nobody awaits.** `scroll` is the adapter's first fire-and-forget verb: an unhandled rejection would end the devices process and every dial with it. Task 3, `a run that rejects is a failed run`; Task 4, `a read that rejects is false`; Task 6, `a throw after the answer is the part's`.

## Decided (PM for Diego, 2026-11-17)

1. The shared parts keep the VS Code branch's exact names and signatures, copied from its worktree with their specs. The routing is general through `HostAdapter.canScroll` / `onScreen` / `scroll`. VS Code merges first; this branch rebases later (the spec's merge-order section).
2. herdr 0.8.0 is out of scope.
3. A stroke scrolls Herdr only when `herdr-app status`'s `agent` equals the shown agent's terminal; otherwise the whole stroke goes `dial_scroll`. The `status` fixture is written by hand in the spec's shape, with made-up ids.
4. Nothing in `cli/src/core`. Tests never touch the person's running Herdr or hc.

## Decided here, where the spec was silent

- **The members exist on every platform** and answer false or run nothing off macOS, as `canShow` and `show` do. `scrollTarget` finds the member and `canScroll` says no.
- **`canScroll` asks for the binary last** (macOS, the id's form, in front, shown, then `binary()`), so the `PATH` lookup runs only for a pane that passed the rest.
- **`SCROLL_TIMEOUT_MS` and `SCROLL_PENDING_MAX = 100` are module constants of `herdrApp.ts`, not exported.** The specs write `2_000` and `100` out, as `herdrApp.spec.ts` writes `APP_BINARY` out.
- **Only the pending count is clamped.** A run started with nothing under way carries the lines it was given.
- **`scroll` drops a `lines` that is no whole number** (`Number.isSafeInteger`), beside 0 and a bad id (Review Focus 4).
- **A run that rejects counts as a failed run** (Review Focus 5).
- **The two `failed` lines are the adapter's, not a terminal's:** each is said once until any run, or read, of its kind succeeds.
- **The drain tally lives in the terminal's queue entry** and goes with it **(Q1)**.
- **One `status` read at a time.** An `onScreen` asked while one is under way joins that read and is answered for its own pane (Review Focus 2; root rule 4, every fan-out bounded).
- **An exit 0 whose stdout is no JSON object is a failed read** and says `status · failed` (root rule 6: a Herdr that changes `status` must be seen). An object whose `agent` is missing, null, no string or another address is a mismatch and says nothing.
- **What a held stroke keeps:** `Held = { down: boolean; dy: number; velocity: number; up?: number }`. Every held frame's `dy` joins `dy` (a `down`'s and an `up`'s too, so no travel is lost); `velocity` is the last held `move`'s; `up` is the `up`'s velocity. Replayed to the windows: `down 0 0` when a `down` came, `move <dy> <velocity>` when `dy !== 0`, `up 0 <up>` when it came.
- **A frame after a held `up` begins a new stroke,** as a frame after a decided stroke's `up` does. The older answer is then stale.
- **The answer runs inside the frame's own `part.call('dial', …)`:** `routeScroll` returns the `onScreen` chain, which `devicesGuard.ts` `call` catches when it rejects.
- **The devices' `stop` drops the stroke** (Review Focus 3).
- **`HcSource.paneOf` reads `find()`,** so only a listed row (the first 64) has a pane. One past the 64 is not on the dial.
- **The path "an adapter that scrolls and has no `onScreen`"** had no adapter before the rebase, so Task 6 tested it through a copy of the `herdrApp.js` module. Since the rebase it is VS Code's terminal, which `main`'s VS Code specs in `devices.spec.ts` cover, and that stand-in test and the module copy are gone.
- **The fixture is one file,** `cli/src/testing/herdrAppStatus.ts`, read by `herdrApp.spec.ts`, `devices.spec.ts` and the e2e's fake `herdr-app`.
- **The `scrolled` wiring line is `main`'s, comment and all:** "(a window's stream)" stays, as VS Code's window stream is still the scroll path that throws (Herdr's `scroll` never does). `import { createScrollLines }` sits where `main` put it.
- **The e2e uses a dial that holds one app's ring and two Orca agents,** as the file's swipe test does, so each change of the app in front is seen as a ring. It asserts no time: it prints the stroke's runs and milliseconds.
- **`cli/AGENTS.md`'s devices row gets one clause** (Task 8), as each Herdr, cmux and opencode change gave it one. The VS Code branch edits the same line: the rebase keeps both clauses. `docs/specs/2026-11-15-device-host-adapter.md` is not changed: its interface listing is the 2026-11-15 design's and already lacks `canType`, `paneKey` and `bundle`.

---

### Task 1: A stroke's travel as whole lines

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium` (two new files, copied).

**Red test:** `cli/src/cable/hosts/scrollLines.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/scrollLines.ts`
- Test: `cli/src/cable/hosts/scrollLines.spec.ts` (new)

**Interfaces:**
- Produces, exactly as on the VS Code branch:
  ```ts
  export const SCROLL_SCALE = 2.5
  export const SCROLL_LINE_PX = 16
  export function createScrollLines(): { take(phase: 'down' | 'move' | 'up', dy: number): number }
  ```

- [ ] **Step 1: Copy the spec.** From the repo root: `VSCODE=/Users/duynguyen/orca/workspaces/autonomous-harness/dial-vscode-ext; git -C "$VSCODE" diff origin/main...HEAD -- cli/src/cable/hosts/scrollLines.spec.ts | git apply`. A diff that does not apply: stop and report.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/scrollLines.spec.ts`. Expected: FAIL (`scrollLines.js` is missing).
- [ ] **Step 3: Commit** the red test. Then copy the code the same way, for `cli/src/cable/hosts/scrollLines.ts`. Neither file is edited: the two branches must add the same bytes.
- [ ] **Step 4: Run** the step 2 command, then `npm run typecheck`. Expected: PASS, five tests.
- [ ] **Step 5: Commit** `dial: a stroke's travel as whole lines, with Harness's own numbers`.

### Task 2: The host knows the shown agent's id

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium` (four files, copied).

**Red test:** `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts`, `cli/src/cable/cableHost.ts`
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces, exactly as on the VS Code branch:
  - `CableHost.dialShows?(dial: object, agent: DialAgent | null, agentId: string | null): void`;
  - `CableSession.reportShown` keeps `shownId` beside `shown` and tells the host when either changed;
  - `DaemonCableHost.dialShows(dial: object, agent: DialAgent | null, agentId: string | null): void`, and `DaemonCableHost.shownAgentId(): string | undefined`. The wiring's `dialShows(agent)` still hears a name and an app only.

- [ ] **Step 1: Copy the two specs' diffs.** From the repo root: `git -C "$VSCODE" diff origin/main...HEAD -- cli/src/cable/cableSession.spec.ts cli/src/cable/cableHost.spec.ts | git apply` (`VSCODE` as in Task 1). A diff that does not apply: stop and report.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL in three tests: `the host hears the shown agent's id beside its name and app`, `a move between two agents of one name and app is told, with the new id`, and `shownAgentId is the agent the dial that moved last shows; …`.
- [ ] **Step 3: Commit** the red tests. Then copy the code: the same command for `cli/src/cable/cableSession.ts` and `cli/src/cable/cableHost.ts`. No file is edited by hand.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/services/devices.spec.ts && npm run typecheck`. Expected: PASS, `devices.spec.ts` unedited.
- [ ] **Step 5: Commit** `dial: the host knows the id of the agent the dial shows`.

### Task 3: `HostAdapter`'s scroll members, and the Herdr adapter's `canScroll` and `scroll`

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (a hook's address reaches a command line; a queue with a run under way, lines pending and a failure between them).

**Red test:** `cli/src/cable/hosts/herdrApp.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/herdrApp.ts`
- Test: `cli/src/cable/hosts/herdrApp.spec.ts`

**Interfaces:**
- Produces, in `adapter.ts`, on `HostAdapter`, with the spec's three comments word for word (spec §2):
  ```ts
  canScroll?(pane: Pane): boolean
  onScreen?(pane: Pane): Promise<boolean>
  scroll?(pane: Pane, lines: number): void
  ```
- Produces, in `herdrApp.ts`, on `HerdrAppAdapter`: `canScroll(pane: Pane): boolean` and `scroll(pane: Pane, lines: number): void`.
  - `canScroll`: macOS, `HC_TERMINAL.test(pane.id)`, `deps.inFront()`, `deps.shows(pane.id)`, then `binary() !== null`.
  - `scroll(pane, n)`: nothing off macOS, for an id out of form, for `n === 0`, or for an `n` that is no safe integer. With a run under way for that terminal, `n` joins its pending count, clamped to ±100. Else it starts the terminal's queue with `n`.
  - The queue, one entry per address in `scrolling`, `{ pending, lines, runs, failed }`:
    1. Run `[binary(), ['do', 'terminal.scroll', '--terminal', address, '--lines', String(n)], 2_000]`.
    2. Exit 0: the failed line may be said again; the pending count, when it is not 0, is the next run's `n` and is set to 0; repeat.
    3. No binary, any other exit, no exit code, or a rejection: that run's lines and the pending count are dropped; `[herdr-app] scroll · failed` is said unless it was said since the last run that succeeded; the queue stops.
    4. When the queue stops, a timer of 1 s starts, which the terminal's next scroll clears; once it fires, the entry is deleted and the drain line is said (final review: a run is faster than the dial's line, so a line at each drain came up to ~30 a second).
  - **(Q1)** The drain line's numbers, assumed until question 1 is answered: `<lines>` is the lines the runs that exited 0 carried (each run's `|n|`), `<runs>` the processes started, `<failed>` the lines dropped (a failed run's `|n|` and the `|pending|` dropped with it).

- [ ] **Step 1: Write the failing tests.** `scrollCall(address, lines)` is `{ file: FAKE_PATH_HERDR_APP, args: ['do', 'terminal.scroll', '--terminal', address, '--lines', String(lines)], timeoutMs: 2_000 }`.
  - `canScroll needs macOS, hc's form of address, Herdr in front, a terminal its window shows, and herdr-app found`: true with all five; false with each one taken away (`platform: 'linux'`, each of `FORGED`, `inFront: () => false`, `shows: () => false`, `onPath: () => null`).
  - `scroll runs herdr-app do terminal.scroll with the terminal and the lines, each one argument, within 2 s`: `scroll(pane('t7'), -3)` gives `calls` equal to `[scrollCall('t7', -3)]`; `scroll(pane('t7'), 2)` after it gives `scrollCall('t7', 2)`; with `onPath: () => null` and `exists` true for Herdr.app's own binary, that file runs.
  - `one run at a time: lines that come meanwhile are summed, and the next run carries them` (`holding()`): `scroll -3`, then `-2` and `-4` while it runs: one call; `answer(0)`: the second call is `scrollCall('t7', -6)`; `answer(0)`: no third.
  - `the pending count is clamped to 100 either way`: `-60` twice while a run is under way gives `scrollCall('t7', -100)`; `60` twice gives `scrollCall('t7', 100)`.
  - `lines that cancel while a run is under way run nothing more, and the queue drains` (Review Focus 1): `-3`, then `-2` and `2`; `answer(0)`: one call in all, and the drain line is said.
  - `another terminal's lines run beside it`: `scroll(pane('t7'), -1)` and `scroll(pane('t8'), -1)` are two calls at once.
  - `a scroll during a focus of the same terminal runs on its own`: with `focus(pane('t7'))` held at its `open`, `scroll(pane('t7'), -3)` adds `scrollCall('t7', -3)` at once, and the focus still ends true.
  - `a run that fails drops its lines and those pending, and says so once until a run succeeds`: `it.each` exit 1 and no exit code. `-3` then `-2` pending, the run fails: no second call, the log holds `[herdr-app] scroll · failed` once; a second failure adds no such line; after a run that exits 0, a failure says it again. The terminal takes lines again after each.
  - `with herdr-app gone nothing runs, and the lines are dropped`: `onPath: () => null`: `scroll(pane('t7'), -3)` makes no call and says the failed line once, however many follow.
  - `a run that rejects is a failed run` (Review Focus 5): `run` rejects; the line is said, the next `scroll` runs, and no rejection is left unhandled.
  - `the drain line counts what the queue did, and names no terminal` **(Q1)**: one run of `-3` that exits 0 says `[herdr-app] scroll · 3 lines · 1 runs · 0 failed`; `-3` then `-6` carried says `· 9 lines · 2 runs · 0 failed`; `-3` failing with `-2` pending says `· 0 lines · 1 runs · 5 failed`, after the failed line; no binary says `· 0 lines · 0 runs · 3 failed`. No line holds `t7`.
  - `a bad id or 0 lines runs nothing`: each of `FORGED`, and `n = 0`: no call, no log line.
  - `lines that are no whole number run nothing` (Review Focus 4): `NaN`, `Infinity`, `-Infinity`, `1.5`.
  - `off macOS nothing scrolls`: `linux` and `win32`: `canScroll` false, `scroll` makes no call.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrApp.spec.ts`. Expected: FAIL (`canScroll` and `scroll` are not functions).
- [ ] **Step 3: Implement.** The file's header gains a paragraph that says why: a run took 10–50 ms (5 runs on Diego's Mac, 2026-11-17), so 2 s, where a focus's 10 s would freeze a stroke; one run at a time so a fast stroke costs one process per round trip, not one per frame; a queue of its own so a scroll never joins an `agent.focus` run and loses its lines.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/cable/hosts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the Herdr adapter scrolls Herdr's view of a terminal, one run at a time`.

### Task 4: The Herdr adapter's `onScreen`

**Layer:** devices service process. **Depends on:** 3. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/herdrApp.spec.ts`.

**Files:**
- Create: `cli/src/testing/herdrAppStatus.ts`
- Modify: `cli/src/cable/hosts/herdrApp.ts`
- Test: `cli/src/cable/hosts/herdrApp.spec.ts`

**Interfaces:**
- Consumes: `HostAdapter.onScreen?` and the module's `SCROLL_TIMEOUT_MS` (Task 3).
- Produces, in `cli/src/testing/herdrAppStatus.ts`:
  ```ts
  /** `herdr-app status`'s stdout in Herdr 0.1.16's shape (docs/plans/2026-11-17-dial-herdr-scroll-design.md §3), written
   *  by hand with made-up ids: the devices read `agent` alone. With no argument the key is left out. */
  export const herdrAppStatus = (agent?: string | null): string
  ```
  One JSON object with the keys `zoom`, `font_size`, `ui_font_size`, `space`, `tab`, `focused_pane`, `layout`, `agent`, `floats`, `overlays`, `errors`, in that order. Every value but `agent` is made up (`1`, `13`, `13`, `'space-a'`, `'tab-a'`, `'pane-a'`, `'layout-a'`, `[]`, `[]`, `[]`); nothing reads them. Nothing of Diego's real output is copied.
- Produces, in `herdrApp.ts`, on `HerdrAppAdapter`: `onScreen(pane: Pane): Promise<boolean>`.
  - False with no run off macOS and for an id out of form.
  - One read at a time: `[binary(), ['status'], 2_000]`. An ask while a read is under way joins it.
  - A read fails with no binary, an exit that is not 0, a rejection, or a stdout that does not parse as a JSON object (an array and `null` are no object). It says `[herdr-app] status · failed` unless that was said since the last read that succeeded, and every ask of it is false.
  - A read that succeeds answers each ask `agent === pane.id`, `agent` a string. Nothing else of the stdout is read, kept or logged.
  - It never rejects.

- [ ] **Step 1: Write the fixture and the failing tests.** `herdrAppStatus.ts` goes in with the tests, so the red run fails on `onScreen` alone. The recorder's `run` answers `status` with the stdout the test set; `holding()`'s `answer` takes a stdout too. `statusCall` is `{ file: FAKE_PATH_HERDR_APP, args: ['status'], timeoutMs: 2_000 }`.
  - `onScreen runs herdr-app status within 2 s, and is true when its agent is the pane's terminal`: stdout `herdrAppStatus('t7')`, `onScreen(pane('t7'))` is true, `calls` equals `[statusCall]`, the log is empty.
  - `it.each` false, with one run and no log line: `herdrAppStatus('t8')`, `herdrAppStatus(null)`, `herdrAppStatus()`, and an object whose `agent` is `7`.
  - `it.each` false, with the failed line: stdout `'not json'`, `'[]'`, `'null'`, `'"t7"'`; exit 1; no exit code; no binary (no run).
  - `status · failed is said once until a read succeeds`: two failures, one line; a success; a failure, a second line.
  - `nothing but agent is read`: a stdout whose other keys hold other types (`space: 7`, `layout: null`, `overlays: 'x'`) and `agent: 't7'` is true; a mismatch with those values logs nothing.
  - `asks while a read is under way are that one read, each answered for its own pane` (Review Focus 2): `onScreen(pane('t7'))` and `onScreen(pane('t8'))` while the run is held: one call; answered `herdrAppStatus('t7')`: true and false. The next ask runs again.
  - `a read that rejects is false` (Review Focus 5): the failed line, and no rejection.
  - `a bad id asks nothing; off macOS nothing is asked`: each of `FORGED`; `linux` and `win32`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrApp.spec.ts`. Expected: FAIL (`onScreen` is not a function), Task 3's tests still passing.
- [ ] **Step 3: Implement.** Its comment says why the window is asked (hc's terminal facts have no focus or viewer), that one run took 0.04 s, and why a read is shared (a dial may send `down` after `down`).
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run src/cable/hosts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the Herdr adapter asks herdr-app which terminal is on screen`.

### Task 5: The hc source tells a listed agent's terminal

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium` (one read, one file).

**Red test:** `cli/src/cable/hosts/hcSource.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/hcSource.ts`
- Test: `cli/src/cable/hosts/hcSource.spec.ts`

**Interfaces:**
- Produces: `HcSource.paneOf(agentId: string): string | undefined`, the address the listed row of that id holds (`find()`); none for any other id.

- [ ] **Step 1: Write the failing test** `paneOf answers a listed agent's terminal, and none for another id or one that left`: `server.terminals = [agent('t7'), agent('t8')]`, `live(s)`; `paneOf(row(s, 't7')!.id)` is `'t7'` and `paneOf(row(s, 't8')!.id)` is `'t8'`; `paneOf('nope')` is undefined; after `server.remove('t7')` and the list down to one, `paneOf` of the id `t7` had is undefined.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hcSource.spec.ts -t paneOf`. Expected: FAIL (`paneOf` is not a function).
- [ ] **Step 3: Implement** it beside `shows` and `reports`, with a comment that says who asks (the dial's scroll, for an agent only hc lists).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/hcSource.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the hc source tells a listed agent's terminal`.

### Task 6: The devices route a stroke

**Layer:** devices service process. **Depends on:** 1, 2, 4, 5. **Effort:** `xhigh` (an answer that comes after later frames; a stale answer; a file held at 100%).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `createScrollLines` (Task 1); `DaemonCableHost.shownAgentId()` (Task 2); `HostAdapter.canScroll`, `onScreen`, `scroll` and the Herdr adapter's (Tasks 3, 4); `herdrAppStatus` (Task 4); `HcSource.paneOf` (Task 5); `ObservedSource.paneOf(agentId, adapter)` (unchanged).
- Produces, in `startDevices`, just before `const cableHost = new DaemonCableHost({`:
  ```ts
  interface ScrollTarget { adapter: HostAdapter; pane: Pane }
  /** What a stroke did while its route was asked, in a fixed size. */
  interface Held { down: boolean; dy: number; velocity: number; up?: number }
  /** Where the dial's scroll goes: the shown agent's pane in the first adapter that can scroll it now. */
  const scrollTarget = (): ScrollTarget | undefined
  let stroke:
    | (ScrollTarget & { lines: ReturnType<typeof createScrollLines> })
    | { deciding: ScrollTarget; held: Held }
    | 'windows'
    | undefined
  const routeScroll = (phase: 'down' | 'move' | 'up', dy: number, velocity: number): void | Promise<void>
  ```
  - `scrollTarget`: none with no `cableHost.shownAgentId()`. Else the agent's panes, in this order: for each adapter of `adapters` with `scroll`, `observed.paneOf(agentId, adapter.id)` as `{ adapter: adapter.id, id }`; then `hcSource.paneOf(agentId)` as `hcPane(address)` with `herdrAppNoted`. The first whose `adapter.canScroll(pane)` is true.
  - `routeScroll`:
    1. A frame begins a stroke when it is a `down`, when no stroke is under way, or when the stroke under way is deciding and its `up` came. It asks `scrollTarget()`: none is `'windows'`; a target whose adapter has no `onScreen` is that target with `createScrollLines()`; else the stroke is `{ deciding: target, held: { down: false, dy: 0, velocity: 0 } }` and `onScreen(pane)` is asked once.
    2. A frame of a deciding stroke, the one that began it too, is held and sent nowhere: a `down` sets `held.down`; every frame adds its `dy`; a `move` sets `held.velocity`; an `up` sets `held.up`.
    3. A frame of a decided stroke goes as on the VS Code branch: `'windows'` sends `dial_scroll` as it came; a target gets `adapter.scroll(pane, lines.take(phase, dy))`. An `up` ends the stroke.
    4. The answer counts only while `stroke` is still that deciding object; else it is dropped.
       - True: `lines = createScrollLines()`, `adapter.scroll(pane, lines.take('move', held.dy))`; the stroke is the target with `lines`, or none when `held.up` came.
       - False: `log('[device] scroll · <adapter.id> · not on screen')`; the windows get the held stroke ("Decided here"); the stroke is `'windows'`, or none when `held.up` came.
    5. It returns the `onScreen` chain when it asked.
  - The wiring: `scrolled: (phase, dy, velocity) => part.call('dial', () => routeScroll(phase, dy, velocity))`. The port's `scroll` (the Wi-Fi device's) already reaches it through `cableHost.scrolled`.
  - Once the port's `stop` began (`stopped`), no app is asked or run: a new stroke is the windows', a late answer is dropped, and a stroke already routed to an app runs nothing more; a stroke the windows took keeps its route to its up (final review).

- [ ] **Step 1: Write the failing tests** in a describe `a stroke on the dial scrolls Herdr (docs/plans/2026-11-17-dial-herdr-scroll-design.md)`, nested in `Herdr's agents, through Herdr Core` for its helpers.
  - Helpers: `shows(agentId)` is `host().dialShows(DIAL, agentId ? { name: 'api', app: 'herdr' } : null, agentId)`; `stroke(moves, velocity = 0)`, `dialScrolls(core)` and `toWindows(phase, dy, velocity)` as the VS Code branch's `devices.spec.ts` has them; `STATUS` is `['/opt/herdr-app/bin/herdr-app', ['status'], 2_000]`; `scrolled(address, lines)` is `['/opt/herdr-app/bin/herdr-app', ['do', 'terminal.scroll', '--terminal', address, '--lines', String(lines)], 2_000]`. `inHerdr(over)` is `withHc` with a `run` that records every call in `orcaRuns` and answers `status` as the test set it (by default exit 0 with `herdrAppStatus('t7')`; another agent; exit 1; or held until the test answers), then `live()` and `host().front('herdr')`. Every wait is `vi.waitFor` on `orcaRuns`, the frames or the log.
  - `with Herdr in front, the dial on an agent hc lists and its terminal on screen, a stroke's lines go to herdr-app and the windows hear no dial_scroll`: `down`, then `8`, `8`, `-24` each awaited, then `up`: `orcaRuns` equals `[STATUS, scrolled('t7', -1), scrolled('t7', -1), scrolled('t7', 3)]`; `dialScrolls(core)` is `[]`.
  - `a hooked agent in a Herdr terminal scrolls by its hook's address`: `port.observed(hook('session-start'))`, `shows(ID)`: the same runs.
  - `it.each` `with %s the stroke goes to the windows as before, velocity and all, and herdr-app is not asked`: another app in front; a Harness agent shown (`harnessAgent()`, `'h1'`); no agent shown; a hooked agent whose terminal Herdr's window does not show (`t8`, `space: false`); a hooked agent while the devices follow another hc session (`HC_SESSION=other`); a hooked agent in Ghostty; `HARNESS_DEVICE_OBSERVED` off; Linux. After `stroke([8], 300)`: `dialScrolls` equals `[toWindows('down', 0, 0), toWindows('move', 8, 0), toWindows('up', 0, 300)]`, and `orcaRuns` holds no `status` and no `terminal.scroll`.
  - `the route holds from down to up`: Herdr leaves the front after the `down`, and the dial moves to another agent: the rest of the stroke still scrolls `t7`. A stroke that began on the windows stays there when Herdr comes in front. After an `up`, a `move` with no `down` chooses by what it finds.
  - `status names another terminal: the whole stroke goes to the windows as a down, one summed move and the up, no terminal.scroll runs, and the line is said once` (the PM's third condition): status answers `herdrAppStatus('t9')`; `stroke([8, 8, -24], 300)`: `dialScrolls` equals `[toWindows('down', 0, 0), toWindows('move', -8, 0), toWindows('up', 0, 300)]`; `orcaRuns` equals `[STATUS]`; `said()` holds `[device] scroll · herdr-app · not on screen` once.
  - `a status that fails is not on screen`: exit 1: the same frames, and `[herdr-app] status · failed` beside the line.
  - `frames that come before the answer are taken as lines at once; those after go line by line`: status held; `down`, `8`, `8`; answer `t7`: `scrolled('t7', -2)`; then `8`: `scrolled('t7', -1)`.
  - `an answer after the up decides the whole stroke`: status held, `stroke([8, 8, -24])`, answer `t7`: `orcaRuns` equals `[STATUS, scrolled('t7', 1)]` and no `dial_scroll`; answered `t9` instead: the three frames above. Either way the next `move` asks `status` again.
  - `a newer down before the answer drops the stale one` (Review Focus 2): status held; `down`, `8`; `down`, `-8`, `up`; answer `t7`: `orcaRuns` equals `[STATUS, scrolled('t7', 1)]`, one `status` in all, `dialScrolls` is `[]`. Answered `t9` instead: the windows hear the second stroke alone, and the line is said once.
  - `a stroke with no travel replays its down and its up alone`; `a stroke that begins with a move replays no down`; `the held move carries the last move's velocity` (`move 8` at velocity 120: `toWindows('move', 8, 120)`).
  - `a fling is not played`: `down`, answer, `up 8` at velocity 900: `scrolled('t7', -1)` and nothing more after `vi.advanceTimersByTimeAsync(5_000)`.
  - `the Wi-Fi device's stroke takes the same route`: `port.scroll('down', 0, 0)`, `port.scroll('move', 8, 0)`: the same runs.
  - `an adapter that scrolls and has no onScreen decides at once`: through a copy of `../cable/hosts/herdrApp.js` (`vi.mock` with the real module spread, then `vi.spyOn` on `createHerdrAppAdapter` to drop `onScreen`): `stroke([8])` runs `scrolled('t7', -1)` before any wait, and no `status`. Removed at the rebase: VS Code's terminal is that adapter now, and `main`'s VS Code specs cover it.
  - `a throw on the scroll path is the part's, not the dial's`: `core.clients.sendLocal` throws: `host().scrolled('move', 8, 0)` does not throw, and the log holds `[devices] dial failed · <its message>`.
  - `a throw after the answer is the part's` (Review Focus 5): status answers `t9` and `sendLocal` throws in the replay: the same log line, and no rejection.
  - `the devices stopping drops a stroke still being decided` (Review Focus 3): status held, `down`, `8`; `await port.stop()`; the answer, either way: no `terminal.scroll`, no `dial_scroll`.
  - `no line about a scroll holds the terminal's address`: no line of `logs` with `scroll` or `status` in it holds `t7`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "a stroke on the dial scrolls Herdr"`. Expected: FAIL (the windows hear `dial_scroll`; no `status` and no `terminal.scroll` runs).
- [ ] **Step 3: Implement.** The comments say why: the route is kept so that Harness's windows never hold a drag whose `up` went to Herdr; the stroke is held, in a fixed size, because the window alone knows which terminal is on screen and its answer took 0.04 s; a stale answer is dropped so that nothing of a stroke left behind is sent anywhere.
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts src/leanEntry.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, `services/devices.ts` at 100% in every column. `git diff --stat 6e31e00202 -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.
- [ ] **Step 5: Commit** `dial: a stroke scrolls Herdr's view of the shown agent's terminal while Herdr shows it on screen`.

### Task 7: End to end, a private Herdr Core and a fake `herdr-app`

**Layer:** test. **Depends on:** 6. **Effort:** `high`. **Red test:** none: no behavior (the end-to-end test of Tasks 1 to 6), one commit.

**Files:**
- Modify: `cli/e2e/deviceHerdrApp.e2e.ts`

**Interfaces:**
- Consumes: `herdrAppStatus` (Task 4), `LocalClient` (`e2e/harness/client.ts`), and the file's own helpers.

- [ ] **Step 1: Extend the fake `herdr-app`** that `fresh` writes. It still records its arguments, one line a run, and exits 0. For `status` it also prints `herdrAppStatus` with the address in `<root>/herdr-app.screen`, or `null` when that file is absent or empty. Shell built-ins only, so the daemon's `PATH` is not relied on:
  ```ts
  const [head, tail] = herdrAppStatus('@').split('"@"')
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${join(d.root, 'herdr-app.log')}'`,
    '[ "$1" = status ] || exit 0',
    'agent=null',
    `[ -s '${join(d.root, 'herdr-app.screen')}' ] && IFS= read -r address < '${join(d.root, 'herdr-app.screen')}' && agent="\\"$address\\""`,
    `printf '%s%s%s\\n' '${head}' "$agent" '${tail}'`,
  ].join('\n') + '\n'
  ```
  The test writes the screen file with a trailing newline: `read` answers false without one. The file's header says what the fake now answers. `afterEach` closes each `LocalClient` first.
- [ ] **Step 2: Add the case** `a stroke with Herdr in front scrolls Herdr's view of the shown agent's terminal, and Harness's windows hear none of it`, built as the file's swipe test:
  1. `fresh`, a dial with `FILTER`, two Orca agents (`InOrca`), the private core's agent `api` at terminal `t`, Herdr counted behind Orca's ring. A `LocalClient` connects. The screen file holds `t`.
  2. The watch (`harness hardware watch --json`) says `{ front: HERDR }`; Herdr's ring comes; the dial turns to `api` (`{ t: 'focus', agentId }`); wait for `[device] swipe · ok`. The rest's `agent.focus` run is ignored from here on.
  3. **Stroke 1** (`down`, three `move`s of `dy: 8`, `up`, each `{ t: 'scroll', phase, dy, v: 0 }`), taken once the log holds its `cable: scroll ↑`. Wait until the `--lines` values of the runs `do terminal.scroll --terminal <t> --lines <n>` sum to `-3`. The number of runs is not fixed. Print the runs' count and the milliseconds from the `down` sent to that sum.
  4. **Stroke 2**, with the screen file holding `t9999`: wait for `[device] scroll · herdr-app · not on screen` and for the window's `dial_scroll` `up`. No new `terminal.scroll` run.
  5. The screen file holds `t` again; the watch says `{ front: ORCA }`; Orca's ring comes. **Stroke 3**: wait for the window's next `dial_scroll` `up`.
  6. Then: the window's `dial_scroll` phases match `down`, one to three `move`s whose `dy` sum to 24, `up` (stroke 2), then `down`, `move`, `move`, `move`, `up` (stroke 3), and nothing before them: stroke 1 reached no window. The `terminal.scroll` lines still sum to `-3`. `status` ran exactly twice. Each `[herdr-app] scroll · … lines · … runs · … failed` line ends `· 0 failed` and their first numbers sum to 3. The log holds no `[herdr-app] scroll · failed` and no `[herdr-app] status · failed`, and no line holds `t` as a word.
  Every wait is on a log line, a recorded run or a frame, never a fixed sleep. Timeout 180 s.
- [ ] **Step 3: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdrApp.e2e.ts --reporter=default`. Expected: PASS, five tests, none skipped, on this Mac. Skipped (no hc): report it as not verified. Then `npm run typecheck`.
- [ ] **Step 4: Commit** `e2e: a stroke on the dial scrolls Herdr, from a private Herdr Core and a fake herdr-app`.

### Task 8: Say it in the docs

**Layer:** repo file. **Depends on:** none. **Effort:** `medium`. **Red test:** none: docs only, one commit.

**Files:**
- Modify: `cli/AGENTS.md`

- [ ] **Step 1: Add one clause** to the `devices` row of "The processes", right after `or, while Herdr is in front, switches Herdr's terminal`:
  `; a stroke on the dial scrolls Herdr's view of the shown agent's terminal, line by line, while Herdr is in front and its window shows that terminal on screen (one `herdr-app status` a stroke, then `herdr-app do terminal.scroll`, one run at a time per terminal, 2 s each: `cable/hosts/herdrApp.ts`, `scrollLines.ts`), and goes to Harness's windows otherwise; the stroke under way and what it did while `status` answers (in memory)`
  Nothing else in the file changes.
- [ ] **Step 2: Commit** `docs: the devices process scrolls Herdr's view`.

## Open questions

Answered by the PM, 2026-11-17:

1. **The drain line counts (a):** `<lines>` the lines sent by runs that succeeded, `<runs>` the processes started, `<failed>` the **lines** dropped, one tally per terminal's queue. Task 3's **(Q1)** tests stand.
2. **No second Herdr.app is run.** The plan measures nothing against a window. The real feel is a check only Diego can do: the merge is **held** until Diego has checked it; when the PR is green, the main session sends the PM the test build and the steps (Verification 4).

## Verification

**Platforms the pull request names:** the daemon on macOS. Tested: the unit specs on Linux in PR CI and on this Mac; check 1 on this Mac. Linux and Windows: nothing a person sees changes; unit tests with `platform: 'linux'` and `'win32'` hold that no Herdr verb runs (Tasks 3, 4, 6).

**Never touched:** Diego's Herdr.app and its window, `~/.config/herdr-app`, his default hc session, his everyday daemon (port 18473), `~/.claude`, `~/.codex`, his tmux server, his dial, any backend, production. `/usr/bin/open` never runs: every e2e `open` is the harness's fake. No bare `herdr-app`, `hc` or `herdr-core` is run by a task or a check.

**Temporary workflow:** none. Check 1 is one file of about three minutes that needs macOS and an installed Herdr Core, which no GitHub runner has. Check 2 has a workflow of the repo's own.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 2).

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head, from `cli/`:
- `npm run typecheck`.
- `npx vitest run src/cable src/services/devices.spec.ts`: the specs of what changed.
- `npm run test:core`: **required.** It holds every file under `src/services/` to 100% per file, `services/devices.ts` among them. It is the one gate the repo requires for these paths (`python3 scripts/local-checks.py --list <the changed paths>` answers `cli-core` alone).
- `npx vitest run src/architecture.spec.ts src/architecture.environment.spec.ts src/leanEntry.spec.ts`, and `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/vitest.setup.ts` prints nothing.
- From the repository root: `python3 scripts/local-checks.py --run`, from a clean tree at the final commit. Its receipt goes in the pull request's body before the tested commit is pushed.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make desktop-test`, a firmware build or flash.

**1. A private Herdr Core, a fake `herdr-app`, the real daemon, a fake dial**
- Where: this Mac only, at the final head. Herdr Core 0.1.21 at `~/.local/bin/herdr-core`. No test account and no sign-in: the daemon signs in to a fake backend on loopback.
- Build: nothing by hand. The suite starts the daemon from the working tree.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdrApp.e2e.ts --reporter=default`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6) and the file's:
  - a throwaway home, data folder and Codex home, a private port and tmux server, a fake dial on a pseudo-terminal, a fake backend on loopback;
  - a Herdr Core of the test's own (`cli/e2e/harness/hcCore.ts`): a session named `harness-<random>`, its `HOME` and every `XDG_*` in a scratch root, started and stopped through its own session only;
  - the fake `herdr-app`, first on the daemon's `PATH` and checked to be the one it resolves before anything runs; the fake `open` (`HARNESS_OPEN_BIN`);
  - the daemon under test inherits no `HC_*` and no `XDG_*` (`src/testing/daemonEnvironment.ts`); the test gives it the private `HC_SOCKET` alone.
  - Before the run, note `launchctl list | awk '$3 ~ /^dev\.herdr\.core\./ { print $3 }' | sort`. After it, the same lines.
- A person sees: five tests pass, none skipped. The new one's `herdr-app.log` holds two `status` lines and `do terminal.scroll --terminal <address> --lines <n>` lines whose `n` sum to -3; its log holds `[device] scroll · herdr-app · not on screen` once and drain lines that end `· 0 failed`; it prints the first stroke's run count and milliseconds. No private core is left, and Herdr's own window never moved.
- If hc is not installed, or the file is skipped: report it as not verified, never as passed.
- On GitHub: none. No runner has hc, and the file reads skipped there. **Proposal** (not this pull request): a macOS job of `cli-e2e.yml` with Herdr Core installed, for this file.

**2. The other dial flows still hold**
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-herdr-scroll` (`.github/workflows/cli-e2e.yml`). Every shard passes. `deviceHerdrApp.e2e.ts` reads skipped there. The link goes in the pull request.
- Isolation: the suite's own. No account, no secret.
- What it shows: `dialStream.e2e.ts` (the `dial` stream still hears a name and an app as the shown agent's id is kept beside them), `devicesProcess`, `deviceWithoutApp`, `dialAppFilter` and the other dial files pass on the new `dialShows` argument and the routed `scrolled`.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 6 on Linux. Nothing is started by hand.

**4. Numbers** (root rule 4: terminal I/O, idle daemon work), read from check 1 and held by specs:
- at rest: nothing. No timer, no watch, no process (the adapter has no `after`; Tasks 3 and 4 run nothing until asked);
- a stroke whose target is not Herdr: `scrollTarget()` at its `down`, in memory, and no process (Task 6's `it.each`);
- a stroke on Herdr: one `status` (0.04 s on Diego's Mac, the spec's Phase 1), then at most one `herdr-app` process at a time per terminal, 10–50 ms each in Phase 1, however many frames the dial sends (Task 3); check 1 prints the count and the time with the fake;
- before this change: a stroke ran no process.

**5. On a real Herdr (person-only; after merge, not in this pull request):** a real stroke on Diego's dial over his own Herdr window: that it scrolls the shown agent's terminal only while it is the one on screen, and its feel (speed, lag). It needs his own Herdr, his dial and his eye. No agent runs it.

**6. Against production:** none, and never.

## Fixes after Diego's first check (2026-11-18)

Diego's check on a shared test build scrolled nothing while the log said 175 runs succeeded. `herdr-app status`'s
`agent` is not the terminal on screen (spec, "What Herdr offers"), so the third condition read the wrong field. The PM
approved both fixes below (2026-11-18). One `devcrew-implementer` does them in order, each red then green.

### Task 9: The third condition matches the tab on screen

Files: `cli/src/cable/hosts/hcClient.ts` (+spec), `cli/src/cable/hosts/hcSource.ts` (+spec),
`cli/src/cable/hosts/herdrApp.ts` (+spec), `cli/src/testing/herdrAppStatus.ts`, `cli/src/services/devices.ts` (+spec,
the `tabOf` wiring only), `cli/e2e/deviceHerdrApp.e2e.ts`. Depends on: none. Effort: `xhigh`.

- Red: `herdrApp.spec.ts`: `onScreen` is false for a status whose `agent` is the pane's address but whose `tab` is
  another than `tabOf(pane.id)`, and true when `tab` equals it (fails today: `agent` decides). Then the spec's other
  `onScreen`, `hcClient` and `hcSource` cases.
- Green: as the spec's §3 says: `READ` keeps `herdr.tab`; `HcTerminal.tab`; `HcSource.tabOf(address)` for the
  terminals `shows` covers (the change check `same` counts `tab`, so a moved terminal is seen); the adapter dep
  `tabOf(address): string | undefined`; `onScreen` reads `tab` only.
- The e2e's private terminal gets a `herdr.tab` label; its fake `status` prints `tab` from the file the test writes,
  with `agent` left on the terminal's address in the not-on-screen step.

### Task 10: At most one scroll run every 50 ms per terminal

Files: `cli/src/cable/hosts/herdrApp.ts` (+spec). Depends on: Task 9 (same file). Effort: `xhigh`.

- Red: with a fake clock and instant runs, lines sent every 10 ms start a run at most every 50 ms per terminal, their
  lines summed; a stroke's first run starts at once; another terminal does not wait.
- Green: `SCROLL_GAP_MS = 50`: the drain waits on the deps' timer, never a sleep, until 50 ms after the last run of that
  terminal started; pending stays clamped to ±100; the quiet-second tally and the failure line are unchanged.

## Claude Code draws on the alternate screen (2026-11-18)

Diego's second check (Herdr and VS Code) scrolled nothing: Claude Code 2.1.327 runs on the alternate screen, so Herdr's
view has no history (spec, "What Herdr offers"). The PM chose option A (2026-11-18): Claude Code terminals scroll by
`pageup`/`pagedown` through hc; option B (Herdr sends wheel reports) is a follow-up for Herdr's maker.

### Task 11: A Claude Code terminal scrolls by keys through hc

Files: `cli/src/cable/hosts/hcClient.ts` (+spec), `cli/src/cable/hosts/hcSource.ts` (+spec),
`cli/src/cable/hosts/herdrApp.ts` (+spec), `cli/src/services/devices.ts` (+spec, wiring only),
`cli/e2e/deviceHerdrApp.e2e.ts` and `cli/e2e/harness/hcCore.ts` if the e2e needs a fake program that reports
`claude-code`. Depends on: Tasks 9 and 10. Effort: `xhigh`.

- First, a measure against a private hc core only (the e2e harness's), never the person's: does `terminal.keys` wait
  while a fake program keeps writing output? Time a `keys` call to a terminal printing a line every 100 ms, and to an
  idle one. Record the numbers in the spec's finding and the PR. Never run the real `claude`. Measured 2026-11-18: it
  does not wait (a call answered in 32–45 ms, spec §3), so a `working` Claude Code takes keys.
- Red: `herdrApp.spec.ts` and `hcClient.spec.ts` cases from the spec's Tests section (a `claude-code` terminal's stroke
  presses `pageup` through `keys` and runs no `herdr-app`; fails today: it runs `terminal.scroll`).
- Green: as the spec's §3 "A Claude Code terminal is scrolled by keys" and "No key while Claude Code asks" say: no key
  while hc's state is `blocked` or one it has not told, asked at the stroke's down and again right before each call;
  `working` takes keys, as measured. A key call has 5 s, past hc's hold of 3 s after the person's own key (measured in
  review). The adapter learns the terminal's app and state from the hc source (new deps, as `shows`/`tabOf`); its
  status is none from a subscription's drop until the next snapshot.
- e2e: a stroke over a private terminal whose fake program reports `claude-code` presses `pageup`/`pagedown`, seen
  in what the fake program reads (the keys' bytes), and runs no `terminal.scroll`; the existing case keeps
  `terminal.scroll` for another app.
- Tuned after Diego's check of 0.6.65-dev (PM, 2026-11-18): one key per 8 lines, the lines short of one kept across
  strokes until the quiet second and tallied failed when dropped, one key a call 100 ms apart, ±32 lines waiting.
