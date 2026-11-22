# Dial eval for VS Code and Cursor Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** One 0–100 score each for VS Code and Cursor, from 36 more scenarios of the dial eval's catalog (29 main, 7 held
out), graded in tiers A and B beside the Claude app and the ChatGPT app, with the same gate and a ratcheting baseline.

**Architecture:** The eval of #4537 (`cli/src/testing/dialAppEval/`, `cli/e2e/harness/appEval*.ts`) gains two apps. Tier A
models each editor as processes on its machine model, its windows as the devices' own `vscode` stream handler opened
with a fake stream, and its agents' hooks per engine and platform. Tier B runs the real extension loop
(`vscodeWindow.ts`) over fake windows, fake editors and fake agents on the real daemon. Two check kinds (`scroll`,
`logged`) and an `open` graded by the editor row's kind; the grader, report and baseline carry four apps.

**Tech Stack:** TypeScript (Node 24), Vitest (unit suite and `vitest.e2e.config.ts`), the e2e harness (`IsolatedDaemon`,
`Desk`, `FakeDial`, `Outside`, `CodexOutside`, `InOwnTmux`, the fake backend), Python 3 for `scripts/ci-plan.py`.

**Spec:** `docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md`, which extends the **base spec**
`docs/plans/2026-11-21-dial-app-eval-design.md`. Read both; the new spec's Decisions are final. The base plan
(`docs/plans/2026-11-21-dial-app-eval-plan.md`) explains the code this plan builds on.

## Global Constraints

- Kept from the base: weights D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5; the latency thresholds (inclusive,
  1 / 0.5 / 0); points lost `100 · (w_d / Σw) · (1 − score_c) / n_d`; target ≥ 95 reported, never failing CI.
- Gate: a voice prompt delivered to a session other than the step's target fails the whole run. A wrong-session send in
  any tier A run of a task, or in the baseline run, stops the task: report it (the PM decides before anything merges).
- PM 2026-11-22: (1) voice to Cursor's own agent, to a Codex whose `CODEX_HOME` is its own, to cursor-agent, Cursor's
  agent's recap and terminal-focus follow are graded "must work" and fail at baseline; (2) no scenario focuses a panel
  or Cursor's agent without a prompt; (3) `scroll` (D3) and `logged` (D7, the exact prefix `[device] scroll · skipped · `
  and a reason).
- **No product code changes.** Every stand-in is a `vi.mock` or an existing `DevicesDeps` seam. A task that finds it
  needs a new seam stops and returns the question; nothing under `cli/src/core/` or `cli/src/services/` changes.
- Never run the real VS Code, Cursor, an editor CLI, an extension store, `/usr/bin/open` or `xdg-open`; never read or
  write `~/.vscode`, `~/.cursor`, their extensions, `~/.claude` or `~/.codex`. The network guard stays on in every eval
  test.
- The Claude app's and the ChatGPT app's entries are measured again (PM, 2026-11-22): every tier A check and every tier
  B pass/fail check of theirs equals `main`'s; their tier B latency and cost entries, and the app scores those move, are
  written as measured, and the PR shows their delta. `updateBaseline` gains no rule for it.
- Held out: VH1–VH4 and UH1–UH3 (7 of 36: VS Code 4 of 19, Cursor 3 of 17) in `heldOut.ts` and
  `dialAppEvalHeldOut.e2e.ts`; scored apart.
- Tier A deterministic, the whole tier under 60 s, no D8. Tier B each file under about 6 minutes on a CI runner. Tier B's
  baseline holds macOS; Linux is gate-only; Windows tier B is a gap.
- Fixtures are made up: titles start with `Eval `, folders with `/work/eval-`. No result holds a path, pid or folder name.
- No fixed sleeps in tier A; tier B waits are bounded `until` polls; a scenario's own `wait` is scenario timing.
- Copy follows the Naming System: "the dial", "VS Code", "Cursor", "Claude Code", "Codex".

## Review Focus

1. **The base apps' results moving under shared changes** (the `learnApps` walk, the hints by engine, Cursor's CLI now
   found, the devices' log recorded). Tasks 2 and 5 run the tier A spec against the committed baseline before any editor
   scenario joins the catalog: `matches the baseline` stays green.
2. **A shell two windows list** (a terminal moved, a reload's old stream): the window holding it is the one whose state
   listed it last among streams not ended. Task 6's spec.
3. **Scroll lines the extension dropped**, or lines that went to another terminal, never pass `scroll`. Task 6's spec.
4. **Words on an editor stream naming a shell no session owns** are a `typed` delivery to none, a wrong send. Task 3's
   spec.
5. **A pid or path reaching a result:** stream lines carry session keys, never pids (Task 3's spec), and `logged`'s
   evidence has its paths and digit runs replaced (Task 6's spec).

## Decisions this plan makes (from the spec's room)

1. **Stream records** (`Seen.streams`): `window` is the stream's id, `eval-<window key>-<n>` (`n` counts that window's
   opens in the scenario: a reload's new stream is `-2`). Lines:
   - window → devices: `{ type: 'vscode', window }` at open; `{ type: 'vscode-state', terminals: SessionKey[], active:
     SessionKey | null, focused: boolean }` at each state;
   - devices → window: the line as written, each shell pid (`show`, `pid`) replaced by the key of the session whose
     shell it is, `'other'` for none;
   - the end: `{ ended: <StreamEnd> }`.
   Tier B records what the loop printed in the same shapes: a show (a raise printed right after it folded in as
   `raise: true`), each scrolled line as `{ scroll: 'up' | 'down', pid: <the active key> }`, each taken state.
2. **Hints** (what the hook sends, `hook/notify.mjs` `hostHints`). Editor terminal row: macOS `TERM_PROGRAM=vscode` and
   the editor's bundle id (Terminal's under `launchedFrom`); Windows `TERM_PROGRAM=vscode` and the editor's bundle id
   (confirmed, orchestrator 2026-11-22); Linux `TERM_PROGRAM=vscode`. Panel: the same bundle id rule, no `TERM_PROGRAM`, plus
   `CLAUDE_CODE_ENTRYPOINT=claude-vscode`. Cursor's own agent: the bundle id on macOS and Windows, nothing on Linux. The
   base apps' hints are unchanged.
3. **Names.** Claude Code's hook carries its session's title (`session_title`, as the fake engine's
   `FAKE_CLAUDE_SESSION_TITLE`); Codex's and Cursor's carry none, so their rows' expected name is their folder's
   (`eval-<key>`), for Codex, cursor-agent and Cursor's agent alike (confirmed, orchestrator 2026-11-22; the spec's
   Catalog additions → Names).
4. **Processes.** Every process tier A starts takes the next pid from 41 000: Terminal.app's (under `launchedFrom`), each
   editor's (one per launch), each terminal's shell (parent: the editor), each agent (parent: its shell; the panel's and
   Cursor's agent's: the editor). An editor process has its app id on macOS and Linux (Windows walks none, as the base's
   `walkedApp`); `learnApps` answers the nearest process of the chain, the caller first, that has one.
5. **`editor.window`'s app** is its sessions' app; its `terminals` default to the live terminal sessions whose `window`
   is it.
6. **`open` by the editor row's kind:** panel: `link`, `front`, `latency` (as the base); Cursor's agent: `folder`,
   `latency`; terminal, with a stream holding its shell as the window opens: `show` (that stream got `{ show: key, raise:
   true }` and no other stream any show), `front`, `latency` (the later of the two); terminal with none: VS Code `front`,
   `latency` (V13), Cursor `folder`, `latency` (U12, its last-resort adapter). `folder`: macOS `open -b
   com.todesktop.230313mzl4w4u92 <folder>`, Linux Cursor's CLI on `<folder>`, Windows `harness-pty cursor-folder
   <folder>`, the folder being `folders[0] ?? cwd`.
7. **`scroll`** is one untimed part, `ran`: a scroll line for the session's shell on the stream holding it while the
   window's last state had it active, and none ran for another shell in the window.
8. **`logged`** passes on a log line holding `[device] scroll · skipped · ` and a reason. Its evidence: the matched lines
   (or, with none, the `[device] scroll` lines seen) from the tag on, each absolute path `<path>`, each run of 2+ digits
   `<n>`.
9. **A stroke** is `scroll` frames: `down`, three `move`s of `dy` 8, `up` (three lines toward older ones, as
   `dialVscode.e2e.ts` strokes).
10. **The fake editors on a panel link** record it and send nothing: nothing reaches Harness when a panel shows a
    session (decision 2).
11. **`SessionDef.tmux`** marks V12's Claude Code as run in the person's tmux, whose client runs in its terminal.
12. **Tier B folders:** a catalog folder `/work/<name>` is `<d.projectsDir>/<name>` (made), and tier B records commands
    with that prefix written back as `/work/`, so one evaluator grades both tiers.
13. **Tier B on Linux:** an `open` check on an editor terminal row is a gap ("an editor terminal's tap brings its editor
    by Linux's raise, which tier B does not record"), as `tierBGaps` already leaves out a failed link's raise.
14. **Tier B's Cursor CLI** on Linux is a recording fake at `HARNESS_CURSOR_BIN`, its runs commands `cursor <args>`.
15. **Order of live sessions:** the catalog's `started(keys)` starts them a second apart in the order given, so the
    last is newest; a ring's expected order is that list reversed.
16. **Report:** under the score table, `Not covered: tier B on Windows`.
17. **Scaffolding:** Task 1 adds the new step and check kinds with handlers that throw `… is not built yet`, and narrows
    `catalog.spec.ts`'s kind-coverage case to kinds some scenario uses. Tasks 3, 4 and 6 replace the handlers; Task 17
    restores the case over every kind and checks none of the throws is left.
18. `editorWindow.ts` (Task 12) joins `LINUX_E2E_APP_EVAL_PATHS` beside the spec's list: it is what the files' windows run
    on.
19. **The base apps on the baseline run** (option (b), orchestrator 2026-11-22; the spec's Grader, report, baseline →
    Baseline). `--update-baseline` re-measures every subset it drives, the base apps' included. Task 17 compares the
    run's results with `main`'s `baseline.json` and holds the base apps' tier A checks and tier B pass/fail checks (a
    result with `timed: false`) to equal; their timed entries and app scores are written as measured, and the report's
    Delta section goes in the PR body.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Four apps in the contract, the grader and the report | high | - |
| 2 | Tier A: the editors' agents on the machine model, and their hooks | high | 1 |
| 3 | Tier A: a window's stream, V5 on it, and the 60 s budget | xhigh | 2 |
| 4 | Tier A: focus, terminal and window close, reload, the stroke, the editors' quit and relaunch | high | 3 |
| 5 | Tier A: Cursor's folder rows | high | 2 |
| 6 | Checks: `open` by the editor row's kind, `scroll`, `logged` | high | 1 |
| 7 | Catalog: VS Code, V1–V15 | high | 4, 6 |
| 8 | Catalog: Cursor, U1–U14 | high | 4, 5, 6 |
| 9 | Catalog: the editors' held-out set | high | 4, 5, 6 |
| 10 | The eval command runs the editors' tier B files | medium | - |
| 11 | Tier B driver: the editors' CLIs inside the root, streams and log lines seen, Cursor's CLI, the stroke | high | 1 |
| 12 | The extension's window in the e2e harness | medium | - |
| 13 | Tier B: VS Code | xhigh | 7, 10, 11, 12 |
| 14 | Tier B: Cursor | high | 8, 13 |
| 15 | Tier B: the editors' held-out scenarios | high | 9, 14 |
| 16 | `ci-plan.py`: linux-e2e runs the editors' files | high | - |
| 17 | The baseline | xhigh | 7, 8, 9, 10, 13, 14, 15 |

Files more than one task touches (devcrew runs those tasks one at a time): `catalog.ts` (2, 7, 8), `catalog.spec.ts` (1,
7, 8, 9, 17), `tierA/world.ts` (1, 2, 3, 5), `tierA/driver.ts` (1, 3, 4), `tierA/machine.ts` (2, 5),
`tierA/steps/editor.ts` and `editor.spec.ts` (3, 4), `dialAppEval.spec.ts` (2, 3, 4, 5), `checks.ts` (1, 6),
`e2e/harness/appEvalDriver.ts` (1, 11), `appEvalEditor.ts` and `dialAppEvalTierBEditor.spec.ts` (13, 14, 15),
`editorWindow.ts` (12, 13), `heldOut.ts` (9). No task edits another app's catalog file: one that finds an entry wrong
reports it.

Longest chain: 1 → 2 → 3 → 4 → 7 → 13 → 14 → 15 → 17 (nine tasks).

---

## Foundations

### Task 1: Four apps in the contract, the grader and the report

**Files:** Modify `cli/src/testing/dialAppEval/types.ts`, `types.spec.ts`, `grade.ts`, `grade.spec.ts`, `report.ts`,
`report.spec.ts`, `checks.ts` (its `SCHEMES` and the two stubs), `catalog.spec.ts` (`stepKeys`, `checkKeys`, `sees`, the
kind-coverage case), `tierA/world.ts` (its `APPS` and the xdg-mime rule), `tierA/driver.ts` (the six stubs),
`cli/e2e/harness/appEvalDriver.ts` (its `SCHEME` and `FRONT`). **Depends on:** -. **Effort:** high.

**Interfaces:** Produces (beside what `types.ts` has):

```ts
export type App = 'claude' | 'chatgpt' | 'vscode' | 'cursor'
export type Editor = Extract<App, 'vscode' | 'cursor'>
export const APPS: readonly App[]                 // the four, in this order; grade.ts and report.ts read it
export const EDITORS: readonly Editor[]
// PAGE gains vscode: 'vscode', cursor: 'cursor' (the wire's app ids)
export type Engine = 'claude' | 'codex' | 'cursor'
export type Place = 'terminal' | 'panel' | 'agent'
// SessionDef gains, each doc-commented from the spec's Catalog additions:
//   place?: Place; engine?: Engine; window?: string; codexHome?: 'own'; folders?: string[]; tmux?: true
// Scenario['world'] gains: launchedFrom?: 'terminal-app'; extension?: false
// STEP_KINDS gains, with these Step members:
//   | { kind: 'editor.window'; window: string; active: SessionKey | null; focused: boolean; terminals?: SessionKey[] }
//   | { kind: 'editor.focus'; session: SessionKey }
//   | { kind: 'editor.closeTerminal'; session: SessionKey }
//   | { kind: 'editor.reload'; window: string }
//   | { kind: 'editor.close'; window: string }
//   | { kind: 'stroke' }
// CHECK_KINDS gains: | { kind: 'scroll'; session: SessionKey } | { kind: 'logged' }
// Seen gains: streams?: Array<{ at: number; window: string; line: Record<string, unknown> }>
//             logs?: Array<{ at: number; line: string }>             // absent: the driver saw none
export const SKIPPED_SCROLL = '[device] scroll · skipped · '
/** engine ?? (chatgpt: codex; a Cursor `agent`: cursor; else claude). */
export function engineOf(s: Pick<SessionDef, 'app' | 'engine' | 'place'>): Engine
/** An editor session's place, `terminal` by default; undefined for the base apps. */
export function placeOf(s: Pick<SessionDef, 'app' | 'place'>): Place | undefined
export function agentIdOf(s: Pick<SessionDef, 'app' | 'id' | 'engine' | 'place'>): string   // observedAgentId(engineOf(s), id)
```

- `grade.ts` and `report.ts` take `APPS` from `types.ts`; `subsetScores` builds its record from it. `report.ts` names
  them `the Claude app`, `the ChatGPT app`, `VS Code`, `Cursor`, and prints Decision 16's line under the score table in
  both `summary` and `markdown`.
- `checks.ts` `SCHEMES` gains `vscode://` and `cursor://`; `partsOf` gives `scroll` and `logged` a case that throws
  `the <kind> check is not built yet`.
- `tierA/world.ts` `APPS` gains VS Code (`com.microsoft.VSCode.UrlHandler.desktop`) and Cursor
  (`cursor-url-handler.desktop`), from `src/testing/recordedLinuxApps.ts`; the xdg-mime rule gates only the ChatGPT
  app's scheme on its being installed.
- `tierA/driver.ts` `STEPS` gets a handler per new step kind that throws `tier A: the <kind> step is not built yet`.
- `appEvalDriver.ts` `SCHEME` gains `vscode`, `cursor`; `FRONT` gains darwin `com.microsoft.VSCode`,
  `com.todesktop.230313mzl4w4u92`, linux `code`, `cursor`.
- `catalog.spec.ts`: `stepKeys` names `editor.window`'s `terminals` and `active`, and the `session` of `editor.focus` and
  `editor.closeTerminal`; `checkKeys` names `scroll`'s session; `sees` gains `editor.window: ['ring', 'open', 'scroll']`,
  `editor.focus: ['focus']`, `editor.closeTerminal: ['ring']`, `editor.reload: ['ring', 'open']`, `editor.close:
  ['open', 'scroll']`, `stroke: ['scroll']`; the kind-coverage case iterates only kinds some scenario uses (Decision 17).

- [ ] **Step 1: Failing tests.** `types.spec.ts`: `agentIdOf follows the session's engine` (a Cursor `agent` →
  `observedAgentId('cursor', id)`, an editor Codex terminal (`engine: 'codex'`) → `'codex'`, an editor panel →
  `'claude'`, the base apps as before); `PAGE names the editors' pages by the wire's app ids`; `APPS is the four apps`.
  `grade.spec.ts`: `each of the four apps is scored from its own results` (a VS Code D1 result and a Cursor D5 result
  give `apps.vscode` and `apps.cursor` their scores, the base apps untouched); `each subset's app scores, in the delta
  and an updated baseline, hold the four apps`. `report.spec.ts`: `the score and held-out tables have a row for VS Code
  and one for Cursor`; `Not covered: tier B on Windows is printed under the score table`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/types.spec.ts src/testing/dialAppEval/grade.spec.ts
  src/testing/dialAppEval/report.spec.ts` → FAIL.
- [ ] **Step 3:** Implement the list above.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts` →
  PASS, `matches the baseline` included (no result moved); `npm run typecheck`.
- [ ] **Step 5:** Commit red, then green.

## Tier A

### Task 2: Tier A: the editors' agents on the machine model, and their hooks

**Files:** Modify `cli/src/testing/dialAppEval/tierA/machine.ts`, `tierA/steps/sessions.ts`, `tierA/steps/sessions.spec.ts`,
`tierA/world.ts`, `tierA/fakeApps.ts`, `catalog.ts` (builders only), `dialAppEval.spec.ts` (the `learnApps` mock).
**Depends on:** 1. **Effort:** high.

**Interfaces:**
- Consumes: Task 1's `engineOf`, `placeOf`, `SessionDef` fields.
- Produces:
  ```ts
  // machine.ts
  MachineModel.appOf(pid: number): string | undefined       // Decision 4's walk
  // sessions.ts (beside running, startSession, sessionsSteps)
  export function shellOf(world: TierAWorld, key: SessionKey): number | undefined   // a live terminal session's shell
  export function agentPid(world: TierAWorld, key: SessionKey): number | undefined
  export function keyOfShell(world: TierAWorld, pid: number): SessionKey | undefined
  // world.ts: TierAWorld.folders gains cursorProjects (env.CURSOR_HOME/projects, emptied per scenario) and
  //           codexHomes (a folder of the world's root, for `codexHome: 'own'`)
  // catalog.ts
  export function editorSession(key: SessionKey, app: Editor, more?: Partial<SessionDef>): SessionDef
    // id uuid(key, 'b'), titleOf(key), cwd /work/eval-<key>, ageMs 0 (no store), place terminal, window w1
  export const editorGhost: (app: Editor) => SessionDef      // key z, ghost
  export function started(keys: SessionKey[]): Step[]          // hook start for each, a 1 s wait between (Decision 15)
  ```
- `sessions.ts` decides by `engineOf` and `placeOf`, never by the app: the hook's `engine`, Decision 2's hints, the title
  (Decision 3: Claude Code alone), the mod's poll for every Claude Code session (panel included), the process chain of
  Decision 4 (`quit` of an editor also ends its process; a session's start makes one when none runs; on macOS each
  editor's and Terminal's bundle path is in `machine.bundleIds` with its id, as the ChatGPT app's is), each engine's
  transcript and its prompt and answer lines: Claude Code and a daemon-home Codex as today; a `codexHome: 'own'` Codex in
  its own home under `folders.codexHomes`, its rollout as Codex writes it; Cursor's engine at
  `folders.cursorProjects/<slug>/agent-transcripts/<id>.jsonl`, its lines as `engines/cursor/normalizer.ts` reads them.
- The `learnApps` mock answers `machine.appOf(pid)` for each pid. `fakeApps.ts`'s `linkOf` names no link for an editor
  session (Decision 10).

- [ ] **Step 1: Failing tests** in `sessions.spec.ts` (its fake world): `a terminal Claude Code in VS Code runs under a
  shell under the editor, and its hook says TERM_PROGRAM=vscode with VS Code's bundle id on macOS and Windows, and
  TERM_PROGRAM alone on Linux`; `a panel session runs under the editor and says claude-vscode, with no TERM_PROGRAM`;
  `launched from Terminal.app: its hook says Terminal's bundle id with TERM_PROGRAM=vscode, and the editor's parent is
  Terminal's process`; `Cursor's own agent: engine cursor, no TERM_PROGRAM, its transcript under CURSOR_HOME's projects,
  its answer where the Cursor normalizer reads it`; `cursor-agent in a terminal says TERM_PROGRAM=vscode`; `a Codex with
  its own home writes its rollout under it, neither Harness's CODEX_HOME nor the ChatGPT app's`; `only Claude Code's hook
  carries the title`; `the mod polls for every Claude Code session, the panel's included`; `the machine answers each pid
  with the nearest app of its chain, an editor's agent with the editor, and Windows with none`; `the Claude app's and the
  ChatGPT app's hooks, hints and processes are as before`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/sessions.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline`
  included; `npm run typecheck`.
- [ ] **Step 5:** Commit red, then green.

### Task 3: Tier A: a window's stream, V5 on it, and the 60 s budget

**Files:** Create `cli/src/testing/dialAppEval/tierA/steps/editor.ts`, `tierA/steps/editor.spec.ts`; Modify
`tierA/world.ts` (streams and logs), `tierA/driver.ts`, `dialAppEval.spec.ts`. **Depends on:** 2. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 2's `shellOf`, `keyOfShell`, `editorSession`, `started`.
- Produces:
  ```ts
  // world.ts: TierAWorld gains
  readonly streams: NonNullable<Seen['streams']>     // seen() returns them
  readonly logs: NonNullable<Seen['logs']>           // every deps.log line, at its virtual time
  // editor.ts: the fake extension
  export const editorSteps: { [K in 'editor.window' | 'editor.focus' | 'editor.closeTerminal' | 'editor.reload'
    | 'editor.close']: StepHandler<K> }                 // editor.window built here; the rest keep Task 1's throw
  ```
- `editor.window`: with `world.extension === false` nothing; else `world.listener.vscode.open({ type: 'vscode', window:
  id }, stream)` then `world.listener['vscode-state'].handle(...)` with the window's shells' pids, the active one and
  `focused`, as `plugins/harness-device-vscode/src/loop.ts` sends them; a refusal throws. The fake `ListenerStream`
  (`ListenerStream` in `services/devicesListener.ts`): `write` records the line (Decision 1) and returns true;
  `onWritable` is kept; `ended` is an `AbortSignal` this module aborts. A written line holding a string value carries
  words: a `typed` delivery to the session whose shell it names, none when no session's.
- `driver.ts` registers `editor.window`, and its header's `process.platform` list adds the reads on the editors' paths
  (`vscode.ts`, `vscodeTerminals.ts`, `cursorFolder.ts`, `devices/vscodeExtension.ts`, `open.ts`, `appLink.ts`): each
  replaced by a dep, or a `world.gap` where one decides a check.

- [ ] **Step 1: Failing tests.** `editor.spec.ts` (a fake world whose listener records): `editor.window opens the
  devices' vscode stream with its id, then reports its shells, the active one and focused, as the extension's loop
  does`; `a second open of the same window is eval-w1-2`; `with extension false no stream opens`; `each line the
  devices write is recorded with its shells named by their sessions' keys, and no pid of the machine's is in the
  record`; `a line with words is a typed delivery to its shell's session, and to none for a shell no session owns`.
  `dialAppEval.spec.ts`: `V5 on darwin: a tap on b, in the second window, writes show with raise for b's shell on that
  window's stream alone, and runs open -b com.microsoft.VSCode` (an inline `scenario()` of Task 7's V5 row, asserted on
  `driver.seen()`); `V5 twice gives the same streams, frames and commands at the same virtual times`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/editor.spec.ts
  src/testing/dialAppEval/dialAppEval.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/` → PASS; `npm run typecheck`.
- [ ] **Step 5: Measure.** The tier A spec's wall time at this head (its Vitest duration), and V5 on darwin five times.
  Project `spec + max(V5) × 101` (35 scenarios in tier A: 33 × 3 platforms, V11 and UH1 on darwin alone). Record the
  numbers in the commit message and the report.
- [ ] **Step 6: Budget.** Over 60 s: stop and report the numbers to the main session. The spec's fallback keeps only the
  editor scenarios whose path has an OS branch on win32 and linux, and every editor scenario's hints differ by platform,
  so which to keep is the PM's call.
- [ ] **Step 7:** Commit red, then green.

### Task 4: Tier A: focus, terminal and window close, reload, the stroke, the editors' quit and relaunch

**Files:** Modify `cli/src/testing/dialAppEval/tierA/steps/editor.ts`, `tierA/steps/editor.spec.ts`,
`tierA/steps/dial.ts`, `tierA/steps/dial.spec.ts`, `tierA/driver.ts`, `dialAppEval.spec.ts`. **Depends on:** 3.
**Effort:** high.

**Interfaces:**
- Consumes: Task 2's `agentPid`, `shellOf`, `sessionsSteps`; Task 3's `editorSteps`.
- Produces: `editorSteps` complete; `dialSteps.stroke` (Decision 9);
  `export function closeWindows(world: TierAWorld, app: Editor): void` and
  `export function reopenWindows(world: TierAWorld, app: Editor): Promise<void>` in `editor.ts`. `driver.ts`'s `quit`
  of an editor runs `sessionsSteps.quit` then `closeWindows`; its `relaunch` runs `sessionsSteps.relaunch` then
  `reopenWindows` (each window the quit closed, a new id, reporting the sessions' new shells).
- `editor.focus`: the holding window's state with that shell active and `focused: true`. `editor.closeTerminal`: the
  state without the shell, then the session's end hook, its agent's and its shell's processes ended. `editor.reload`: the
  stream ends (`gone`), a new id opens and reports the same shells. `editor.close`: the stream ends (`gone`).

- [ ] **Step 1: Failing tests.** `editor.spec.ts`: `focus reports the terminal active and the window focused`; `a
  terminal's close drops its shell from the state, ends its agent's and its shell's processes, and sends its end hook`;
  `a reload ends the stream gone, then eval-w1-2 reports the same shells`; `a close ends the stream gone`; `the editor's
  quit ends its streams, and its relaunch opens new ones on the sessions' new shells`. `dial.spec.ts`: `a stroke sends
  scroll down, three moves of 8 and up`. `dialAppEval.spec.ts`: `a stroke on a, in front in VS Code, writes a scroll line
  for a's shell on its window's stream, while it is the active terminal` (inline, darwin).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/editor.spec.ts
  src/testing/dialAppEval/tierA/steps/dial.spec.ts src/testing/dialAppEval/dialAppEval.spec.ts` → FAIL.
- [ ] **Step 3:** Implement; no `not built yet` step is left in `driver.ts`.
- [ ] **Step 4:** Same command → PASS; `npx vitest run src/testing/dialAppEval/` → PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit red, then green.

### Task 5: Tier A: Cursor's folder rows

**Files:** Modify `cli/src/testing/dialAppEval/tierA/world.ts`, `tierA/machine.ts`, `dialAppEval.spec.ts`. **Depends
on:** 2. **Effort:** high.

- `machine.ts`: `folders: Set<string>`, cleared by `reset`; the world fills it with each session's `cwd` and `folders`.
- `dialAppEval.spec.ts` mocks `../../cable/hosts/cursorFolder.js`: `isFolder(path)` is `machine.folders.has(path)`,
  everything else real.
- `world.ts`: `deps.cursorExtension` finds Cursor's CLI at `/opt/eval/bin/cursor` (`bin`, `executable`) and reads an
  `extensions.json` of this build's version, so `vscodeStatus` is `on` and the setup runs nothing; its `run` records a
  gap, `the editor extension's setup ran`. `cursor` joins `ANSWERED`. `deps.vscodeExtension` stays `noEditor`.

- [ ] **Step 1: Failing tests** in `dialAppEval.spec.ts` (inline): `a tap on Cursor's own agent opens Cursor's window for
  its folder: open -b com.todesktop.230313mzl4w4u92 on darwin, Cursor's CLI on linux, harness-pty cursor-folder on
  win32`; `the editor extension's setup runs nothing: no gap on any platform`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS, `matches the baseline` included; `npm run typecheck`.
- [ ] **Step 5:** Commit red, then green.

### Task 6: Checks: `open` by the editor row's kind, `scroll`, `logged`

**Files:** Modify `cli/src/testing/dialAppEval/checks.ts`, `checks.spec.ts`. **Depends on:** 1. **Effort:** high.

**Interfaces:** Produces the `scroll` and `logged` parts (replacing Task 1's throws), `open`'s editor parts (Decision 6),
and the ring's expected names of Decision 3. Consumes the stream records of Decision 1 and `Seen.logs`.
- The window holding a shell at a time: among streams opened and not ended by then, the one whose latest state before it
  lists the shell, the latest state winning.
- `fronts` for an editor: macOS `open -b <its bundle>`; Linux `raise` naming its app id or a window class, or `xdg-open
  <the panel's link>`; Windows `harness-pty raise <its bundle>` or `harness-pty open-link <the panel's link>`.
  `linkOf` for a panel: `<scheme>://anthropic.claude-code/open?session=<id>`; none for the other editor rows.
- Evidence names keys, window ids and times only; a command's evidence stays its kind (`link`, `front`, `folder`,
  `failed`, `other`).

- [ ] **Step 1: Failing tests** (hand-made `Seen`), a pass, a fail and a latency case each: `open of a terminal row
  passes on show with raise on the stream holding its shell and the app brought forward, on each platform`; `a show on
  another window's stream fails it`; `a shell two windows list is held by the one that reported it last, and an ended
  stream holds none`; `a terminal row with no stream holding it is graded on VS Code's front, and on Cursor's folder`;
  `a panel row on its link; Cursor's agent on its folder command, folders[0] first`; `scroll passes on a line for its
  shell while active, and fails on lines the window dropped (another terminal active), on lines for another shell, and
  with nothing seen`; `logged passes on a skipped line with a reason, fails on a bare prefix and with no line`; `logged's
  evidence holds no path and no pid`; `a Codex or Cursor row's expected name is its folder's, a Claude Code row's its
  title`; `the base apps' checks score as before` (one case per base kind from the current spec, unchanged).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/checks.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included;
  typecheck.
- [ ] **Step 5:** Commit red, then green.

## Catalog

Rows below use: `a`, `c` Claude Code in a terminal; `b` the row says; `d` a Claude Code panel session; terminals in `w1`
unless named; every session built with `editorSession` and declared with `editorGhost(app)` (`z`); "started k…" is
`started([k…])`; "window wN" is `editor.window` with the active terminal and `focused` named; "listed […]" is
`listed(page, […])`. Platforms all three and tiers both unless named. Each tier B scenario gets its `cost` check from
`scenario()`. Probes name `z`.

### Task 7: Catalog: VS Code, V1–V15

**Files:** Create `cli/src/testing/dialAppEval/vscodeScenarios.ts` (`export function vscodeScenarios(): Scenario[]`, a
function as `heldOut()` is, for the builders' import cycle), `vscodeScenarios.spec.ts`; Modify `catalog.ts` (MAIN spreads
it after the base apps), `catalog.spec.ts` (its enumerations: ids, own waits, macOS-only and tier-only lists; `stroke`
and `editor.focus` count as inputs). **Depends on:** 4, 6. **Effort:** high.

| Id | Sessions and steps (labels in quotes) | Checks | Probe |
|---|---|---|---|
| V1 | a, b Codex, c (a split of b's group); d. Started d c b a; window w1 [a b c] active a focused | ring D1 vscode [a b c d] apart [] | ring + z |
| V2 | s01–s20, s01–s10 in w1, s11–s20 in w2; A only. Started s20…s01; window w1 active s01 focused; window w2 active s11 not focused; listed [s01–s16]; "close": editor.closeTerminal s05 | ring D1 timed after close [s01–s04, s06–s17]; ringKept D7 same after close | ring + z after close |
| V3 | a, b. Started b a; window w1 active a focused; listed [a b]; "focus": editor.focus b | focus D2 b after focus | focus z |
| V4 | a; d. Started d a; window w1 [a] active a focused; listed [a d]; "prompt": hook turn-start d | focus D2 d after prompt | focus z |
| V5 | a in w1, b in w2. Started b a; window w1 active a not focused; window w2 active b focused; listed [a b]; "tap": tap b | open D3 b after tap; openKept D7 b after tap | open z |
| V6 | d. Started d; listed [d]; "tap": tap d | open D3 d link after tap | open z link |
| V7 | a. Started a; window w1; listed [a]; "turn": turn-start a; wait 2 s; "ask": needs-input a permission; wait 2 s; "stop": turn-stop a "Eval answer one." | state D4 working after turn; needs-you after ask; done after stop; recap D6 a after stop | recap z |
| V8 | a. Started a; window w1; listed [a]; "voice": "Eval words for alpha." → a | voice D5 a | voice z |
| V9 | b Codex, `codexHome: 'own'`. Started b; window w1; listed [b]; "voice": "Eval words for bravo." → b | voice D5 b | voice z |
| V10 | a, b. Started b a; window w1 active a focused; listed [a b]; "reload": editor.reload w1; wait 2 s; "tap": tap b | ringKept D7 [a b] after reload; open D3 b after tap | open z |
| V11 | darwin only; world `launchedFrom: 'terminal-app'`; a. Started a; window w1 active a focused; listed [a]; "tap": tap a; wait 1 s; "stroke": stroke; wait 1 s; "close": editor.close w1; wait 1 s; "skip": stroke | ring D1 vscode [a] apart []; open D3 a after tap; scroll D3 a after stroke at close; logged D7 after skip | scroll z after stroke at close |
| V12 | B only; a with `tmux`. Started a; window w1 active a focused; listed [a]; "tap": tap a | ring D1 [a] apart []; ringKept D7 [a]; open D3 a after tap | open z |
| V13 | world `extension: false`; a. Started a; window w1 (no stream); listed [a]; "tap": tap a; wait 1 s; "stroke": stroke | open D3 a after tap; ringKept D7 [a]; logged D7 after stroke | open z |
| V14 | a, b; d. Started d b a; window w1 [a b] active a focused; listed [a b d]; "quit": quit vscode; wait 2 s; "relaunch": relaunch vscode | ringKept D7 [a b d] after relaunch; ring D1 [a b d] after relaunch | ring + z after relaunch |
| V15 | a, b. Started b a; window w1 active a focused; listed [a b]; swipe b; wait 1 s; "unplug"; wait 3 s; "replug"; listed [a b]; "tap": tap b | ringKept D7 [a b] after replug; focusKept D7 b after replug at tap; open D3 b after tap | open z |

- [ ] **Step 1: Failing tests** in `vscodeScenarios.spec.ts`: `VS Code's main ids are V1-V15, none held out, 15`;
  `V11 is macOS only, V2 tier A only, V12 tier B only, every other on every platform in both tiers`; `each V scenario's
  checks cover exactly the spec's dims` (V1 D1; V2 D1 D7; V3 D2; V4 D2; V5 D3 D7; V6 D3; V7 D4 D6; V8 D5; V9 D5; V10 D7
  D3; V11 D1 D3 D7; V12 D7 D1 D3; V13 D7 D3; V14 D7 D1; V15 D7 D3; plus D8 in tier B); `V9's Codex has its own home and
  V13's world no extension`. In `catalog.spec.ts`, its extended enumerations.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/vscodeScenarios.spec.ts
  src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → every V scenario in tier A runs on its
  platforms with no error, no wrong send and its probe caught (the failures the spec predicts are not asserted); a wrong
  send stops the task: report it. Typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 8: Catalog: Cursor, U1–U14

**Files:** Create `cli/src/testing/dialAppEval/cursorScenarios.ts` (`cursorScenarios(): Scenario[]`),
`cursorScenarios.spec.ts`; Modify `catalog.ts`, `catalog.spec.ts` (its enumerations). **Depends on:** 4, 5, 6.
**Effort:** high.

Here `b` is cursor-agent in a terminal (`engine: 'cursor'`) and `c` Cursor's own agent (`place: 'agent'`, `folders:
['/work/eval-c']`) unless named.

| Id | Sessions and steps | Checks | Probe |
|---|---|---|---|
| U1 | a, b, c, d. Started d c b a; window w1 [a b] active a focused | ring D1 cursor [a b c d] apart [] | ring + z |
| U2 | a Claude Code in VS Code (app vscode, w1); b Claude Code in Cursor (w2). Started a b; window w1; window w2 | ring D1 cursor [b] apart [a] | ring [b z]; apart [b] apart [a z] |
| U3 | a, a2 Claude Code terminals. Started a2 a; window w1 active a focused; listed [a a2]; "focus": editor.focus a2 | focus D2 a2 after focus | focus z |
| U4 | a; c. Started c a; window w1 [a] active a focused; listed [a c]; "prompt": hook turn-start c | focus D2 c after prompt | focus z |
| U5 | a. Started a; window w1 active a focused; listed [a]; "tap": tap a | open D3 a after tap | open z |
| U6 | c. Started c; listed [c]; "tap": tap c | open D3 c after tap | open z |
| U7 | d. Started d; listed [d]; "tap": tap d | open D3 d link after tap | open z link |
| U8 | c. Started c; listed [c]; "turn": turn-start c; wait 2 s; "stop": turn-stop c "Eval cursor answer." | state D4 working after turn; done after stop; recap D6 c after stop | recap z |
| U9 | a. Started a; window w1; listed [a]; "voice": "Eval words for alpha." → a | voice D5 a | voice z |
| U10 | c. Started c; listed [c]; "voice": "Eval words for charlie." → c | voice D5 c | voice z |
| U11 | b. Started b; window w1; listed [b]; "voice": "Eval words for bravo." → b | voice D5 b | voice z |
| U12 | a. Started a; window w1 active a focused; listed [a]; "close": editor.close w1; wait 2 s; "tap": tap a | open D3 a after tap; openKept D7 a after tap | open z |
| U13 | a, c, d. Started d c a; window w1 [a]; listed [a c d]; "quit": quit cursor; wait 2 s; "relaunch": relaunch cursor | ringKept D7 [a c d] after relaunch; ring D1 [a c d] after relaunch | ring + z after relaunch |
| U14 | a and c, both `/work/eval-shared` (c's folders too). Started c a; window w1 [a] | ring D1 cursor [a c] | ring [a c z] |

- [ ] **Step 1: Failing tests** in `cursorScenarios.spec.ts`: `Cursor's main ids are U1-U14, 14`; `every U scenario runs
  on every platform in both tiers`; `each U scenario's checks cover exactly the spec's dims` (U1 U2 U14 D1; U3 U4 D2; U5
  U6 U7 D3; U8 D4 D6; U9 U10 U11 D5; U12 D7 D3; U13 D7 D1; plus D8); `U2's VS Code session is counted apart from
  Cursor's page`; `U14's two sessions share a folder`. In `catalog.spec.ts`, its extended enumerations.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/cursorScenarios.spec.ts
  src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios.
- [ ] **Step 4:** As Task 7's Step 4, for the U scenarios.
- [ ] **Step 5:** Commit red, then green.

### Task 9: Catalog: the editors' held-out set

**Files:** Modify `cli/src/testing/dialAppEval/heldOut.ts`, `catalog.spec.ts`. **Depends on:** 4, 5, 6. **Effort:** high.

| Id | App, sessions and steps | Checks | Probe |
|---|---|---|---|
| VH1 | vscode: a, b. Started b a; window w1 [a b] active a focused; hook turn-start b; listed [b a]; swipe a; wait 1 s; "voice": "Eval words for alpha." → a | voice D5 a | voice z |
| VH2 | vscode: a. Started a; window w1 [a] active a not focused; window w2 terminals [a] active a focused; listed [a]; "tap": tap a | open D3 a after tap; openKept D7 a after tap | open z |
| VH3 | vscode: a, b (a split of a's group). Started b a; window w1 active a focused; listed [a b]; "focus": editor.focus b | focus D2 b after focus | focus z |
| VH4 | vscode: d. Started d; listed [d]; "voice": "Eval words for delta." → d | voice D5 d | voice z |
| UH1 | cursor, darwin only, world `launchedFrom: 'terminal-app'`: a. Started a; window w1 active a focused; listed [a]; "tap": tap a | ring D1 cursor [a] apart []; open D3 a after tap | open z |
| UH2 | cursor: c with `folders: ['/work/eval-c1', '/work/eval-c2']`, cwd `/work/eval-c1`. Started c; listed [c]; "tap": tap c | open D3 c after tap | open z |
| UH3 | cursor: a, b Claude Code terminals. Started b a; window w1 active a focused; listed [a b]; "prompt": hook turn-start b; wait 200; "voice": "Eval words for bravo." → b | voice D5 b | voice z |

- [ ] **Step 1: Failing tests** in `catalog.spec.ts`: `the held out are CH1-CH3, XH1-XH3, VH1-VH4 and UH1-UH3: 13 of
  65, VS Code 4 of 19, Cursor 3 of 17`; `VH1 and UH3 are D5 alone, UH1 macOS only`; the extended enumerations (UH3's
  200 ms wait among the own waits).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios in `heldOut()`; its header stays as it is.
- [ ] **Step 4:** As Task 7's Step 4, for the held-out editor scenarios.
- [ ] **Step 5:** Commit red, then green.

## Tier B

### Task 10: The eval command runs the editors' tier B files

**Files:** Modify `cli/src/testing/dialAppEval/runner.ts`, `runner.spec.ts`, `run.ts`, `run.spec.ts`. **Depends on:** -.
**Effort:** medium.

`runner.ts`: `Source` and `SOURCES.b` gain `vscode` and `cursor` (`['claude', 'chatgpt', 'vscode', 'cursor',
'heldOut']`). `run.ts`: `FILES.b` gains `e2e/dialAppEvalVscode.e2e.ts` and `e2e/dialAppEvalCursor.e2e.ts` before the
held-out file.

- [ ] **Step 1: Failing tests:** `run.spec.ts` `--tier b runs the five e2e files`; `a run whose VS Code or Cursor file
  wrote no results writes no baseline, naming the file`; `runner.spec.ts` `the editors' results files are named
  results-b-vscode.json and results-b-cursor.json and merge with the others`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/run.spec.ts src/testing/dialAppEval/runner.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 11: Tier B driver: the editors' CLIs inside the root, streams and log lines seen, Cursor's CLI, the stroke

**Files:** Modify `cli/e2e/harness/appEvalDriver.ts`, `cli/src/testing/dialAppEvalTierB.spec.ts`. **Depends on:** 1.
**Effort:** high.

**Interfaces:** Produces
```ts
// TierBWorld gains
stream(window: string, line: Record<string, unknown>, at?: number): void   // a Seen.streams record (Decision 1)
folder(path: string): string                                              // Decision 12: `/work/<name>` on this daemon
// exported for the unit spec
export function writeRecordingCli(path: string, runs: string): void       // notes `<exit> <args>` per run, exits 0
export function cliRuns(runs: string): OpenRun[]                          // argv ['cursor', ...args]
export function deviceLines(log: string, from: number): { lines: string[]; next: number }
  // the daemon's lines holding `[device` after offset `from`, each from its tag on
```
- `openRig` checks `HARNESS_VSCODE_BIN` and `HARNESS_CURSOR_BIN` inside the root beside its other places; on Linux it
  writes the recording CLI at `HARNESS_CURSOR_BIN` (Decision 14) and `writeSchemeApps` gains the editors' schemes with
  the desktop files of Task 1.
- `World.read()` also takes the Cursor CLI's runs as commands and the devices' new log lines as `Seen.logs` (at their
  read); commands carry Decision 12's `/work/` paths; `seen()` returns `streams` and `logs`.
- `GENERIC` gains `stroke` (Decision 9). `tierBGaps` gains Decision 13.

- [ ] **Step 1: Failing tests** in `dialAppEvalTierB.spec.ts`: `leaves out on Linux an open check on an editor's
  terminal row, and not on a panel or Cursor's agent, nor on macOS`; `the recording Cursor CLI notes each run as cursor
  and its arguments, and exits 0`; `deviceLines gives the devices' lines after an offset, from their tag on`; `a
  command's folder under the daemon's projects is recorded as the catalog's /work/ one`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEvalTierB.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck; `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts
  e2e/dialAppEvalClaude.e2e.ts` on this Mac → PASS (the driver's other user).
- [ ] **Step 5:** Commit red, then green.

### Task 12: The extension's window in the e2e harness

**Files:** Create `cli/e2e/harness/editorWindow.ts`; Modify `cli/e2e/dialVscode.e2e.ts`. **Depends on:** -. **Effort:**
medium. No behaviour change: one commit.

**Interfaces:** Produces `export interface EditorWindow` (the file's `Window`: `states`, `shows`, `raised`, `scrolls`,
`keys`, `took`, `logs`, `set(state)`, `stop()`) and `export function startEditorWindow(d: IsolatedDaemon, children:
ChildProcess[]): EditorWindow`: the launcher shim in the throwaway home, the `vscodeWindow.ts` process and its parsing,
moved as they are from `dialVscode.e2e.ts`, its failure dump kept.

- [ ] **Step 1:** Move it; `dialVscode.e2e.ts` imports it.
- [ ] **Step 2:** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts` on this Mac
  → PASS; typecheck.
- [ ] **Step 3:** Commit.

### Task 13: Tier B: VS Code

**Files:** Create `cli/e2e/harness/appEvalEditor.ts`, `cli/e2e/dialAppEvalVscode.e2e.ts`,
`cli/src/testing/dialAppEvalTierBEditor.spec.ts`; Modify `cli/e2e/harness/editorWindow.ts` (a listener of each printed
line with its arrival), `cli/e2e/harness/codexOutside.ts`, `cli/e2e/harness/outsideAgent.ts`,
`cli/e2e/harness/appEvalClaude.ts` and `appEvalChatgpt.ts` (exports only). **Depends on:** 7, 10, 11, 12. **Effort:**
xhigh.

**Interfaces:**
- Consumes: Task 11's `stream`, `folder`, `speak`, the stroke; Task 12's `startEditorWindow`; `modInbox.inboxPoll`;
  `InOwnTmux`, `tabClient` (`ownTmux.ts`).
- Produces: `export const vscodeSteps: AppSteps` (and the module's editor-generic parts Task 14 builds Cursor on);
  `CodexOutsideOptions` gains `home?: string` (its rollout and hooks under that `CODEX_HOME`) and a start as a shell's
  job in a tab of a fake app (its `shellPid`); `Outside.start` gains `launchedFrom?: 'terminal-app'` (the fake editor in
  a tab of a fake Terminal, so `ps` reads Terminal → shell → editor → shell → Claude Code).
- Claude Code sessions run through `appEvalClaude.ts`'s own session code (start, turn, permission, stop, end, the mod's
  poll, `typedPrompts`), exported with the fake app and hints as parameters, not copied; `FAKE_CLAUDE_SESSION_TITLE` is
  the title. Codex deliveries are read as `appEvalChatgpt.ts` reads its queue ledgers, that reader exported.
- The editor steps: `editor.window` starts an `EditorWindow` (none with `extension: false`) and sets its shells; the
  others as tier A's (Task 4), on the real loop; `quit`/`relaunch` end and start the fake editor, its sessions and its
  windows. Every process goes in `world.children`; folders through `world.folder`.
- `dialAppEvalVscode.e2e.ts`: as `dialAppEvalChatgpt.e2e.ts` for `vscode` (source `vscode`), with these cases first:
  `the daemon's home, its open, VS Code's and Cursor's CLIs are inside its root, and a start with either CLI outside
  it throws before the daemon starts`; `a window's lines name shells by their sessions' keys, never a pid` (V5's `seen().streams`); `a Codex with its
  own home writes its rollout outside the daemon's CODEX_HOME` (V9).

- [ ] **Step 1: Failing tests.** `dialAppEvalTierBEditor.spec.ts`: `the window's printed lines become stream records: a
  show with the raise after it folded in, each scrolled line for the active terminal, each state taken, shells by key`.
  The e2e file with its cases and `it.for` over tier B's VS Code scenarios: `cd cli && TMPDIR=/tmp npx vitest run
  --config vitest.e2e.config.ts e2e/dialAppEvalVscode.e2e.ts` → FAIL (no VS Code steps).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `npx vitest run src/testing/dialAppEvalTierBEditor.spec.ts` → PASS; the e2e file → PASS on this Mac,
  under 6 minutes (report the time and each scenario's); no wrong send and no network reached (else stop and report);
  `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/dialCodexApp.e2e.ts
  e2e/deviceCodex.e2e.ts e2e/dialAppEvalClaude.e2e.ts e2e/dialAppEvalChatgpt.e2e.ts` → PASS (the changed harness's
  other users); typecheck.
- [ ] **Step 4:** Commit red, then green.

### Task 14: Tier B: Cursor

**Files:** Create `cli/e2e/harness/cursorOutside.ts`, `cli/e2e/dialAppEvalCursor.e2e.ts`; Modify
`cli/e2e/harness/appEvalEditor.ts`, `cli/src/testing/dialAppEvalTierBEditor.spec.ts`. **Depends on:** 8, 13. **Effort:**
high.

**Interfaces:** Produces `export const cursorSteps: AppSteps` and
```ts
// cursorOutside.ts: cursor-agent in a terminal (TERM_PROGRAM) or Cursor's own agent (none), under a fake Cursor
export class CursorOutside {
  static start(d: IsolatedDaemon, folder: string, children: ChildProcess[],
    options: { sessionId: string; terminal: boolean; hints: Record<string, string> }): Promise<CursorOutside>
  readonly pid: number; readonly shellPid?: number; readonly transcriptPath: string
  /** Runs the real hook/notify.mjs as Cursor's own hooks run it, with the events its cursor names map. */
  hook(event: 'start' | 'turn-start' | 'turn-stop' | 'end', lastAnswer?: string): Promise<void>
  close(): Promise<void>
}
```
Its transcript is where tier A writes Cursor's (`<CURSOR_HOME>/projects/<slug>/agent-transcripts/<id>.jsonl`), checked
inside the daemon's root.

- [ ] **Step 1: Failing tests.** `dialAppEvalTierBEditor.spec.ts`: `Cursor's agent's hook carries engine cursor and no
  TERM_PROGRAM, cursor-agent's TERM_PROGRAM=vscode`. The e2e file as Task 13's for `cursor` (source `cursor`) with `a
  tap on Cursor's own agent opens its folder by the platform's command` (U6) → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Both → PASS on this Mac, the e2e file under 6 minutes (report the times); no wrong send and no network
  reached (else stop and report); typecheck.
- [ ] **Step 4:** Commit red, then green.

### Task 15: Tier B: the editors' held-out scenarios

**Files:** Modify `cli/e2e/dialAppEvalHeldOut.e2e.ts`, `cli/e2e/harness/appEvalEditor.ts` (only what VH1–UH3 need: a
second window reporting a shell, Cursor launched from Terminal, a multi-root agent's folders). **Depends on:** 9, 14.
**Effort:** high.

- [ ] **Step 1: Failing test:** the held-out file's `TierBDriver` still has no editor steps, so its `it.for` over
  `HELD_OUT` fails on VH1: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts
  e2e/dialAppEvalHeldOut.e2e.ts` → FAIL.
- [ ] **Step 2:** Give the driver `vscodeSteps` and `cursorSteps`; build what VH2, UH1 and UH2 need.
- [ ] **Step 3:** Same → PASS on this Mac, under 6 minutes; no wrong send and no network reached (else stop and report).
- [ ] **Step 4:** Commit red, then green.

## CI

### Task 16: `ci-plan.py`: linux-e2e runs the editors' files

**Files:** Modify `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`. **Depends
on:** -. **Effort:** high.

`LINUX_E2E_APP_EVAL_FILES` gains `cli/e2e/dialAppEvalVscode.e2e.ts` and `cli/e2e/dialAppEvalCursor.e2e.ts` (before the
held-out file). `LINUX_E2E_APP_EVAL_PATHS` gains `cli/src/services/devices.ts`, `cli/hook/notify.mjs`,
`plugins/harness-device-vscode/src/`, `cli/src/devices/vscodeExtension.ts`, `cli/src/cable/vscodeExtensionSetup.ts`,
`cli/src/engines/cursor/`, `cli/src/core/engines/cursorDiscovery.ts`, `cli/e2e/harness/vscodeWindow.ts`,
`cli/e2e/harness/outsideAgent.ts`, `cli/e2e/harness/codexOutside.ts`, `cli/e2e/harness/cursorOutside.ts` and
`cli/e2e/harness/editorWindow.ts` (Decision 18).

- [ ] **Step 1: Failing tests:** `test_a_change_the_app_eval_covers_runs_its_e2e_files` gains each new path (a change
  and a deletion run the five files; a harness one with the canary; a head without `dialAppEvalCursor.e2e.ts` fails
  naming it); `test_the_app_eval_e2e_files_are_plain_and_run_on_linux` covers the two; update the cases that list the
  eval's files (`test_a_change_to_the_orca_stand_in_or_adapter_runs_the_orca_e2e_files`, the dial-host one, whose
  `outsideAgent.ts` is a DIAL_HOST_PATHS entry now also an app eval path).
- [ ] **Step 2:** `python3 scripts/tests/test_ci_plan.py` → FAIL.
- [ ] **Step 3:** Implement. `docs/validation-and-release.md`, the linux-e2e row: the eval's files are five, and what they
  cover names the new paths.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit red, then green.

## Baseline

### Task 17: The baseline

**Files:** Modify `cli/src/testing/dialAppEval/baseline.json`, `cli/ci-e2e-durations.json`, `catalog.spec.ts` (the
kind-coverage case over every kind). **Depends on:** 7, 8, 9, 10, 13, 14, 15. **Effort:** xhigh.

- [ ] **Step 1: Failing tests (existing):** the tier A spec's `matches the baseline` (stale: the editors' checks are new)
  and the two new files' `matches this platform's baseline` → FAIL. Restore the kind-coverage case over every step kind
  but `wait`; `grep -rn "not built yet" cli/src/testing/dialAppEval cli/e2e/harness` prints nothing.
- [ ] **Step 2: The baseline run** on this Mac at this head: `cd cli && git show
  main:cli/src/testing/dialAppEval/baseline.json > /tmp/dial-eval-main-baseline.json && TMPDIR=/tmp
  DIAL_EVAL_OUT=/tmp/dial-eval-baseline npm run eval:dial-apps -- --update-baseline`. It re-measures every subset it
  drives, the base apps' included (Decision 19), and writes tier A (darwin, win32, linux) and tier B darwin; no Linux
  tier B entry. **A wrong-session send, or a test failing on the network guard: stop and report (the PM decides before
  anything merges).** Keep `/tmp/dial-eval-baseline/report.md` for the PR.
- [ ] **Step 3: The base apps' held checks equal `main`'s.** From `cli`, compare the run's results with `main`'s
  baseline. Held: each key of a C, X, CH or XH scenario in subset `a` (any `timed`) or `b/darwin` with `timed: false`,
  from either side; `main`'s `b/darwin` keys whose result is timed are not held. Also held: `apps.a.claude` and
  `apps.a.chatgpt` of the written `baseline.json`.

  ```bash
  node --input-type=module -e '
  import { readFileSync, readdirSync } from "node:fs"
  const out = "/tmp/dial-eval-baseline"
  const main = JSON.parse(readFileSync("/tmp/dial-eval-main-baseline.json", "utf8"))
  const written = JSON.parse(readFileSync("src/testing/dialAppEval/baseline.json", "utf8"))
  const base = (key) => /^(a\/\w+|b\/darwin)\/(C|X|CH|XH)\d+\//.test(key)
  const now = new Map(), timed = new Set()
  for (const f of readdirSync(out).filter((n) => /^results-[ab]-\w+\.json$/.test(n)))
    for (const r of JSON.parse(readFileSync(`${out}/${f}`, "utf8")).results) {
      const key = `${r.tier}/${r.platform}/${r.scenario}/${r.check}`
      if (!base(key)) continue
      if (r.tier === "b" && r.timed) timed.add(key); else now.set(key, r.score)
    }
  const keys = new Set([...Object.keys(main.checks).filter((k) => base(k) && !timed.has(k)), ...now.keys()])
  const differ = [...keys].sort().filter((k) => main.checks[k] !== now.get(k))
  for (const app of ["claude", "chatgpt"])
    if (main.apps.a[app] !== written.apps.a[app]) differ.push(`apps.a.${app}`)
  console.log(`base apps: ${keys.size} held checks equal main: ${differ.length === 0}; ${timed.size} timed tier B entries re-measured`)
  for (const k of differ) console.log(`differs: ${k}`)
  process.exit(differ.length > 0 ? 1 : 0)'
  ```

  Expected: exit 0, `held checks equal main: true`. A key that differs is a shared change moving a base app (Review
  Focus 1), a bug on this branch: do not commit the baseline; report the keys and return the task for a fix in the task
  that owns the change. Nothing else is compared: the base apps' timed `b/darwin` entries and their `b/darwin` app
  scores are written as measured.
- [ ] **Step 3b: The delta for the PR body.** From `/tmp/dial-eval-baseline/report.md`, the Delta section (each subset's
  app score before → after, each check that changed, the held-out count) goes into the PR body under "Baseline delta",
  with Step 3's summary line. For the Claude app and the ChatGPT app, a change there is a timed `b/darwin` check or a
  `b/darwin` app score; a changed C, X, CH or XH check that is not timed, or a changed `a` score of theirs, means Step 3
  missed one: stop and report.
- [ ] **Step 4: Times.** The tier A spec under 60 s (else stop and report, as Task 3's Step 6); each new e2e file's time
  into `cli/ci-e2e-durations.json` (`durationMs`), and the held-out file's anew, each under about 6 minutes.
- [ ] **Step 5:** `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts
  src/testing/dialAppEvalTierBEditor.spec.ts` → PASS; the five eval e2e files → PASS on this Mac; `npm run typecheck`.
- [ ] **Step 6:** Commit once (the failing ratchet is the existing test).

---

## Verification

Isolation follows the repo's own e2e harness (`cli/AGENTS.md` rule 6, `cli/e2e/harness/daemon.ts`): each
`IsolatedDaemon` has a throwaway root, home, data folder and socket, a private tmux server, the in-memory fake backend
with a made-up machine and token, the recording `open` (`HARNESS_OPEN_BIN`), its own `HARNESS_VSCODE_BIN` and
`HARNESS_CURSOR_BIN` checked inside its root, and the network guard in every process. The everyday daemon (18473), the
real VS Code and Cursor (nor a renamed copy of either: the fake editors are Node under a bundle in the throwaway home),
`~/.vscode`, `~/.cursor`, `~/.claude` and `~/.codex` are never reached. No check needs a person's login or production:
every account is the fake backend's.

1. **Tier A on macOS** (this Mac, final head): `cd cli && npx vitest run src/testing/dialAppEval/`. Seen: all pass, the
   tier A spec under 60 s, `matches the baseline` green, no scenario erroring.
2. **Tier A on Linux:** PR CI's `cli-tests` (four shards) runs the same spec against the macOS-written baseline. Seen:
   green; a difference is a determinism bug, not a baseline to refresh.
3. **Tier B on macOS, by the tester:** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts
   e2e/dialAppEvalVscode.e2e.ts e2e/dialAppEvalCursor.e2e.ts e2e/dialAppEvalHeldOut.e2e.ts`. Seen: the three pass, each
   scenario's time printed, each file under about 6 minutes; no wrong send, no network reached. No repo workflow runs
   macOS e2e files.
4. **The whole eval on macOS, by the tester:** `cd cli && TMPDIR=/tmp npm run eval:dial-apps`. Seen: exit 0; the report
   (terminal and `report.md`) has the score table with four rows (`the Claude app`, `the ChatGPT app`, `VS Code`,
   `Cursor`) and each app's left-out count, `Not covered: tier B on Windows`, the held-out table, `Gate: passed`, the
   ranked groups; the Claude and ChatGPT tier A checks and tier B pass/fail checks as on `main` (their timed tier B
   entries may differ, as Task 17's Delta shows).
5. **Tier B on Linux:** PR CI's `linux-e2e` runs the five eval files (the eval's paths changed), `dialVscode.e2e.ts`
   (modified) and the canary (harness changed), on ubuntu-24.04. Seen: `linux-e2e-summary` green, none of the five all
   skipped. Linux is gate-only. If PR CI did not select them, run once by hand: **Actions → CI → Run workflow**,
   `scope=linux-e2e`, `e2e_files="cli/e2e/dialAppEvalVscode.e2e.ts cli/e2e/dialAppEvalCursor.e2e.ts
   cli/e2e/dialAppEvalHeldOut.e2e.ts"`. No other extra run.
6. **dial-hosts:** PR CI runs it, as `outsideAgent.ts` is a `DIAL_HOST_PATHS` entry. Seen: green, none skipped.
7. **Local gates** PR CI does not run, at the final head from a clean tree: `cd cli && npm run typecheck`; the touched
   specs (check 1, `src/testing/dialAppEvalTierB.spec.ts`, `src/testing/dialAppEvalTierBEditor.spec.ts`); `python3
   scripts/tests/test_ci_plan.py`, then `CROSS_READ_SCAN_REQUIRED=1 python3 -c 'import sys; sys.path.insert(0,
   "scripts/tests"); import unittest, test_ci_plan; unittest.main(module="test_ci_plan", argv=["x",
   *test_ci_plan.FullCheckoutTests.NAMES])'`; `dialVscode.e2e.ts` on macOS (check 3's command); then `python3
   scripts/local-checks.py --run`, its fence pasted into the PR body. `npm run test:core` does not apply: nothing under
   `src/core/` or `src/services/` changes (a task that needed a `devices.ts` seam stopped and asked). `npm run
   test:vscode` does not apply: the extension is unchanged.
8. **PR evidence:** the baseline run's report (score per app × dimension for the four apps, the held-out scores, the
   wrong-session count, the ranked groups), its Delta section under "Baseline delta" with Task 17 Step 3's summary
   line (the base apps' held checks equal `main`'s; their timed tier B entries re-measured), Task 3's budget numbers and the final tier A time, each e2e file's time, the
   red-then-green commits; platforms: macOS run in both tiers, Linux in tier A and tier B (gate-only), Windows in tier A
   by injection.
9. **Gaps named in the PR:** Windows tier B; Linux tier B baseline entries (gate-only); on Linux tier B an editor
   terminal's open (Decision 13); V12 in tier A (no tmux); the extension's install and update (their own specs).
   Proposals, not in this PR: a macOS run of the five eval e2e files on pull requests that change their paths, since
   tier B's ratchet is held on macOS alone and no PR CI suite runs macOS; the five files on `windows-e2e`.
10. **After merge** (main session, with the PM): run both tiers on `main` and report the score per app × dimension, the
    held-out score, the wrong-session count, the coverage gaps and the failing groups ranked by points lost, each with a
    one-line cause.

## Open questions

None. The three this draft asked were answered by the orchestrator on 2026-11-22 and are now Decisions: Windows hints for
an editor terminal row (Decision 2), the names of Codex, cursor-agent and Cursor-agent rows (Decision 3), and the base
apps on the baseline run (Decision 19, Task 17 Steps 3 and 3b).
