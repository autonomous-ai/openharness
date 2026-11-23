# Dial eval for the Orca app Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** One 0–100 score for Orca, from 21 more scenarios of the dial eval's catalog (17 main, 4 held out), graded in
tiers A and B beside the Claude app, the ChatGPT app, VS Code and Cursor, with the same gate and a ratcheting baseline.

**Architecture:** The eval (`cli/src/testing/dialAppEval/`, `cli/e2e/harness/appEval*.ts`) gains a fifth app. Tier A keeps
`cable/hosts/orca.ts` real: the world answers Orca's CLI through the devices' `orca` deps from a model of Orca's layout,
plays the plugin's `dial` stream and `orcaFront` on the devices' own listener handlers, and puts each agent on a pty under
a modelled terminal host so the real maker check runs. Tier B runs the harness's fake `orca` (as `orca` and `orca-ide`),
each agent's hooks on its own terminal-host stand-in, and the plugin's own loop on the throwaway home. One pure module
prints Orca's `terminal list` for both tiers; two check kinds change (`open` for an Orca row, the new `face`).

**Tech Stack:** TypeScript (Node 24), Vitest (unit suite and `vitest.e2e.config.ts`), the e2e harness (`IsolatedDaemon`,
`Desk`, `FakeDial`, `FakeOrca`, `InOrca`, `orcaHost`, `CodexOutside`, the plugin's loop, the fake backend), Python 3 for
`scripts/ci-plan.py`.

**Spec:** `docs/plans/2026-11-22-dial-eval-orca-design.md`. It extends the **base spec**
`docs/plans/2026-11-21-dial-app-eval-design.md` and builds on the **editor spec**
`docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md`. Read all three; this spec's Decisions are final. The editor plan
(`git show feat/dial-eval-vscode-cursor:docs/plans/2026-11-22-dial-eval-vscode-cursor-plan.md`) explains most of the code
this plan builds on.

## Before Task 1: the merged contract

Phase 3 starts only once `feat/dial-eval-vscode-cursor` has merged to `main` and this branch is rebased onto it. Its first
step, before any task: re-check the contract below on `main`. Every task names files and symbols as they are on that
branch at `6a45ea1131`. Where the merged code differs (a renamed symbol, a moved file, a changed shape), a task uses the
merged name or shape and says so in its commit message. If a piece is missing on `main` (for example `machine.appOf` or
`Seen.logs`), stop and return to the main session: do not rebuild it here.

| What | Where (editor branch) |
|---|---|
| `APPS`, `EDITORS`, `PAGE`, `Engine`, `engineOf`, `placeOf`, `agentIdOf` (by engine), `SessionDef.tmux`, `codexHome: 'own'` | `cli/src/testing/dialAppEval/types.ts` |
| `Baseline.apps` as `Partial` records; `Seen.streams`, `Seen.logs` | `types.ts` |
| `MachineModel.appOf`, `folders`, `owners` | `tierA/machine.ts` |
| `TierAWorld.listener`, `logs`, `folders.codexHomes`; `answer`, `gap`, `deliver` | `tierA/world.ts` |
| The step-module pattern (a WeakMap of state per world, handlers on `world.listener`) | `tierA/steps/editor.ts` |
| `TierBWorld.folder`, `stream`, `children`; `FRONT`, `SCHEME`, `tierBGaps`, `deskEmpty`, `workPaths` | `cli/e2e/harness/appEvalDriver.ts` |
| `LINUX_E2E_APP_EVAL_FILES`, `LINUX_E2E_APP_EVAL_PATHS` and their tests | `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py` |
| The catalog's kind-coverage case, the own-waits list, the inputs rule | `catalog.spec.ts` |
| `baseline.json` holding the editors' entries | written by the editor branch's last task |

## Global Constraints

- Kept from the base: weights D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5; the latency thresholds (inclusive,
  1 / 0.5 / 0); points lost `100 · (w_d / Σw) · (1 − score_c) / n_d`; target ≥ 95 reported, never failing CI.
- Gate: a voice prompt delivered to a session or pane other than the scenario's target fails the whole run. A wrong-session
  send in any tier A run of a task, or in the baseline run, stops the task: report it (the PM decides before anything
  merges).
- PM 2026-11-21: (1) agents in another worktree's terminals are skipped while Orca is in front and the plugin has said
  which worktree is on screen; (2) tmux inside Orca stays off the ring. PM 2026-11-22: (3) graded on what the person
  expects where no path exists yet, including Orca in front on Linux and Windows through the real `frontAppId`.
- **Never the real Orca.** No task runs the real Orca app or a real `orca`/`orca-ide`, nor reads or writes Orca's state,
  worktrees, terminals or plugins on the machine (the work runs inside a real Orca session). Tier A: every process start
  refused, every `orca` command answered by the world. Tier B: fakes and throwaway homes only; the network guard stays on.
- **No product code changes.** Test code, the e2e harness, `scripts/ci-plan.py` and its test, `cli/ci-e2e-durations.json`,
  the `docs/validation-and-release.md` row, `baseline.json`. Every stand-in is a `vi.mock`, an existing `DevicesDeps` seam
  (`orca`, `orcaReads`, `orcaHomes`, `orcaPlugin`, `listen`, `tty`) or a harness fake. A task that finds it needs a new
  seam stops and returns the question; nothing under `cli/src/core/`, `cli/src/services/`, `cli/src/cable/`,
  `cli/src/devices/`, `cli/hook/` or `plugins/` changes.
- The other apps' tier A results do not change; their tier B pass/fail checks equal `main`'s; their tier B latency and
  cost entries are written as measured.
- Held out: OH1–OH4 (4 of 21) in `heldOut.ts` and `dialAppEvalHeldOut.e2e.ts`; scored apart.
- Tier A deterministic, the whole tier under 60 s, no D8. Tier B one Orca file under about 6 minutes on a CI runner;
  tier B's baseline holds macOS; Linux is gate-only; Windows tier B is a gap, listed.
- Tier B on this Mac always runs under `caffeinate -i`.
- Fixtures are made up: titles start with `Eval `, folders with `/work/eval-`, handles and ids are fixed made-up UUIDs. No
  result or evidence holds a handle, a worktree id, a path, a pid or spoken text.
- No fixed sleeps in tier A; tier B waits are bounded `until` polls; a scenario's own `wait` is scenario timing.
- Copy follows the Naming System: "the dial", "Orca", "Claude Code", "Codex".

## Review Focus

1. **The other apps' results moving under shared changes:** tier A now builds Orca's real reads on the world's `orca`
   deps (no `noOrca`), finds an Orca CLI, tells every app's front through `frontAppId`, records refusals on faces and maps
   typed words to a session by handle. Tasks 1, 3 and 5 run the tier A spec against the committed baseline: `matches the
   baseline` stays green, and Task 17 compares every other app's held check with `main`'s.
2. **Words typed to a handle no session owns** (a held pane's, a closed pane's, an old handle after a relaunch) are a
   `typed` delivery to none, a wrong send. Task 3's `voice.spec.ts` and Task 14's tier B spec.
3. **The runner's own Orca reaching a test:** an `orca-ide` or `orca` resolved outside the daemon's root, a variable of
   this worker's in a spawned environment, a hook run on this worker's terminal. Tasks 10 and 12, before any tier B
   scenario.
4. **A relaunched session graded on its old handle:** `open`, the typed target and `orca.focus` all read the session's
   handle at its current launch (`orcaPaneHandle`). Tasks 1, 4 and 6.
5. **A check that measures nothing passing:** `face` with no face seen, `open` of an Orca row the dial was never sent.
   Task 6's spec.

## Decisions this plan makes (from the spec's room)

1. **Ids.** An Orca session's id is `00000000-0000-4000-8c00-<the key's hex, 12 wide>`; its terminal's handle
   `term_00000000-0000-4000-8d00-<hex>` (`orcaTerminalHandle(key)`), and at its nth relaunch `8d0<n>` in place of `8d00`
   (`orcaPaneHandle`). Its hooks' `ORCA_AGENT_SESSION_ID` is `eval-orca-<key>`. No other app's ids change.
2. **Worktrees.** Keys `w1`, `w2`, … (`w01`…`w40` in O16). Orca prints a worktree's id as `eval-repo::/work/eval-<key>`
   (`orcaWorktreeId`) in both tiers and its path as `/work/eval-<key>` (tier B: `world.folder` of it). A session's `cwd`
   defaults to its worktree's path.
3. **The layout** (`orcaLayout`, both tiers): the latest `orca.layout` step's worktrees in its order; each lists the open
   panes of its sessions by `tab`, then `split`. A pane opens at its session's start, closes at `orca.close`, at its
   session's end and at Orca's quit, and comes back at the relaunch on its next handle. Each pane is titled by its
   session's title; a tab by the person's rename (`renamed`), else by its first pane's title. Each pane has its row in
   `terminals` with its handle, worktree path and id, and `agentIdentity` its engine, a tmux session's too (Open question
   2).
   OH4's session (`handle: 'none'`) is laid out on `orcaTerminalHandle(key)` though its hooks name none. Until the first
   `orca.layout`, the list holds nothing.
4. **Hints** (`hook/notify.mjs` `HOST_HINTS`): every platform `ORCA_AGENT_SESSION_ID` and, unless `handle: 'none'`,
   `ORCA_TERMINAL_HANDLE` (the current handle); macOS adds `__CFBundleIdentifier=com.stablyai.orca`; a `tmux` session adds
   `TMUX_PANE` (tier A: the hook keeps no `TMUX`; tier B's env carries both, as a real tmux hands them on). No
   `TERM_PROGRAM`, as the existing Orca e2e files.
5. **Processes in tier A.** One terminal host per world, on no tty, ppid 1: `RECORDED_ORCA.macos`'s helper executable on
   macOS, `orca-agents` on Linux, `Orca.exe` on Windows (no maker check there). Each pane is a shell on a tty of its own
   (`ttys0NN`, `pts/N`; none on Windows) under the host, the agent on the same tty under the shell. A `held` session's
   shell runs under its own maker, `HELD_MAKER` (`eval-terminal`), on no tty. A `tmux` session: the pane's shell runs the
   tmux client; a `tmux` server (no tty, ppid 1) runs a shell on another tty and the agent under it. No Orca process has an
   app id: `RECORDED_ORCA` records no bundle id for the helper, and `frontAppId` names no Linux comm of Orca.
6. **Orca's CLI on the model (tier A).** macOS: the app's own, `HARNESS_ORCA_APP_BIN` stubbed to
   `<world root>/Orca.app/Contents/Resources/bin/orca` and `exists` true for it alone. Linux: `onPath('orca-ide')` answers
   `/opt/eval/orca/resources/bin/orca-ide`. Windows: `onPath('orca')` answers
   `C:\Users\eval\AppData\Local\Programs\orca\resources\bin\orca.exe`. `onPath` never calls its `accept` (it reads the real
   disk). `mtime` answers `{ realPath: path, mtimeMs: 1_763_337_600_000 }`. `ANSWERED` gains `orca`, `orca-ide` and
   `orca.exe`. `terminal --help` answers a `Commands:` list of `list`, `switch`, `send`, and `watch-focus` unless
   `world.orca.watchFocus === false`. The watch's spawn is recorded as a command too, as tier B's fake notes its run.
7. **Orca's echo.** A `terminal switch` that answers 0 is echoed as a focus line for its handle on every running watch:
   tier A 100 virtual ms later, tier B's fake at once. A new watch first prints the last focus line told, as the fake's
   `tail -n 1` does.
8. **`orca.close`** (a step kind the spec's Contract does not list; the base spec lets the planner add one): the pane
   closes and its agent's and shell's processes end with no hook. O14's removal and O15's close use it.
9. **The plugin.** `orcaOpening(worktrees, renamed?)` gives every Orca scenario `orca.layout` then `orca.plugin open`.
   With `world.orca.plugin === false` (O13) the plugin step does nothing and no plugin process ever runs, as `editor.window`
   with `extension: false`. Orca's quit closes the stream; its relaunch opens it again where it was open. Tier A's stream
   is a fake `ListenerStream` that takes every line and records none (the lines hold names).
10. **The front by its OS's name, for every app.** `FRONT_NAMES` (types.ts): macOS bundle ids (Orca `com.stablyai.orca`,
    other `com.apple.Safari`), Linux window processes (Orca `orca-ide`, other `firefox`), Windows programs (`Claude.exe`,
    `ChatGPT.exe`, `Code.exe`, `Cursor.exe`, Orca `orca.exe`, other `firefox.exe`). Tier A tells the listener
    `frontAppId(name)`; tier B's driver writes the name on the watch, which maps it. It replaces tier B's `FRONT` and tier
    A's `PAGE` route, one way; every app but Orca maps to its own page on every platform, so their results do not move.
11. **`open` of an Orca row.** Parts: `worktree` (the last `worktree activate` before the switch in the window names
    `id:<orcaWorktreeId(s.worktree)>`; none ran passes, the spec's "if any"), `switch` (a `terminal switch --terminal <the
    session's handle at that launch>` that succeeded). A tap adds `raise` (a command that brings Orca forward, by
    `checks.ts` `fronts`, at or after the switch) and `latency` (tap step to the raise, timed). A swipe's rest adds
    `noRaise` (no such command in the window) and no latency. In tier B on Linux a tap has no `raise` and no `latency`
    part (the spec's "left out"), and the report lists it under the score table.
12. **`face`**, one part `face`: from the check's `after` on, no face's `refused` rose above the last face's before the
    window, and no face held tiles with none on the face; no face seen fails. A face with no tiles and none active (the
    two-step ring's empty step) passes. O3 grades it as D7.
13. **Names of Orca rows** (the spec's name rule): the tab's rename at the check's end, else a Claude Code session's own
    title, else its tab's title (`tabTitle`), else the folder's name.
14. **Tier B commands.** The fake Orca's runs are commands at their own times (each run a file of its own, its mtime) with
    argv `[<the name it was run by>, …args]`; the recording open's at their read, as today. So in tier B a raise read in
    the same read as its switch counts as after it; tier A's order is exact.
15. **Tier B watch-focus support** is switched by rewriting the fake's launcher (`FakeOrca.watchFocus`), so its mtime
    moves and the devices ask `terminal --help` again, as after an Orca update.
16. **Tier B processes.** Each Orca agent is a stand-in host (`orcaHost.ts`, the C program) with its Node runner, the
    caller of every hook; no engine process runs. Claude Code's hooks are `InOrca`'s on that terminal, Codex's
    `CodexOutside`'s on it; an agent ends when its stand-in ends. At a scenario's stop each Claude Code agent runs its
    `SessionEnd` first.
17. **Engines where the spec leaves them:** OH1's focused agent is Codex beside a working Claude Code; OH2's two are Codex
    (the words reach "the pane"); every other unnamed agent is Claude Code.
18. **Scaffolding.** Task 1 adds the new step and check kinds with handlers that throw `… is not built yet`, and narrows
    `catalog.spec.ts`'s kind-coverage case to kinds some scenario uses; Tasks 3, 4 and 6 replace the throws; Task 17
    restores the case over every kind and checks none is left.
19. `cli/e2e/harness/pluginLoop.ts` (Task 11) joins `LINUX_E2E_APP_EVAL_PATHS` beside the spec's list: it is what the
    file's plugin runs on.
20. **Open question 1's default:** a `process.platform` read is a coverage gap only where it decides a check. Tier A plays
    the plugin's messages itself and injects `orcaHomes`, so neither `inputs.platform` nor `orcaHomesDeps` is on its path,
    and neither leaves a scenario out.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Orca in the contract, the grader, the report and the faces | high | - |
| 2 | Orca's terminal list, from a scenario's layout | high | 1 |
| 3 | Tier A: Orca's agents and CLI on the model, its watch, and the 60 s budget | xhigh | 1, 2 |
| 4 | Tier A: the plugin's stream and front, a pane's close, Orca's quit and relaunch | high | 3 |
| 5 | Tier A: the app in front by its OS's own name | medium | 1 |
| 6 | Checks: Orca's `open`, `face`, Orca's names | high | 1, 2 |
| 7 | Catalog: Orca, O1–O17 | high | 3, 4, 6 |
| 8 | Catalog: Orca's held-out set, OH1–OH4 | high | 7 |
| 9 | The eval command runs the Orca tier B file | medium | - |
| 10 | Tier B: Orca's CLI is the fake, as `orca` and `orca-ide`, inside the root | xhigh | 1 |
| 11 | The plugin's loop in the e2e harness | medium | - |
| 12 | Tier B: Orca's agents on stand-in hosts, environments from scratch, and the safety cases | xhigh | 10, 11 |
| 13 | Tier B: the fake Orca for the eval | high | 10 |
| 14 | Tier B: Orca, with O3 measured first | xhigh | 2, 7, 8, 9, 12, 13 |
| 15 | Tier B: Orca's held-out scenarios | high | 8, 14 |
| 16 | `ci-plan.py`: linux-e2e runs the Orca file | high | - |
| 17 | The baseline | xhigh | 5, 8, 9, 14, 15 |

Files more than one task touches (devcrew runs those tasks one at a time): `types.ts` (1), `catalog.ts` (3, 7),
`catalog.spec.ts` (1, 7, 8, 14, 17), `checks.ts` (1, 6), `report.ts` (1, 14 if O16 leaves tier B), `tierA/world.ts` (1, 3),
`tierA/driver.ts` (1, 3, 4), `tierA/steps/sessions.ts` and its spec (3, 4), `tierA/steps/orca.ts` and its spec (3, 4),
`dialAppEval.spec.ts` (3, 4), `orcaScenarios.ts` and its spec (7, 14 if O16 leaves tier B), `heldOut.ts` (8),
`e2e/harness/appEvalDriver.ts` (1, 10, 14), `fakeOrca.ts` (10, 13), `appEvalOrca.ts`, `dialAppEvalOrca.e2e.ts` and
`dialAppEvalTierBOrca.spec.ts` (12, 14, 15). No task edits another app's catalog file: one that finds an entry wrong
reports it.

Longest chain: 1 → 2 → 3 → 4 → 7 → 8 → 14 → 15 → 17 (nine tasks).

---

## Foundations

### Task 1: Orca in the contract, the grader, the report and the faces

**Files:** Modify `cli/src/testing/dialAppEval/types.ts`, `types.spec.ts`, `grade.spec.ts`, `report.ts`, `report.spec.ts`,
`checks.ts` (`SCHEMES` by `LinkedApp`, the `face` stub), `catalog.spec.ts` (`stepKeys`, `checkKeys`, `sees`, the
kind-coverage case), `tierA/world.ts` (its `APPS` by `LinkedApp`), `tierA/driver.ts` (the five stubs),
`tierA/loopbackDial.ts`, `tierA/loopbackDial.spec.ts`, `cli/e2e/harness/appEvalDriver.ts` (`SCHEME` by `LinkedApp`,
`FRONT` replaced by `FRONT_NAMES`, a face's `refused`), `cli/src/testing/dialAppEvalTierB.spec.ts`. **Depends on:** -.
**Effort:** high.

**Interfaces:** Produces (beside what `types.ts` has):

```ts
export type App = 'claude' | 'chatgpt' | 'vscode' | 'cursor' | 'orca'
export const APPS: readonly App[]                  // the five, Orca last
// PAGE gains orca: 'orca'
/** The apps whose rows open by a link of their scheme: all but Orca. */
export type LinkedApp = Exclude<App, 'orca'>
/** The maker of a held Orca pane's terminal, in both tiers: a program that is not Orca's terminal host. */
export const HELD_MAKER = 'eval-terminal'
/** The app in front as each OS names it (Decision 10). */
export const FRONT_NAMES: Readonly<Record<Platform, Readonly<Record<App | 'other', string>>>>
// SessionDef gains, each doc-commented from the spec's Contract additions:
//   worktree?: string; tab?: number; split?: number; handle?: string /* 'none': its hooks name none */; held?: true
// Scenario['world'] gains: orca?: { watchFocus?: false; plugin?: false }
// STEP_KINDS gains, with these Step members:
//   | { kind: 'orca.layout'; worktrees: string[]; renamed?: Record<SessionKey, string> }
//   | { kind: 'orca.focus'; session: SessionKey }
//   | { kind: 'orca.front'; worktree: string }
//   | { kind: 'orca.plugin'; open: boolean }
//   | { kind: 'orca.close'; session: SessionKey }
// CHECK_KINDS gains: | { kind: 'face' }
// Seen['faces'][number] gains: refused: number        // the carousel model's count so far
export function orcaTerminalHandle(key: SessionKey): string                              // Decision 1
/** The handle of the terminal Orca lays the session out in at its nth launch (0: its first). */
export function orcaPaneHandle(s: Pick<SessionDef, 'key' | 'handle'>, launch: number): string
/** The handle its hooks name at that launch: none for `handle: 'none'`. */
export function hookHandle(s: Pick<SessionDef, 'key' | 'handle'>, launch: number): string | undefined
export function orcaWorktreeId(worktree: string): string                                 // Decision 2
```

- `report.ts` names Orca `Orca`, after Cursor; under the score table, in `summary` and `markdown`, `Not covered: tier B on
  Windows; in tier B on Linux, the raise of a tap on an Orca row`.
- `checks.ts` `SCHEMES` is `Record<LinkedApp, string>`; a link lookup for an app with none gives none. `partsOf` gives
  `face` a case that throws `the face check is not built yet`.
- `tierA/world.ts` `APPS` and `appEvalDriver.ts` `SCHEME` are keyed by `LinkedApp`. `appEvalDriver.ts` writes
  `FRONT_NAMES[platform][app]` on the watch, and `World.face` records the carousel's `refused` and records a face when only
  it changed; that rule is exported as `faceChange(last, next): boolean`.
- `tierA/loopbackDial.ts` records `refused` on each face, a change of it alone making a new face.
- `tierA/driver.ts` `STEPS` gets a handler per new step kind that throws `tier A: the <kind> step is not built yet`.
- `catalog.spec.ts`: `stepKeys` names `orca.focus`'s and `orca.close`'s session and `orca.layout`'s `renamed` keys;
  `checkKeys` names none for `face`; `sees` gains `orca.layout: ['ring']`, `orca.focus: ['focus']`, `orca.front: ['ring']`,
  `orca.plugin: ['ring']`, `orca.close: ['ring']`; the kind-coverage case iterates only kinds some scenario uses
  (Decision 18; if the merged case already does, leave it).

- [ ] **Step 1: Failing tests.** `types.spec.ts`: `APPS is the five apps, Orca last`; `PAGE names Orca's page orca`;
  `orcaPaneHandle gives the session's handle at its first launch and 8d0n at its nth; a session whose hooks name none is
  laid out on its key's handle, and hookHandle gives it none`; `orcaWorktreeId is eval-repo::/work/eval-<key>`; `every app
  but Orca maps through frontAppId to its own page from its FRONT_NAMES name on every platform; Orca's macOS name maps to
  orca`. `grade.spec.ts`: `Orca is scored from its own results, the other four untouched`; `a baseline written before Orca
  joined has no Orca entry and grades its results all the same`. `report.spec.ts`: `the score and held-out tables have a
  row for Orca, after Cursor`; `the Not covered line names Orca's tap raise in tier B on Linux`. `loopbackDial.spec.ts`:
  `each face records the carousel's refused count, and a refusal alone makes a new face`. `dialAppEvalTierB.spec.ts`:
  `faceChange is true for a change of page, tiles, the face or refused alone, and false for none`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/types.spec.ts src/testing/dialAppEval/grade.spec.ts
  src/testing/dialAppEval/report.spec.ts src/testing/dialAppEval/tierA/loopbackDial.spec.ts
  src/testing/dialAppEvalTierB.spec.ts` → FAIL.
- [ ] **Step 3:** Implement the list above.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts
  src/testing/dialAppEvalTierBEditor.spec.ts` → PASS, `matches the baseline` included (no result moved); `npm run
  typecheck`.
- [ ] **Step 5:** Commit red, then green.

### Task 2: Orca's terminal list, from a scenario's layout

**Files:** Create `cli/src/testing/dialAppEval/orcaListing.ts`, `orcaListing.spec.ts`. **Depends on:** 1. **Effort:** high.

**Interfaces:** Produces (Decision 3):

```ts
export interface OrcaPane { key: SessionKey; handle: string; title: string; tab: number; split: number; identity?: Engine }
export interface OrcaWorktree { key: string; path: string; panes: OrcaPane[] }
/** Orca's layout now: `layout`'s worktrees in its order, each with the panes `open` names a handle for, by tab, then split.
 *  `folder` writes a catalog path as the tier's own (tier B's world.folder); the identity is the session's engine. */
export function orcaLayout(scenario: Scenario, layout: StepOf<'orca.layout'> | undefined,
  open: (key: SessionKey) => string | undefined, folder?: (path: string) => string): OrcaWorktree[]
/** What `orca terminal list --json --include-visual-layouts` prints for it, in Orca 1.4.256's shapes as
 *  e2e/harness/fakeOrca.ts prints them: `visualLayouts` (group, tabs, `terminal` leaves, `pane-split` first then second),
 *  `terminals` rows with handle, worktreePath, worktreeId, title and agentIdentity, `totalCount`, `truncated: false`. */
export function orcaListing(worktrees: readonly OrcaWorktree[], renamed: Readonly<Record<SessionKey, string>>): object
/** A tab's title: the person's rename (a key of `renamed` among its panes), else its lowest split's title. */
export function tabTitle(panes: ReadonlyArray<Pick<OrcaPane, 'key' | 'title' | 'split'>>,
  renamed: Readonly<Record<SessionKey, string>>): string
```

- [ ] **Step 1: Failing tests** in `orcaListing.spec.ts`, each listing read back through the real `createOrcaReads`
  (`cable/hosts/orca.ts`) with a `run` that answers it: `the tabs come in the step's worktree order, then by tab, a split's
  first pane before its second`; `a tab is titled by its first pane, and a renamed one reads as renamed with the person's
  title`; `each terminal row holds its pane's handle, its worktree's path and id, and its engine as the agent's identity`;
  `the worktrees map names each handle's worktree id`; `a pane open names no handle for is not listed`; `a session whose
  hooks name no handle is listed on its key's handle`; `with no layout step the list holds nothing`; `folder writes each
  worktree path as the tier's own`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/orcaListing.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

## Tier A

### Task 3: Tier A: Orca's agents and CLI on the model, its watch, and the 60 s budget

The first tier A task that runs an Orca scenario: it measures one against the 60 s budget before any catalog entry lands.

**Files:** Create `cli/src/testing/dialAppEval/tierA/steps/orca.ts`, `tierA/steps/orca.spec.ts`; Modify
`tierA/steps/sessions.ts`, `tierA/steps/sessions.spec.ts`, `tierA/world.ts`, `tierA/driver.ts`, `tierA/steps/voice.ts`,
`tierA/steps/voice.spec.ts`, `catalog.ts` (builders only), `dialAppEval.spec.ts`. **Depends on:** 1, 2. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 1's contract; Task 2's `orcaLayout`, `orcaListing`.
- Produces:
  ```ts
  // catalog.ts
  export function orcaSession(key: SessionKey, more?: Partial<SessionDef>): SessionDef
    // app orca, id per Decision 1, handle orcaTerminalHandle(key), title titleOf(key), worktree 'w1', tab 0, split 0,
    // cwd /work/eval-<worktree>, ageMs 0; engine codex adds codexHome 'own' (the spec's default)
  export const orcaGhost: SessionDef                                   // key z, ghost
  export function orcaOpening(worktrees: string[], renamed?: Record<SessionKey, string>): Step[]  // Decision 9
  export function orcaStarted(keys: SessionKey[]): Step[]              // each start hook in order, no wait between
  // sessions.ts (beside running, startSession, shellOf, agentPid, keyOfShell)
  export function orcaHandleOf(world: TierAWorld, key: SessionKey): string | undefined   // while its pane is open
  export function keyOfOrcaHandle(world: TierAWorld, handle: string): SessionKey | undefined
  export function launchOf(world: TierAWorld, key: SessionKey): number                   // 0 until Task 4's relaunch
  // tierA/steps/orca.ts: tier A's model of Orca
  export const orcaModelSteps: { [K in 'orca.layout' | 'orca.focus' | 'orca.front' | 'orca.plugin' | 'orca.close']: StepHandler<K> }
    // orca.layout and orca.focus built here; the rest keep Task 1's throw
  export function answerOrca(world: TierAWorld): void      // the world's rules for Orca's commands
  export function watchChild(world: TierAWorld, file: string, args: string[]): OrcaChild   // `terminal watch-focus`
  ```
- `sessions.ts`: an Orca session's hints (Decision 4) and processes (Decision 5); everything else (its transcript, the
  mod's poll for Claude Code, a Codex's own home) as today by engine.
- `orca.ts`: the layout state per world (the latest `orca.layout`, panes open by `orcaHandleOf`); `answerOrca` answers
  `terminal --help` (Decision 6), `terminal list` (`orcaListing` of `orcaLayout`), `worktree activate` and `terminal
  switch` (0, then the echo of Decision 7), `terminal send` (0) and `account list` (an empty answer). `watchChild` is a
  child that prints the last focus line told, then each `orca.focus` line and each echo, until it is killed;
  `orca.focus` writes `{"handle":"<the session's handle>"}` on every running watch and nothing with none running.
- `world.ts`: `deps.orca` per Decision 6, its `spawn` `watchChild`; no `orcaReads` (the devices build the real reads on
  `deps.orca`); `ANSWERED` gains Orca's programs.
- `voice.ts` `recordTyping`: a `terminal send` is a `typed` delivery to `keyOfOrcaHandle` of its `--terminal`, none when no
  session's.
- `driver.ts`: registers `orcaModelSteps`, calls `answerOrca` beside `installFakeApps`; its header's `process.platform`
  list adds Orca's paths (`orca.ts` `orcaDeps`, `orcaHomes.ts` `orcaHomesDeps`, `orcaPlugin.ts`, the plugin's
  `inputs.platform`): each replaced by a dep or not on tier A's path (Decision 20).

- [ ] **Step 1: Failing tests.** `sessions.spec.ts` (its fake world): `an Orca agent runs on its shell's tty under Orca's
  terminal host, on no tty, named Orca Agents on macOS and orca-agents on Linux`; `a held one's maker is eval-terminal`;
  `its hook says ORCA_AGENT_SESSION_ID and its handle on every platform, and Orca's bundle id on macOS alone`; `one whose
  handle is none names no ORCA_TERMINAL_HANDLE`; `under tmux its hook adds TMUX_PANE, and its agent runs under a tmux
  server`; `keyOfOrcaHandle finds a session by its open pane's handle, and none for another`; `the other apps' hooks,
  hints and processes are as before`. `orca.spec.ts`: `terminal list answers the layout step's worktrees, each open pane
  by tab then split`; `terminal --help lists watch-focus unless the world says Orca has none`; `worktree activate, terminal
  switch and send answer 0 and are recorded`; `the CLI is found at the model's path on each platform, its accept never
  called, and exists true for HARNESS_ORCA_APP_BIN alone`; `a watch prints the last focus line told, then each orca.focus
  line`; `a switch is echoed on each running watch 100 ms later`; `orcaSession gives a Codex its own CODEX_HOME`.
  `voice.spec.ts`: `a terminal send to a session's handle is a typed delivery to it, and to none for a handle no session
  owns`; `the gate counts a send to another session's handle, and one to a handle no session owns, as wrong-session
  sends` (through `checks.ts` `wrongSends`). `dialAppEval.spec.ts` (inline `scenario()`s of Task 7's rows, asserted on `driver.seen()`): `O1 on darwin: the
  five are listed in Orca's tab order, by their names, after a terminal list`; `a tap on b in the other worktree runs
  worktree activate for its worktree, terminal switch for its handle, then the platform's raise, in that order, on darwin,
  linux and win32`; `a ring of 40 agents in 40 worktrees reads Orca's layout at most once per change in its agents, and not once in a
  minute with no change`;
  `O1 twice gives the same frames, faces, commands and deliveries at the same virtual times`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/ src/testing/dialAppEval/dialAppEval.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included; `npm run
  typecheck`.
- [ ] **Step 5: Measure.** The tier A spec's wall time at this head (its Vitest duration); the inline O1 on darwin five
  times (`-t`); the 40-agent case once. Project `spec + 57 × max(O1) + 6 × the 40-agent case` (21 Orca scenarios on three
  platforms, O3 and O16 the heavy six). Record the numbers in the commit message and the report.
- [ ] **Step 6: Budget.** Over 60 s: stop and report the numbers to the main session. The base spec's fallback keeps
  win32 and linux only for scenarios whose path has an OS branch, and every Orca scenario's front has one (decision 3), so
  which to keep is the PM's call.
- [ ] **Step 7:** Commit red, then green.

### Task 4: Tier A: the plugin's stream and front, a pane's close, Orca's quit and relaunch

**Files:** Modify `cli/src/testing/dialAppEval/tierA/steps/orca.ts`, `tierA/steps/orca.spec.ts`,
`tierA/steps/sessions.ts`, `tierA/steps/sessions.spec.ts`, `tierA/driver.ts`, `dialAppEval.spec.ts`. **Depends on:** 3.
**Effort:** high.

**Interfaces:**
- Consumes: Task 3's `orcaModelSteps`, `watchChild`, `orcaHandleOf`, `launchOf`.
- Produces: `orcaModelSteps` complete;
  ```ts
  // sessions.ts
  export function dropSession(world: TierAWorld, key: SessionKey): void   // its processes end, no hook, its pane closes
  // orca.ts
  export function closeOrca(world: TierAWorld): void            // every watch ends; the plugin's stream ends `gone`
  export function reopenOrca(world: TierAWorld): Promise<void>  // the plugin's stream opens again where it was open
  ```
  `sessionsSteps.relaunch` moves each relaunched Orca session to its next launch (`launchOf` + 1, so its hooks and pane name
  `orcaPaneHandle(s, launch)`). `driver.ts`'s `quit` of Orca runs `sessionsSteps.quit` then `closeOrca`; its `relaunch`
  runs `sessionsSteps.relaunch` then `reopenOrca`.
- `orca.plugin`: with `world.orca.plugin === false` nothing; open: `world.listener.dial.open({ type: 'dial', standby: true },
  stream)`, the fake stream's `onWritable` run once; close: its `ended` aborted `gone`. A refusal throws. `orca.front`:
  `world.listener.orcaFront.handle({ type: 'orcaFront', terminals })`, the worktree's open handles in layout order; an
  answer throws (a scenario that fronts with no stream open is the scenario's mistake). `orca.close`: `dropSession`.

- [ ] **Step 1: Failing tests.** `orca.spec.ts`: `orca.plugin opens the devices' dial stream as the plugin does, and with
  plugin false opens nothing`; `orca.front sends the worktree's open handles in layout order on orcaFront`; `a front with no
  stream open throws`; `orca.close takes the pane out of the list`; `Orca's quit ends each watch and the plugin's stream;
  its relaunch opens the stream again`. `sessions.spec.ts`: `a drop ends the agent's and its shell's processes and sends no
  hook`; `a relaunched Orca session names its next handle in its hooks and its pane`. `dialAppEval.spec.ts` (inline,
  darwin): `a focus line for b, with Orca settled in front, turns the dial to b`; `with the plugin's front on w1, only w1's
  agents are listed`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/ src/testing/dialAppEval/dialAppEval.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement; no `not built yet` step is left in `driver.ts`.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included;
  typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 5: Tier A: the app in front by its OS's own name

**Files:** Modify `cli/src/testing/dialAppEval/tierA/steps/window.ts`, `tierA/steps/window.spec.ts`. **Depends on:** 1.
**Effort:** medium.

`windowSteps.front` tells the listener `{ type: 'front', app: frontAppId(FRONT_NAMES[world.platform][step.app]) }`
(Decision 10).

- [ ] **Step 1: Failing test** in `window.spec.ts`: `the front step tells the listener what frontAppId makes of the
  platform's own front name, for each app and platform, Orca's included`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/window.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included (no other
  app moved); typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 6: Checks: Orca's `open`, `face`, Orca's names

**Files:** Modify `cli/src/testing/dialAppEval/checks.ts`, `checks.spec.ts`. **Depends on:** 1, 2. **Effort:** high.

**Interfaces:** Produces `open` for an Orca row (Decision 11), `face` (Decision 12, replacing Task 1's throw), Orca's
expected names (Decision 13, by Task 2's `tabTitle`). `partsOf` takes the tier, for Decision 11's Linux tier B rule. A
session's launch at a window is the number of `relaunch` steps of Orca before it. Evidence names keys and times only: a
command is its kind (`worktree`, `switch`, `front`, `send`, `failed`, `other`) and, for a switch, the key of the session
whose handle it names (`other` for none).

- [ ] **Step 1: Failing tests** (hand-made `Seen`), a pass, a fail and a latency case each where timed: `a tap on an Orca
  row passes on its worktree's activate, its handle's switch, then Orca's raise, on each platform` (`open -b
  com.stablyai.orca`; `raise --app orca …`; `harness-pty raise com.stablyai.orca`); `an activate of another worktree before
  the switch fails worktree, and none passes it`; `a switch of another handle fails switch, and a raise before the switch
  fails raise`; `a rest passes on its switch with no raise and fails on a raise; it has no latency part`; `after a
  relaunch the switch must name the session's next handle`; `a tap in tier B on Linux has no raise and no latency part`; `an
  Orca row the dial was never sent scores 0 on every part`; `face passes with no refusal and a face on a tile whenever
  tiles are held, from its label on`; `face fails on a refusal after its label, on tiles held with none on the face, and
  with no face seen`; `a face with no tiles and none on it passes`; `an Orca row's expected name is its tab's rename, else
  Claude Code's own title, else its tab's title`; `no evidence holds a handle or a worktree id`; `the other apps' checks
  score as before` (one case per kind from the current spec, unchanged).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/checks.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included;
  typecheck.
- [ ] **Step 5:** Commit red, then green.

## Catalog

Rows below use: `k(w t.s)` a Claude Code session `orcaSession(k, { worktree: w, tab: t, split: s })` (split 0 when no
`.s`), `codex` and `held` and `tmux` its flags (`engine: 'codex'`, `held: true`, `tmux: true`); "opening [w…]" is
`orcaOpening`; "started k…" is `orcaStarted`, "started1s k…" the catalog's `started` (a second apart); "front wN" is
`orca.front`; "listed […]" is `listed('orca', […])` (the 10 s condition wait on the Orca ring, then the person's 1 s
read). Every scenario declares `orcaGhost` (`z`) and runs on every platform in both tiers; each tier B one gets its `cost`
check from `scenario()`. Probes name `z`. Orca in front at start (the driver's), `watch-focus` supported, the plugin set up, unless
the row's world says otherwise.

### Task 7: Catalog: Orca, O1–O17

**Files:** Create `cli/src/testing/dialAppEval/orcaScenarios.ts` (`export function orcaScenarios(): Scenario[]`, a function
as `heldOut()` is), `orcaScenarios.spec.ts`; Modify `catalog.ts` (MAIN spreads it after the editors), `catalog.spec.ts`
(its enumerations: ids, own waits, the inputs rule's set gains `orca.focus`, tier-only lists). **Depends on:** 3, 4, 6.
**Effort:** high.

| Id | Sessions and steps (labels in quotes) | Checks | Probe |
|---|---|---|---|
| O1 | a(w1 0), c(w1 0.1), b codex(w1 1), d(w2 0), e codex(w2 1). Opening [w1 w2] renamed {d: `Eval Renamed`}; started e d c b a | ring D1 orca [a c b d e] | ring + z |
| O2 | a(w1 0), b(w1 1), c(w2 0, cwd `/work/eval-w1`), d(w2 1). Opening [w1 w2]; started d c b a; listed [a b c d]; "front": front w1; listed [a b]; "open": front w2; listed [c d] | ring D1 [a b] after front at open; ring D1 timed [c d] after open (`moved`); ringKept D7 [c d] | ring + z after open |
| O3 | s01–s16 in w1 tabs 0–15, t01–t16 in w2 tabs 0–15. Opening [w1 w2]; "front": front w1; started s01…s16 t01…t16; listed [s01–s16]; "open": front w2; listed [t01–t16] | face D7 after open; ring D1 [t01–t16] after open | ring [t01–t16 z] after open |
| O4 | a(w1 0), b(w1 1). Opening [w1]; started b a; listed [a b]; "focus": orca.focus b; wait 2 s; "tap": tap a; wait 3 s | focus D2 b after focus at tap; focus D2 a noBounce after tap (`echo`) | focus z after focus |
| O5 | world `orca: { watchFocus: false }`; a(w1 0), b(w1 1). Opening [w1]; started b a; listed [a b]; "prompt": hook turn-start b | focus D2 b after prompt | focus z |
| O6 | a(w1 0), b held(w1 1). Opening [w1]; started b a; listed [a b]; "prompt": hook turn-start b | focus D2 b after prompt; ring D1 [a b] | focus z |
| O7 | a(w1 0), c(w1 1), b(w2 0). Opening [w1 w2]; started b c a; listed [a c b]; "tap": tap b; wait 4 s; "rest": swipe c; wait 2 s | open D3 b after tap at rest; open D3 c after rest (`rest`) | open z after tap |
| O8 | a(w1 0), b codex(w1 1). Opening [w1]; started b a; listed [a b]; "turn": turn-start a; wait 2 s; "ask": needs-input a permission; wait 2 s; "stop": turn-stop a `Eval answer one.`; wait 6 s; "turn2": turn-start b; wait 2 s; "stop2": turn-stop b `Eval answer two.` | state D4 a working after turn, needs-you after ask, done after stop at turn2; recap D6 a after stop; state D4 b working after turn2, done after stop2; recap D6 b after stop2 | recap z after stop |
| O9 | a(w1 0). Opening [w1]; started a; listed [a]; "voice": `Eval words for alpha.` → a | voice D5 a | voice z |
| O10 | a(w1 0), b codex(w1 1). Opening [w1]; started b a; listed [a b]; swipe b; wait 1 s; "voice": `Eval words for bravo.` → b | voice D5 b | voice z |
| O11 | a(w1 0), b(w1 1), c tmux(w1 2). Opening [w1]; started c b a; listed [a b] | ring D1 orca [a b] | ring [a b z] |
| O12 | a(w1 0), b(w1 1). Opening [w1]; front w1; started b a; listed [a b]; "quit": quit orca; front other; wait 2 s; "relaunch": relaunch orca; front orca; front w1; listed [a b]; "focus": orca.focus b; wait 2 s | ringKept D7 [a b] after relaunch; ring D1 [a b] after relaunch at focus; focus D2 b after focus | ring + z after relaunch |
| O13 | world `orca: { plugin: false }`; a(w1 0), b(w2 0). Opening [w1 w2]; started b a; listed [a b]; "tap": tap b | ring D1 [a b]; ringKept D7 [a b]; open D3 b after tap | open z |
| O14 | a(w1 0), b(w2 0), c(w3 0). Opening [w1 w2]; started b a; listed [a b]; "add": orca.layout [w1 w2 w3]; hook start c; listed [a b c]; "remove": orca.close b; orca.layout [w1 w3]; listed [a c] | ring D1 timed [a b c] after add at remove (`added`); ring D1 timed [a c] after remove (`removed`); ringKept D7 [a c] | ring + z after remove |
| O15 | a(w1 0), b(w1 1), c(w1 0.1). Opening [w1]; started b a; listed [a b]; "split": hook start c; listed [a c b]; "close": orca.close b; listed [a c] | ring D1 timed [a c b] after split at close (`split`); ring D1 timed [a c] after close (`closed`); ringKept D7 [a c] | ring + z after close |
| O16 | k01–k40, each kNN(wNN 0). Opening [w01…w40]; started1s k01…k40; "ask": needs-input k05 permission; listed [k05 k26…k40] | ring D1 [k05 k26…k40] after ask; ringKept D7 the same | ring + z after ask |
| O17 | a(w1 0), b(w1 1). Opening [w1]; started b a; listed [a b]; swipe b; wait 1 s; "unplug"; wait 3 s; "replug"; listed [a b]; "tap": tap b | ringKept D7 [a b] after replug; focusKept D7 b after replug at tap; open D3 b after tap | open z |

- [ ] **Step 1: Failing tests** in `orcaScenarios.spec.ts`: `Orca's main ids are O1-O17, none held out, 17`; `every O
  scenario runs on every platform in both tiers`; `each O scenario's checks cover exactly the spec's dims` (O1 D1; O2 D1 D7;
  O3 D1 D7; O4 D2; O5 D2; O6 D2 D1; O7 D3; O8 D4 D6; O9 D5; O10 D5; O11 D1; O12 D7 D1 D2; O13 D7 D1 D3; O14 D7 D1; O15 D7
  D1; O16 D1 D7; plus D8 in tier B); `O5's world has no watch-focus and O13's no plugin`; `no two sessions of a scenario
  share a pane`; `O2's c is in w2 with w1's folder`; `O16 stays inside the bounds: 40 worktrees, 40 handles, one front of
  at most 50`. In `catalog.spec.ts`, its extended enumerations.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/orcaScenarios.spec.ts
  src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → every O scenario in tier A runs on its
  platforms with no error, no wrong send and its probe caught (the failures the spec predicts are not asserted); a wrong
  send stops the task: report it. Typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 8: Catalog: Orca's held-out set, OH1–OH4

**Files:** Modify `cli/src/testing/dialAppEval/heldOut.ts`, `catalog.spec.ts`. **Depends on:** 7. **Effort:** high.

| Id | Sessions and steps | Checks | Probe |
|---|---|---|---|
| OH1 | a codex(w1 0), b(w1 1). Opening [w1]; started b a; hook turn-start b; listed [a b]; swipe a; wait 1 s; "voice": `Eval words for alpha.` → a | voice D5 a | voice z |
| OH2 | a codex(w1 0), b codex(w1 1). Opening [w1]; started b a; listed [a b]; "focus": orca.focus b; wait 200; "voice": `Eval words for bravo.` → b | voice D5 b | voice z |
| OH3 | a(w1 0), b held(w1 1). Opening [w1]; started b a; listed [a b]; "tap": tap b | open D3 b after tap | open z |
| OH4 | a(w1 0), b(w1 1, `handle: 'none'`). Opening [w1]; started b a | ring D1 [a b] | ring + z |

- [ ] **Step 1: Failing tests** in `catalog.spec.ts`: `the held out are CH1-CH3, XH1-XH3, VH1-VH4, UH1-UH3 and OH1-OH4: 17 of
  86, Orca 4 of 21`; `OH1 and OH2 are D5 alone`; `OH4's b names no handle in its hooks`; the extended enumerations (OH2's
  200 ms wait among the own waits, OH2 in the inputs rule's quick list).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios in `heldOut()`; its header stays as it is.
- [ ] **Step 4:** As Task 7's Step 4, for OH1–OH4.
- [ ] **Step 5:** Commit red, then green.

## Tier B

### Task 9: The eval command runs the Orca tier B file

**Files:** Modify `cli/src/testing/dialAppEval/runner.ts`, `runner.spec.ts`, `run.ts`, `run.spec.ts`. **Depends on:** -.
**Effort:** medium.

`runner.ts`: `Source` and `SOURCES.b` gain `orca` before `heldOut`. `run.ts`: `FILES.b` gains `e2e/dialAppEvalOrca.e2e.ts`
before the held-out file.

- [ ] **Step 1: Failing tests:** `run.spec.ts` `--tier b runs the six e2e files, Orca's before the held-out`; `a run whose
  Orca file wrote no results writes no baseline, naming the file`; `runner.spec.ts` `Orca's results file is
  results-b-orca.json and merges with the others`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/run.spec.ts src/testing/dialAppEval/runner.spec.ts` →
  FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 10: Tier B: Orca's CLI is the fake, as `orca` and `orca-ide`, inside the root

**Files:** Modify `cli/e2e/harness/fakeOrca.ts`, `cli/e2e/harness/appEvalDriver.ts`,
`cli/src/testing/dialAppEvalTierB.spec.ts`. **Depends on:** 1. **Effort:** xhigh.

**Interfaces:** Produces
```ts
// fakeOrca.ts: install also writes the script as `orca-ide` beside the launcher in Orca's install the harness made, and
// links bin/orca-ide to it, so a Linux daemon finds the fake before any system orca-ide (devices/orcaHomes.ts orcaBinary)
// appEvalDriver.ts
/** The Orca CLI the daemon would run, resolved as orcaBinary resolves it over env's PATH and HARNESS_ORCA_APP_BIN, and each
 *  of `orca-ide` and `orca` its PATH gives first; throws `the daemon's Orca CLI is not inside its root` unless all are. */
export function orcaCliInside(env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform): string
// Rig gains orca: FakeOrca, installed in openRig before d.start() with watch-focus on, then checked by orcaCliInside
```
`orcaBinary` reads `process.env.HARNESS_ORCA_APP_BIN`: `orcaCliInside` sets it from `env` for the call and restores it.

- [ ] **Step 1: Failing tests** in `dialAppEvalTierB.spec.ts`, each in a temp root laid out as `daemon.ts` lays one out
  (`bin/orca` linked to `<own>/orca-app/resources/bin/orca`): `orcaCliInside refuses an orca-ide first on PATH outside the
  root, on linux`; `it refuses an orca outside the root first on PATH`; `on darwin with none on PATH it refuses an app path
  outside the root`; `the fake installed as orca and orca-ide resolves inside the root, through Orca's launcher folder, on
  linux and darwin`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEvalTierB.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck; `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts
  e2e/dialAppEvalClaude.e2e.ts e2e/dialOrcaFocus.e2e.ts` on this Mac → PASS (the driver's other user, and the fake's).
- [ ] **Step 5:** Commit red, then green.

### Task 11: The plugin's loop in the e2e harness

**Files:** Create `cli/e2e/harness/pluginLoop.ts`; Modify `cli/e2e/dialStream.e2e.ts`. **Depends on:** -. **Effort:**
medium. No behaviour change: one commit.

**Interfaces:** Produces `export interface PluginLoop` (the file's `Loop`: `states`, `logs`, `front(terminals)`,
`stop()`), `export function startPluginLoop(d: IsolatedDaemon, children: ChildProcess[]): PluginLoop` (the launcher shim
in the throwaway home, `pluginDial.ts` started on it) and `export function pluginLoopEnv(d: Pick<IsolatedDaemon, 'env'>):
NodeJS.ProcessEnv` (its whole environment: the home and `/usr/bin:/bin`), moved as they are from `dialStream.e2e.ts`.

- [ ] **Step 1:** Move it; `dialStream.e2e.ts` imports it.
- [ ] **Step 2:** `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts`
  on this Mac → PASS; typecheck.
- [ ] **Step 3:** Commit.

### Task 12: Tier B: Orca's agents on stand-in hosts, environments from scratch, and the safety cases

The spec's three safety rules, each asserted, before any tier B scenario runs.

**Files:** Create `cli/e2e/harness/appEvalOrca.ts`, `cli/e2e/dialAppEvalOrca.e2e.ts` (its safety cases only),
`cli/src/testing/dialAppEvalTierBOrca.spec.ts`; Modify `cli/e2e/harness/orcaHost.ts`, `cli/e2e/harness/inOrca.ts`,
`cli/e2e/harness/codexOutside.ts`. **Depends on:** 10, 11. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 10's `orcaCliInside` and `Rig.orca`; Task 11's `pluginLoopEnv`.
- Produces:
  ```ts
  // orcaHost.ts
  export function orcaTerminal(d: IsolatedDaemon, children: ChildProcess[], options?: { name?: string }): Promise<OrcaTerminal>
    // built and checked under `name` (default Orca's host's, RECORDED_ORCA), HELD_MAKER for a held pane
  // OrcaTerminal gains: readonly pid: number (its runner: every hook's caller); close(): Promise<void> (its host ends)
  // inOrca.ts: InOrca's constructor takes options { sessionId?: string; terminal?: Promise<OrcaTerminal> }, and runs every
  //   hook on that terminal when given, handle or none; hook() takes every event the daemon installs for Claude Code
  //   (SessionStart, UserPromptSubmit, Notification, Stop, SessionEnd); defaults as today
  // codexOutside.ts: CodexOutsideOptions gains terminal?: OrcaTerminal (its hooks run on it, their caller its runner)
  // appEvalOrca.ts
  /** Every Orca agent's process's environment: the daemon's (testing/daemonEnvironment.ts), Orca's names for the session
   *  and its hints (Decision 4); no value of this worker's. */
  export function orcaEnv(d: Pick<IsolatedDaemon, 'env'>, s: SessionDef, hints: Record<string, string>): NodeJS.ProcessEnv
  export class OrcaAgent {
    /** On a stand-in of its own, its hooks InOrca's (Claude Code) or CodexOutside's (Codex) on that terminal. */
    static start(d: IsolatedDaemon, children: ChildProcess[], s: SessionDef, hints: Record<string, string>): Promise<OrcaAgent>
    readonly pid: number
    hook(event: 'start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'end', fields?: { lastAnswer?: string }): Promise<void>
    /** Its stand-in ends: the agent goes with no hook. */
    close(): Promise<void>
  }
  ```

- [ ] **Step 1: Failing tests.** `dialAppEvalTierBOrca.spec.ts`: `orcaEnv holds none of this worker's ORCA_*, TMUX*,
  TERM_PROGRAM or __CFBundleIdentifier values, only the daemon's and the session's own` (process.env stubbed with made-up
  runner values); `the plugin's environment is its home and /usr/bin:/bin alone, and its harness shim is inside the root
  and starts the CLI under the daemon's environment alone`. `dialAppEvalOrca.e2e.ts` (an inline Orca scenario, before any
  catalog one runs): `a start with orca or orca-ide resolved outside the daemon's root throws before the daemon starts`;
  `an Orca agent's hooks run on its stand-in's pty under Orca's host's name, eval-terminal for a held pane, never on this
  worker's terminal` (`ps` of the agent's `pid`: its parent's name and its tty, against this worker's own tty); `a process
  run for an Orca agent has none of this worker's Orca, tmux or terminal values` (process.env stubbed before the daemon is
  made; `env` run on the agent's terminal). Then `cd cli && npx vitest run src/testing/dialAppEvalTierBOrca.spec.ts` and
  `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalOrca.e2e.ts` → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Both → PASS on this Mac; no network reached; `TMPDIR=/tmp caffeinate -i npx vitest run --config
  vitest.e2e.config.ts e2e/dialOrcaFocus.e2e.ts e2e/dialOrcaFullRing.e2e.ts e2e/dialStream.e2e.ts e2e/dialHostOrcaPane.e2e.ts
  e2e/deviceClaudeOrca.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialClaudeAppFollow.e2e.ts e2e/dialCodexApp.e2e.ts
  e2e/deviceCodex.e2e.ts` → PASS (the changed harness's other users); typecheck.
- [ ] **Step 4:** Commit red, then green.

### Task 13: Tier B: the fake Orca for the eval

**Files:** Modify `cli/e2e/harness/fakeOrca.ts`; Create `cli/src/testing/fakeOrca.spec.ts`. **Depends on:** 10. **Effort:**
high.

**Interfaces:** Produces, on `FakeOrca` (its `runs()`, `asked()`, `layout()`, `focus()`, `refuse()` and `accounts()` as
today):
```ts
/** Every run since install: the name it was run by and its arguments, its exit, and its time (each run a file of its own
 *  under log/, its first line the exit, then one argument a line; the time its mtime). */
log(): Array<{ argv: string[]; ok: boolean; at: number }>
/** What `terminal list` prints from now on, as given (orcaListing's): written whole, renamed into place. */
listing(json: object): void
/** `terminal --help` lists watch-focus, and `terminal watch-focus` runs, or not; the launcher is rewritten (Decision 15). */
watchFocus(on: boolean): void
/** Every watch-focus of this fake ends, as when Orca quits. */
endWatch(): void
```
A `terminal switch` that exits 0 appends its focus line (Decision 7).

- [ ] **Step 1: Failing tests** in `fakeOrca.spec.ts` (skipped on Windows; the fake installed in a temp root laid out as
  `daemon.ts` lays one out, run with `spawnSync`): `each run is noted with its arguments, exit and time, a text with spaces
  one argument`; `terminal list prints the listing written`; `a switch that exits 0 is echoed as a focus line, one that
  exits 1 is not`; `watchFocus(false) drops watch-focus from the help and moves the launcher's mtime`; `endWatch ends a
  running watch-focus`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/fakeOrca.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts
  e2e/dialOrcaFocus.e2e.ts e2e/dialOrcaFullRing.e2e.ts e2e/dialStream.e2e.ts e2e/deviceOrca.e2e.ts
  e2e/deviceOrcaHomes.e2e.ts e2e/dialHostOrcaPane.e2e.ts e2e/dialPaneFollow.e2e.ts` on this Mac → PASS (the fake's other
  users); typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 14: Tier B: Orca, with O3 measured first

**Files:** Modify `cli/e2e/harness/appEvalOrca.ts`, `cli/e2e/harness/appEvalDriver.ts`, `cli/e2e/dialAppEvalOrca.e2e.ts`,
`cli/src/testing/dialAppEvalTierBOrca.spec.ts`; `inOrca.ts` and `codexOutside.ts` only for a hook a scenario needs that
Task 12 left out; if O16 leaves tier B (Step 4): `orcaScenarios.ts`, `orcaScenarios.spec.ts`, `catalog.spec.ts`,
`report.ts`, `report.spec.ts`. **Depends on:** 2, 7, 8, 9, 12, 13. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 2's `orcaLayout`, `orcaListing`; Task 12's `OrcaAgent`, `orcaEnv`; Task 11's `startPluginLoop`; Task 13's
  `FakeOrca` methods; the driver's `speak`, `world.folder`, `world.children`.
- Produces: `export const orcaSteps: AppSteps`; `TierBWorld` gains `orca: FakeOrca`. `World.read()` takes the fake's new
  `log()` runs as commands at their own times, `/work/` paths written back (`workPaths`), and each `terminal send` as a
  `typed` delivery to the session whose current handle it names, none for another (`orcaDeliveries(runs, handleOf)`,
  exported for the spec). The rig's reset per scenario: the fake's listing emptied, its watches ended, its watch-focus per
  `world.orca.watchFocus`.
- `orcaSteps`: `hook` starts and drives an `OrcaAgent` (Decision 16; its hints by Decision 4, its handle
  `orcaPaneHandle(s, launch)`); `orca.layout`, a start, a close and a relaunch write `orcaListing(orcaLayout(…, world.folder))`
  to the fake; `orca.focus` the fake's `focus`; `orca.plugin` starts (`startPluginLoop`) or stops the plugin's loop, waiting
  (bounded) for the devices' `[devices] dial stream · open` line; `orca.front` the loop's `front` with the worktree's
  handles; `orca.close` the agent's `close()`; `quit` each agent's end then close, `endWatch`, the loop stopped; `relaunch`
  each agent anew on its next handle and the loop again where it ran; `voice` the driver's `speak`, the words seen by the
  mod's poll (as `appEvalClaude.ts` holds it, exported there, not copied) and by the fake's send runs.

- [ ] **Step 1: Failing tests.** `dialAppEvalTierBOrca.spec.ts`: `the fake's send runs are typed deliveries to the session
  whose handle they name, at their times, and to none for another handle`; `its runs become commands as the daemon ran
  them, a projects folder written as /work/`. `dialAppEvalOrca.e2e.ts`: `it.for` over tier B's Orca main scenarios, as
  `dialAppEvalVscode.e2e.ts` for `orca` (source `orca`), each checking the daemon's home, open and Orca CLI inside its root,
  no network reached, no wrong send and its probe caught; `ALSO`: O1 `the devices read Orca's layout and no Orca CLI ran
  outside the root`; O13 `no plugin process ran`. `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config
  vitest.e2e.config.ts e2e/dialAppEvalOrca.e2e.ts` → FAIL (no Orca steps).
- [ ] **Step 2: O3 first.** Build what O3 needs (agents, layout, plugin, front); run the file with `-t 'O3:'` on this Mac:
  record O3's time and the file's start-up.
- [ ] **Step 3:** Build the rest.
- [ ] **Step 4: Budget.** Run the whole file on this Mac: each scenario's time and the file's. Over about 6 minutes: make
  O16 tier A only (`tiers: ['a']`, its spec, `catalog.spec.ts`'s tier-only list) and add `O16 in tier B, for its time` to
  the report's Not covered line (its spec); run again. Still over: stop and report the numbers (the PM decides).
- [ ] **Step 5:** `npx vitest run src/testing/dialAppEvalTierBOrca.spec.ts src/testing/dialAppEvalTierB.spec.ts` → PASS;
  the e2e file → PASS on this Mac under about 6 minutes; no wrong send and no network reached (else stop and report);
  `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalClaude.e2e.ts` → PASS; typecheck.
- [ ] **Step 6:** Commit red, then green.

### Task 15: Tier B: Orca's held-out scenarios

**Files:** Modify `cli/e2e/dialAppEvalHeldOut.e2e.ts`, `cli/e2e/harness/appEvalOrca.ts` (only what OH1–OH4 need: a hook
with no handle on its stand-in), `cli/src/testing/dialAppEvalTierBOrca.spec.ts`. **Depends on:** 8, 14. **Effort:** high.

- [ ] **Step 1: Failing test:** the held-out file's `TierBDriver` has no Orca steps, so its `it.for` over `HELD_OUT` fails
  on OH1: `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalHeldOut.e2e.ts` →
  FAIL. `dialAppEvalTierBOrca.spec.ts`: `a session whose hooks name no handle runs its hooks on its stand-in with no
  ORCA_TERMINAL_HANDLE`.
- [ ] **Step 2:** Give the driver `orcaSteps`; its path check adds the Orca CLI; build what OH4 needs.
- [ ] **Step 3:** Same → PASS on this Mac, under about 6 minutes; no wrong send and no network reached (else stop and
  report).
- [ ] **Step 4:** Commit red, then green.

## CI

### Task 16: `ci-plan.py`: linux-e2e runs the Orca file

**Files:** Modify `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`. **Depends
on:** -. **Effort:** high.

`LINUX_E2E_APP_EVAL_FILES` gains `cli/e2e/dialAppEvalOrca.e2e.ts` before the held-out file. `LINUX_E2E_APP_EVAL_PATHS`
gains `cli/e2e/harness/fakeOrca.ts`, `inOrca.ts`, `orcaHost.ts`, `pluginDial.ts`, `pluginLoop.ts` (Decision 19) and
`plugins/harness-device-orca/`.

- [ ] **Step 1: Failing tests:** `APP_EVAL_FILES` holds the six; `test_a_change_the_app_eval_covers_runs_its_e2e_files`
  gains each new path (a change and a deletion run the six files; a harness one with the canary; a head without
  `dialAppEvalOrca.e2e.ts` fails naming it); `test_the_app_eval_e2e_files_are_plain_and_run_on_linux` covers it; update
  the cases that list the eval's files: `test_a_change_to_the_orca_stand_in_or_adapter_runs_the_orca_e2e_files` (a change
  to `orcaHost.ts`, `inOrca.ts` or `fakeOrca.ts` now runs the Orca files, the six eval files and the canary) and the
  dial-host case (those three are `DIAL_HOST_PATHS` entries now also app eval paths).
- [ ] **Step 2:** `python3 scripts/tests/test_ci_plan.py` → FAIL.
- [ ] **Step 3:** Implement. `docs/validation-and-release.md`, the linux-e2e row: the eval's files are six
  (`dialAppEvalOrca` among them), and what they cover names the Orca paths.
- [ ] **Step 4:** Same → PASS; `CROSS_READ_SCAN_REQUIRED=1 python3 -c 'import sys; sys.path.insert(0, "scripts/tests");
  import unittest, test_ci_plan; unittest.main(module="test_ci_plan", argv=["x", *test_ci_plan.FullCheckoutTests.NAMES])'`
  → PASS.
- [ ] **Step 5:** Commit red, then green.

## Baseline

### Task 17: The baseline

**Files:** Modify `cli/src/testing/dialAppEval/baseline.json`, `cli/ci-e2e-durations.json`, `catalog.spec.ts` (the
kind-coverage case over every kind). **Depends on:** 5, 8, 9, 14, 15. **Effort:** xhigh.

- [ ] **Step 1: Failing tests (existing):** the tier A spec's `matches the baseline` (stale: Orca's checks are new) and the
  Orca file's `matches this platform's baseline` → FAIL. Restore the kind-coverage case over every step kind but `wait`;
  `grep -rn "not built yet" cli/src/testing/dialAppEval cli/e2e/harness` prints nothing.
- [ ] **Step 2: The baseline run** on this Mac at this head, only after every scenario has landed: `cd cli && git show
  main:cli/src/testing/dialAppEval/baseline.json > /tmp/dial-eval-main-baseline.json && TMPDIR=/tmp
  DIAL_EVAL_OUT=/tmp/dial-eval-baseline caffeinate -i npm run eval:dial-apps -- --update-baseline`. It writes tier A
  (darwin, win32, linux) and tier B darwin; no Linux tier B entry. **A wrong-session send, or a test failing on the network
  guard: stop and report (the PM decides before anything merges).** Keep `/tmp/dial-eval-baseline/report.md` for the PR.
- [ ] **Step 3: The other apps' held checks equal `main`'s.** Held: each key of a C, X, V, U, CH, XH, VH or UH scenario in
  subset `a` (any `timed`) or `b/darwin` with `timed: false`, from either side; `main`'s `b/darwin` keys whose result is
  timed are not held. Also held: `apps.a` of the four other apps in the written `baseline.json`. From `cli`:

  ```bash
  node --input-type=module -e '
  import { readFileSync, readdirSync } from "node:fs"
  const out = "/tmp/dial-eval-baseline"
  const main = JSON.parse(readFileSync("/tmp/dial-eval-main-baseline.json", "utf8"))
  const written = JSON.parse(readFileSync("src/testing/dialAppEval/baseline.json", "utf8"))
  const other = (key) => /^(a\/\w+|b\/darwin)\/(C|X|V|U|CH|XH|VH|UH)\d+\//.test(key)
  const now = new Map(), timed = new Set()
  for (const f of readdirSync(out).filter((n) => /^results-[ab]-\w+\.json$/.test(n)))
    for (const r of JSON.parse(readFileSync(`${out}/${f}`, "utf8")).results) {
      const key = `${r.tier}/${r.platform}/${r.scenario}/${r.check}`
      if (!other(key)) continue
      if (r.tier === "b" && r.timed) timed.add(key); else now.set(key, r.score)
    }
  const keys = new Set([...Object.keys(main.checks).filter((k) => other(k) && !timed.has(k)), ...now.keys()])
  const differ = [...keys].sort().filter((k) => main.checks[k] !== now.get(k))
  for (const app of ["claude", "chatgpt", "vscode", "cursor"])
    if (main.apps.a[app] !== written.apps.a[app]) differ.push(`apps.a.${app}`)
  console.log(`other apps: ${keys.size} held checks equal main: ${differ.length === 0}; ${timed.size} timed tier B entries re-measured`)
  for (const k of differ) console.log(`differs: ${k}`)
  process.exit(differ.length > 0 ? 1 : 0)'
  ```

  Expected: exit 0, `held checks equal main: true`. A key that differs is a shared change moving another app (Review
  Focus 1), a bug on this branch: do not commit the baseline; report the keys and return the task for a fix in the task
  that owns the change.
- [ ] **Step 3b: The delta for the PR body.** From `/tmp/dial-eval-baseline/report.md`, the Delta section goes into the PR
  body under "Baseline delta", with Step 3's summary line. For the other apps a change there is a timed `b/darwin` check or
  a `b/darwin` app score; anything else means Step 3 missed one: stop and report.
- [ ] **Step 4: Times.** The tier A spec under 60 s (else stop and report, as Task 3's Step 6); the Orca file's time into
  `cli/ci-e2e-durations.json` (`durationMs`), and the held-out file's anew, each under about 6 minutes.
- [ ] **Step 5:** `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts
  src/testing/dialAppEvalTierBEditor.spec.ts src/testing/dialAppEvalTierBOrca.spec.ts src/testing/fakeOrca.spec.ts` → PASS;
  the six eval e2e files → PASS on this Mac under `caffeinate -i`; `npm run typecheck`.
- [ ] **Step 6:** Commit once (the failing ratchet is the existing test).

---

## Verification

Isolation follows the repo's own e2e harness (`cli/AGENTS.md`, `cli/e2e/harness/daemon.ts`): each `IsolatedDaemon` has a
throwaway root, home, data folder and socket, a private tmux server, the in-memory fake backend with a made-up machine and
token, the recording `open` (`HARNESS_OPEN_BIN`), the fake `orca` as `orca` and `orca-ide` first on its PATH and as
`HARNESS_ORCA_APP_BIN`, checked inside its root before it starts (Task 10), an environment built from scratch
(`testing/daemonEnvironment.ts`), and the network guard in every process. Every Orca agent's hooks run on a stand-in host's
pty; the plugin's loop runs on the throwaway home with `/usr/bin:/bin`. This Mac runs the work inside a real Orca: no check
starts it, its `orca`, its plugin, or reads its terminals, worktrees or state; nor the everyday daemon (18473),
`~/.claude` or `~/.codex`. No check needs a person's login or production: every account is the fake backend's.

1. **Tier A on macOS** (this Mac, final head): `cd cli && npx vitest run src/testing/dialAppEval/`. Seen: all pass, the
   tier A spec under 60 s, `matches the baseline` green, no scenario erroring.
2. **Tier A on Linux:** PR CI's `cli-tests` runs the same spec against the macOS-written baseline. Seen: green; a
   difference is a determinism bug, not a baseline to refresh.
3. **Tier B on macOS, by the tester, on this Mac:** `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config
   vitest.e2e.config.ts e2e/dialAppEvalOrca.e2e.ts e2e/dialAppEvalHeldOut.e2e.ts`. Seen: both pass, each scenario's time
   printed, each file under about 6 minutes; the three safety cases pass first; no wrong send, no network reached. No repo
   workflow runs macOS e2e files.
4. **The whole eval on macOS, by the tester, on this Mac:** `cd cli && TMPDIR=/tmp caffeinate -i npm run eval:dial-apps`.
   Seen: exit 0; the report (terminal and `report.md`) has the score table with five rows (`Orca` last) and each app's
   left-out count, the Not covered line (Windows tier B; Orca's tap raise in tier B on Linux), the held-out table, `Gate:
   passed`, the ranked groups; the other apps' tier A checks and tier B pass/fail checks as on `main`.
5. **Tier B on Linux:** PR CI's `linux-e2e` runs the six eval files (the eval's paths changed), the Orca files
   (`orcaHost.ts`, `inOrca.ts`, `fakeOrca.ts` changed), `dialStream.e2e.ts` (modified) and the canary (harness changed), on
   ubuntu-24.04. Seen: `linux-e2e-summary` green, none of the six all skipped. Linux is gate-only. If PR CI did not select
   them, run once by hand: **Actions → CI → Run workflow**, `scope=linux-e2e`, `e2e_files="cli/e2e/dialAppEvalOrca.e2e.ts
   cli/e2e/dialAppEvalHeldOut.e2e.ts"`. No other extra run.
6. **dial-hosts:** PR CI runs it, as `fakeOrca.ts`, `inOrca.ts` and `orcaHost.ts` are `DIAL_HOST_PATHS` entries. Seen:
   green, none skipped.
7. **The changed harness's other users on macOS**, by the tester on this Mac: `cd cli && TMPDIR=/tmp caffeinate -i npx
   vitest run --config vitest.e2e.config.ts e2e/dialOrcaFocus.e2e.ts e2e/dialOrcaFullRing.e2e.ts e2e/dialStream.e2e.ts
   e2e/dialHostOrcaPane.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceOrca.e2e.ts e2e/deviceOrcaHomes.e2e.ts
   e2e/dialPaneFollow.e2e.ts e2e/dialClaudeAppFollow.e2e.ts e2e/dialCodexApp.e2e.ts e2e/deviceCodex.e2e.ts
   e2e/dialAppEvalClaude.e2e.ts`. Seen: all pass.
8. **Local gates** PR CI does not run, at the final head from a clean tree: `cd cli && npm run typecheck`; the touched
   specs (check 1, `src/testing/dialAppEvalTierB.spec.ts`, `dialAppEvalTierBEditor.spec.ts`, `dialAppEvalTierBOrca.spec.ts`,
   `fakeOrca.spec.ts`); `python3 scripts/tests/test_ci_plan.py`, then the `CROSS_READ_SCAN_REQUIRED=1` full-checkout run
   (Task 16's Step 4); then `python3 scripts/local-checks.py --run`, its fence pasted into the PR body. `npm run test:core`
   does not apply: nothing under `src/core/` or `src/services/` changes (a task that needed a `devices.ts` seam stopped and
   asked).
9. **PR evidence:** the baseline run's report (Orca's score per dimension beside the other four apps, the held-out scores,
   the wrong-session count, the ranked groups), its Delta under "Baseline delta" with Task 17 Step 3's summary line, Task 3's
   budget numbers and the final tier A time, Task 14's O3 time and the file's, the red-then-green commits; platforms: macOS in
   both tiers, Linux in tier A and tier B (gate-only), Windows in tier A by injection.
10. **Gaps named in the PR:** Windows tier B; Linux tier B baseline entries (gate-only); the raise of an Orca tap in tier B
    on Linux; O16 in tier B if Task 14 moved it; the plugin's own install and approval flow (its own specs). Proposals, not
    in this PR: the harness's refusing stub (`daemon.ts`) gains `orca-ide` beside `orca`, so every Linux e2e daemon on a
    machine with Orca's .deb is safe, not only the eval's; a macOS run of the eval's e2e files on pull requests that change
    their paths, since tier B's ratchet is held on macOS alone and no PR CI suite runs macOS; the six files on
    `windows-e2e`.
11. **After merge** (main session, with the PM): run both tiers on `main` (`TMPDIR=/tmp caffeinate -i npm run
    eval:dial-apps` on this Mac) and report Orca's score per dimension, the held-out score, the wrong-session count, the
    failing groups ranked by points lost with a one-line cause each, and the coverage gaps beside the score.

## Answered by the PM (2026-11-22)

1. **`process.platform` reads as coverage gaps:** a gap only where such a read decides a check (Decision 20).
2. **Orca's `terminal list` for a pane running tmux (O11):** `agentIdentity: claude`.
3. **The refusing `orca-ide` stub in `e2e/harness/daemon.ts`** for every Linux e2e daemon: its own item
   (`fix/e2e-stub-orca-ide`), not this branch.
