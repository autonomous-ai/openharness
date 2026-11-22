# Dial eval for iTerm2 Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** One 0–100 score for iTerm2, from 26 more scenarios of the dial eval's catalog (21 main, 5 held out), graded
in tiers A and B on macOS beside the other five apps, with the same gate and a ratcheting baseline.

**Architecture:** The eval (`cli/src/testing/dialAppEval/`, `cli/e2e/harness/appEval*.ts`) gains a sixth app. Tier A
models iTerm2, its server, its tabs and splits, a tmux server and a herdr server as processes on the machine model; the
devices' real tmux and herdr code runs against that model through the existing `DevicesDeps.orca.run` and
`DevicesDeps.herdr` seams, and the watch's tabs stream is the devices' own handler opened with a fake stream. Tier B runs
a fake iTerm2 bundle with its server under it, the daemon's private tmux, a private herdr started from a fake iTerm2 tab,
recording `tmux` and `herdr` wrappers, and the real `harness hardware watch`. One pure module writes the records both
tiers share (tab labels, panes named by session); `open` is graded by an iTerm2 row's place.

**Tech Stack:** TypeScript (Node 24), Vitest (unit suite and `vitest.e2e.config.ts`), the e2e harness (`IsolatedDaemon`,
`Desk`, `FakeDial`, `Outside`, `InOwnTmux`, `PrivateHerdr`, `CodexOutside`, the fake backend), Python 3 for
`scripts/ci-plan.py`.

**Spec:** `docs/plans/2026-11-22-dial-eval-iterm2-design.md`. It extends the base spec
`docs/plans/2026-11-21-dial-app-eval-design.md` and the editors spec `docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md`,
and builds on the Orca eval (`docs/plans/2026-11-22-dial-eval-orca-design.md` and `-plan.md`, on `main` since #4551,
`135c5e99fa`). Read all of them; this spec's Decisions are final. The editors plan
(`docs/plans/2026-11-22-dial-eval-vscode-cursor-plan.md`) explains most of the code this plan builds on.

## Sequencing and the Orca contract

The Orca eval edited the same files and merged first (PM, 2026-11-22): #4551, `135c5e99fa` on `main`, 2026-11-23. Task 1
rebased this branch onto it and checked each row below on `main`; every task uses the merged names, and "Reconciled with
Orca's merge" at the end lists what changed from the plan as first written (against `ffae56df2e` and Orca's plan).

What this plan takes from Orca (as merged):

| What | Where on `main` |
|---|---|
| `App` and `APPS` with `orca` last, `PAGE.orca`, `LinkedApp` (`Exclude<App, 'orca'>`), `FRONT_NAMES` (typed every app on every platform) and the front told through the product's `frontAppId` (its Decision 10) | `types.ts`; `tierA/steps/window.ts` `windowSteps.front` and its spec's every-app case; `e2e/harness/appEvalDriver.ts` `GENERIC.front` (writes the raw name) |
| `SessionDef.tab` and `split` (numbers, doc-commented "Orca only"), `worktree`, `handle`, `held`; `Seen.faces[].refused`; the `face` check | `types.ts` |
| The tmux process model (its Decision 5), inline in the private `orcaPane`: per tmux session a server `tmux` (launchd's child, no tty), a shell under it on a tty of its own, the agent under that shell; the client `tmux` under the Orca pane's shell on that pane's tty; `TMUX_PANE` `%<the session's index in scenario.sessions>`. Ttys from the private `nextTty` (one counter per world, `ttys000` first); processes from the private `startProcess`. No tmux command is answered (the `ensureTmuxOnPath` mock answers `absent`) | `tierA/steps/sessions.ts` |
| `dropSession(world, key): Promise<void>`: throws for a session not running; ends its agent, its shell and its `Live.others`, with no hook; closes its mod's poll | `tierA/steps/sessions.ts` |
| `ANSWERED` (`open`, `xdg-open`, `xdg-mime`, `harness-pty`, `raise` and `ORCA_PROGRAMS`, by `argv.ts` `programOf`); the world's `orca` deps (`run`, `onPath` over the constant `ON_PATH[platform]`, `exists` true for Orca's install alone, `platform`, `spawn`, `mtime`); tier A starts no process (`tierA/refuseProcesses.ts`, the spec's `child_process` mocks) | `tierA/world.ts`, `dialAppEval.spec.ts` |
| The fake Orca's run log (its Decision 14): written by the launcher's shell `note()`, a file `log/run.XXXXXX` per run (`mktemp`, then moved in whole), its first line the exit, then the name it was run by, then one argument a line, its mtime its time; read by `FakeOrca.log()` (`{ argv, ok, at }`, `argv[0]` the name); `OrcaRun` and its readers `orcaCommands`, `orcaDeliveries`; specs `src/testing/fakeOrca.spec.ts`, `src/testing/dialAppEvalTierBOrca.spec.ts` | `e2e/harness/fakeOrca.ts`, `e2e/harness/appEvalDriver.ts` |
| `results-b-orca.json` (`Source` and `SOURCES.b` `orca` before `heldOut`), `e2e/dialAppEvalOrca.e2e.ts` before the held-out file in `FILES.b`; six files in `LINUX_E2E_APP_EVAL_FILES` (and `APP_EVAL_FILES` in `test_ci_plan.py`) | `runner.ts`, `run.ts`, `scripts/ci-plan.py` |
| The catalog: O1–O17 in `orcaScenarios.ts` `orcaScenarios()`, spread last in `MAIN`; builders `orcaSession`, `orcaGhost`, `orcaOpening`, `orcaStarted`; OH1–OH4 held out (17 of 86; Orca 4 of 21); the kind-coverage case over every step kind but `wait` and `stroke` | `orcaScenarios.ts`, `catalog.ts`, `catalog.spec.ts`, `heldOut.ts` |
| Orca's entries in `baseline.json` (`a/darwin`, `a/linux`, `a/win32`, `b/darwin`; `apps.a.orca`, `apps['b/darwin'].orca`); the held-check script, inline in its Task 17 Step 3 | `baseline.json`, `docs/plans/2026-11-22-dial-eval-orca-plan.md` |

Files this branch shares with Orca (the spec's Coordination section, completed): `types.ts`, `types.spec.ts`,
`grade.spec.ts`, `report.ts`, `report.spec.ts`, `checks.ts`, `checks.spec.ts`, `catalog.ts`, `catalog.spec.ts`,
`heldOut.ts`, `baseline.json`, `runner.ts`, `runner.spec.ts`, `run.ts`, `run.spec.ts`, `tierA/world.ts`,
`tierA/driver.ts`, `tierA/machine.ts`, `tierA/steps/sessions.ts` and its spec, `tierA/steps/window.ts` and its spec,
`dialAppEval.spec.ts`, `cli/e2e/harness/appEvalDriver.ts`, `cli/e2e/harness/fakeOrca.ts`, `cli/e2e/harness/codexOutside.ts`,
`cli/src/testing/dialAppEvalTierB.spec.ts`, `cli/e2e/dialAppEvalHeldOut.e2e.ts`, `cli/ci-e2e-durations.json`,
`scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`.

## Global Constraints

- Kept from the base: weights D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5; the latency thresholds (inclusive,
  1 / 0.5 / 0); points lost `100 · (w_d / Σw) · (1 − score_c) / n_d`; target ≥ 95 reported, never failing CI.
- Gate: a voice prompt delivered to a session other than the scenario's target fails the whole run. A wrong-session send
  in any tier A run of a task, or in the baseline run, stops the task: report it (the PM decides before anything merges).
- PM 2026-11-22: (1) graded on what the person expects, even where no path exists yet (I10, I11 fail at baseline);
  (2) macOS only, in both tiers; (3) tier B is graded on the tester's local macOS run; PR CI guards iTerm2 through tier A
  alone, and the report repeats the macOS e2e workflow proposal.
- **No product code changes.** Test code, the e2e harness, `scripts/ci-plan.py` and its test, `cli/ci-e2e-durations.json`,
  the `docs/validation-and-release.md` row, `baseline.json`. Every stand-in is a `vi.mock` or an existing `DevicesDeps`
  seam. A task that finds it needs a new seam stops and returns the question; nothing under `cli/src/core/`,
  `cli/src/services/`, `cli/src/cable/`, `cli/src/devices/`, `cli/hook/` or `plugins/` changes.
- **Fakes only.** Never the person's iTerm2, tmux server, herdr, daemon or dial. No `osascript`. No reading of another
  process's environment or argv; `hcCore.ts`'s `ps -axo command=` is not used. Every home, tmux socket, herdr config, app
  bundle and `open` is a throwaway inside the run's own root. The network guard stays on in every eval test. Tier A
  starts no process (`tierA/refuseProcesses.ts`): a read the world misses throws, and the spec's `reached` stays empty.
- The other apps' entries equal `main`'s for every tier A check and every tier B pass/fail check; their tier B latency
  and cost entries are written as measured, and the PR shows the delta.
- Held out: IH1–IH5 (5 of 26, 19%) in `heldOut.ts` and `dialAppEvalHeldOut.e2e.ts`; scored apart.
- Tier A deterministic, the whole tier under 60 s, no D8. The tier B iTerm2 file under about 6 minutes locally. Tier B on
  this Mac always runs under `caffeinate -i`.
- Fixtures are made up: titles start with `Eval `, folders with `/work/eval-`. No result holds a path, pid, tty, pane id or
  session name: evidence names ttys and panes by the scenario's labels.
- No fixed sleeps in tier A; tier B waits are bounded `until` polls; a scenario's own `wait` is scenario timing.
- Copy follows the Naming System: "the dial", "iTerm2", "tmux", "herdr", "Claude Code", "Codex".

## Review Focus

1. **The other apps' results moving under shared changes:** `deps.tty` in `/dev/` form (on `main` it answers the bare
   name; `services/devices.ts` hands it to `observed.ts` only on darwin, read only for a tab app's agent, `tabs.ts`
   `TAB_APPS`: Terminal, iTerm2, Ghostty, so X10's Ghostty Codex CLI, not Orca's agents; the multiplexer adapters read
   `readTtyName`), Orca's tmux pane on the moved model (O11), the `ANSWERED` list, the
   `learnApps` mock's walk, `FRONT_NAMES` losing an entry off macOS; in tier B the watch's stdout read, the recording
   `tmux` wrapper and `ownHerdrsOnly` on every eval daemon, and the run log moved out of `fakeOrca.ts`. Tasks 4–7 run the
   tier A spec against the baseline (`matches the baseline` green); Task 13 runs the other apps' tier B files; Task 17
   holds every other app's checks to `main`'s.
2. **Words herdr types into a pane no session holds** (an old pane after `herdr.restart`, a closed tab's) are a `typed`
   delivery to none, a wrong send. Task 6's spec.
3. **A select naming the wrong tab** (a split's sibling, the tab a tmux client left) passes no `open`. Task 8's spec.
4. **A walk reaching this machine's own terminal or tools:** a herdr pane's parents ending at the test worker (and so at
   the tester's real terminal), a `tmux` off the daemon's private socket, a herdr outside the test's tree in the daemon's
   table. Task 12's harness cases and Task 14's per-scenario assertions.
5. **Virtual time across a restart:** the devices started again, herdr's source reconnecting, the same results twice.
   Task 7's spec.

## Decisions this plan makes (from the spec's room)

1. **Sessions.** `itermSession(key, more)`: app `iterm`, id `uuid(key, '8e')` (`catalog.ts`'s helper, its variants gaining
   `8e`: `00000000-0000-4000-8e00-<the key's hex, 12 wide>`, no other app's; Orca's is `8c`, its handles `8d0n`), `titleOf(key)`, cwd `/work/eval-<key>`, `ageMs: 0`, `place: 'tab'`, `window: 'w1'`, `tab: 0`, `split: 0`.
   `place` takes iTerm2's places (`ItermPlace = 'tab' | 'tmux' | 'herdr'`) beside the editors'; `placeOf` still answers
   the editors' alone and `itermPlaceOf` iTerm2's. For a tab session `tab`/`split` are its iTerm2 tab and split; for a
   tmux or herdr one they are the tab its multiplexer's first client runs in and its pane's order in that multiplexer's
   window. `tmux: true` keeps its meaning (V12, O11) and is refused on an iTerm2 session, as is an editor place.
2. **Labels.** A tab or split is named `<window>.<tab>.<split>` (`w1.1.0`) in every record and evidence; a tmux or herdr
   pane is `pane:<session key>` (`pane:other` for one no session holds). Both tiers write them (`itermRecords.ts`), so
   one evaluator grades both and no tty or pane id reaches a result.
3. **The tabs stream record** (`Seen.streams`, window `tabs`): `{ type: 'tabs' }` at its open; the person's report `{
   type: 'tab', app: 'iterm', tab: <label> }`; each select the devices write `{ app, tab: <label>, raise?: true }`; its end
   `{ ended: <StreamEnd> }`. Tier B reads the selects off the watch's stdout and records no open.
4. **iTerm2 on the model (tier A).** iTerm2 `/Applications/iTerm.app/Contents/MacOS/iTerm2` (ppid 1, its bundle's id
   `com.googlecode.iterm2` in `machine.bundleIds`); its server `<world root>/Library/Application
   Support/iTerm2/iTermServer-3.6.6` (ppid iTerm2, 1 after `iterm.relaunch`); each tab and split `/usr/bin/login` under the
   server, then `/bin/zsh`, then the agent, all on its own tty (`sessions.ts` `nextTty`, Orca's: one counter per world,
   `ttys000` first, in opening order, shared with tmux's and herdr's panes). No iTerm2 process
   carries an app id: on an iTerm2 scenario's machine the `learnApps` mock answers a pid `appOf` names nothing for with the
   real `scannedApps` over the model's rows, bundle ids and the world's home, so iTerm2's server rule is what is graded.
   The world keeps the bare tty; `DevicesDeps.tty` answers `/dev/ttysNNN`, `readTtyName` and `ps -o pid=,tty=` the bare one.
5. **tmux on the model.** Orca's process model, which `main` has inline in `sessions.ts`'s private `orcaPane`, moves into
   `tierA/steps/tmux.ts` as the one model both apps run on (the spec: not a second one), and is extended: one server per
   world at `/opt/eval/bin/tmux` (Orca's started a bare `tmux` per session; the maker check reads the basename, the same);
   one tmux session per client tab (`eval-<window>-<tab>`; an Orca pane's own is `eval-<key>`), one window, a pane per
   session in `split` order, pane ids Orca's `TMUX_PANE` rule, `%<the session's index in scenario.sessions>`, so O11's
   hint does not move; pane ttys from `nextTty`. Orca's O11 runs on it with its results unchanged (`matches the
   baseline`). A client is a `tmux` process under its tab's (or Orca pane's) shell on that tty, with an activity time. The
   `ensureTmuxOnPath` mock answers `adopted` at `/opt/eval/bin/tmux` on an iTerm2 scenario's machine alone. The world fills
   each `#{…}` of the formats tmux.ts sends (`TMUX_PANE_FACTS`, `TMUX_CLIENTS`, `TMUX_CLIENT_PLACES`, `TMUX_PANES`) from the
   model; a name it does not know is a gap. `select-window -t P ; select-pane -t P` makes P its window's active pane;
   `switch-client -c C -t P` moves client C.
6. **The person's typing.** A `turn-start` hook of a tmux or herdr session while iTerm2's last selected tab
   (`iterm.select`) holds one of its multiplexer's clients is typed through that client: its activity and its tty's
   access time move to now first (tier B types the prompt into that tab's pty). Otherwise nothing of a client moves.
7. **herdr on the model.** Its server `/opt/eval/bin/herdr` is its first client's child on no tty, `onPath('herdr')`
   finds it on an iTerm2 scenario's machine; panes `w1:p<n>` from `p1`, their shells the server's children on ttys from
   `nextTty`; clients `herdr` processes under their tab's shell. A fake `HerdrClient` (`DevicesDeps.herdr`, iTerm2
   scenarios only; every other keeps `noHerdr`): `agent.list` answers each live herdr session's `{ pane_id, agent:
   'claude', agent_status, cwd, agent_session }` (no `agent_session` for `herdrSession: false`, no `name`, so a folded row
   is named by its hook's title), status `idle` at start, `working` at `turn-start`, `blocked` at `needs-input`, `done` at
   `turn-stop`, told as `pane.agent_status_changed` to subscriptions naming the pane; `prompt(pane)` is a `typed` delivery
   to the session in that pane (none for another) answering `sent`; `socketStamp()` a stamp while the server runs. `lsof -a
   -U -p … -F pdn` lists one `herdr-client.sock` descriptor of the server per client and each client's peer of it
   (`herdrOuter.ts connectedOf`'s form); `ttyAtime` is mocked to `machine.atimes`; the `watchSocket` mock keeps every
   watch the devices hold and `herdr.restart` fires them all.
8. **Hints** (`hook/notify.mjs` `HOST_HINTS`): tab `TERM_PROGRAM=iTerm.app`, `__CFBundleIdentifier=com.googlecode.iterm2`;
   tmux `TERM_PROGRAM=tmux`, `TMUX_PANE`, iTerm2's bundle id; herdr `HERDR_PANE_ID`, `TERM_PROGRAM=iTerm.app`, iTerm2's
   bundle id. Tier B: a tmux session's panes get `__CFBundleIdentifier` through `InOwnTmux`'s `env` (tmux sets the rest);
   herdr's server is started from a fake iTerm2 tab, so its panes inherit both.
9. **Steps** (each with its spec): `iterm.tab {window, tab}` and `iterm.split {window, tab, split}` open an empty
   shell (a session's start opens its own when none is); `iterm.closeTab {window, tab}` ends the tab's shells and all
   under them with no hook: Orca's `dropSession` (async, one session, throws for one not running) for each tab session
   there, its login among its `Live.others`; the step ends the rest itself (an empty shell, a tmux or herdr client),
   while an agent in that multiplexer runs on under its server (see Open question 2); `iterm.select {window, tab, split?}` the watch's
   tab report; `iterm.relaunch` ends iTerm2's process, starts none, and leaves the server under launchd, every session
   running; `tmux.detach {session}` ends every client of that session's tmux session; `tmux.attach {session, window,
   tab}` adds a client in that tab, used now; `tmux.selectPane {session}` and `herdr.focus {session}` are the person's own
   pane moves (recorded as no devices command); `herdr.restart` ends the server, its clients and agents with no hook, then
   a new client in the same tab, a new server and each herdr session started again on a new pane with its start hook and
   herdr's report; `devices.restart` stops the devices and starts them on the same root, sessions and dial.
10. **`open` of an iTerm2 row**, its input the first tap or swipe on the session in the window: `tab` (a select on the
    tabs stream naming `check.tab ?? its own tab`, with `raise` on a tap and without on a rest, and no select naming
    another tab in the window); `front`, a tap only (an `open -b com.googlecode.iterm2` that succeeded); `pane`, tmux and
    herdr only (a tmux run holding `select-pane -t pane:<key>`, or `herdr agent focus pane:<key>`, that succeeded, and no
    pane select of another session); `noRaise`, a rest only (no front, no select with raise); `latency`, a tap only (to
    the latest of the parts above). Order between them is not graded (Open question 3). A row the dial was never sent
    scores 0 on every part. `Check.open` gains `tab?: string`: the label a select must name when the session's client
    moved (I13, IH2).
11. **Inputs.** `iterm.select`, `tmux.selectPane` and `herdr.focus` are the person's inputs in `catalog.spec.ts`'s rule;
    I9 and IH1 join its quick set (their point is a short gap).
12. **I9's echo** (the spec's "the dial selects a tab, and iTerm2 reports that tab back"): the dial rests on b, then on
    a; iTerm2's late report of b's tab must not pull it back to b. A report of the tab the dial is already on could not
    fail visibly.
13. **Scan-found scenarios** (I3, I15, IH4) give each session a turn before the restart (`turned`), so tier B's scan
    finds its conversation on disk, as `dialTmuxTerminal.e2e.ts`'s `foundByScan` does.
14. **Tier B commands.** A recording `tmux` wrapper first on every eval daemon's PATH (`openRig`) and the daemon's
    `herdr` wrapper (`herdrServer.ts`) run the real program as their child and note the runs the devices make (tmux's
    `display-message`, `list-clients`, `list-panes`, `select-window`, `switch-client`; herdr's `agent`), in Orca's run-log
    form: its writer (the fake Orca launcher's shell `note()`) and its reader (`FakeOrca.log()`) move to
    `e2e/harness/runLog.ts`, and the fake Orca uses both from there; any other run `exec`s the real program untouched.
    The world reads them once as it stops, as `appEvalDriver.ts` `takeOrca` reads the fake Orca's, as commands with
    panes named by key. `ownHerdrsOnly` is on every eval daemon.
15. **No walk reaches this machine's terminal (tier B).** Plain tabs run under the fake iTerm2's server; tmux's private
    server is a daemon; herdr's private server is started by its first client in a fake iTerm2 tab (`PrivateHerdr.startIn`),
    so its panes' parents end at the fake bundle, never at this worker.
16. **The iTerm2 e2e file writes `results-b-iterm.json` on every host**, empty off macOS, so `npm run eval:dial-apps` on
    Linux does not lose a results file.
17. **`ci-plan.py`:** `cli/e2e/dialAppEvalIterm.e2e.ts` joins `LINUX_E2E_NEVER` (macOS only) and stays out of
    `LINUX_E2E_APP_EVAL_FILES`; a change to `appEvalIterm.ts` still runs the Linux eval files through `appEval*.ts`.
18. **Scaffolding.** Task 2 adds the new step kinds with tier A handlers that throw `tier A: the <kind> step is not built
    yet` and narrows `catalog.spec.ts`'s kind-coverage case to kinds some scenario uses; Tasks 4–7 replace the throws;
    Task 17 restores the case over every kind but `wait` and `stroke` (as on `main`) and checks none is left.
19. **I16's long turn** is 30 s, past the firmware's 25 s fuse, so the devices' 20 s reminder is on its path.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | After the rebase: reconcile this plan with Orca's merged code | high | - (Orca merged) |
| 2 | iTerm2 in the contract, the grader and the report | high | 1 |
| 3 | iTerm2's records: tab labels and panes named by session | medium | 2 |
| 4 | Tier A: iTerm2, its tabs and the watch's tabs stream, and the 60 s budget | xhigh | 2, 3 |
| 5 | Tier A: tmux inside iTerm2 | high | 4 |
| 6 | Tier A: herdr inside iTerm2 | xhigh | 4 |
| 7 | Tier A: the devices start again | xhigh | 5, 6 |
| 8 | Checks: `open` of an iTerm2 row by its place | high | 2, 3 |
| 9 | Catalog: iTerm2, I1–I21 | high | 7, 8 |
| 10 | Catalog: iTerm2's held-out set, IH1–IH5 | high | 9 |
| 11 | The eval command runs the iTerm2 tier B file | medium | 1 |
| 12 | Tier B harness: the fake iTerm2 and herdr started from its tab | xhigh | 1 |
| 13 | Tier B driver: the watch's selects, tab reports, recording wrappers, the devices' restart | xhigh | 2, 3 |
| 14 | Tier B: iTerm2 | xhigh | 9, 11, 12, 13 |
| 15 | Tier B: iTerm2's held-out scenarios | high | 10, 14 |
| 16 | `ci-plan.py`: the iTerm2 file is macOS only | high | 1 |
| 17 | The baseline | xhigh | 10, 11, 14, 15 |

Files more than one task touches (devcrew runs those tasks one at a time): `types.ts` (2), `catalog.ts` (4, 9),
`catalog.spec.ts` (2, 9, 10, 17), `tierA/machine.ts` (4, 5, 6), `tierA/world.ts` (4, 5, 6, 7), `tierA/world.spec.ts` (7),
`tierA/driver.ts` (2, 4, 5, 6, 7), `tierA/steps/sessions.ts` and its spec (4, 5, 6), `tierA/steps/iterm.ts` and its spec
(4, 7), `dialAppEval.spec.ts` (4, 5, 6, 7), `heldOut.ts` (10), `e2e/harness/appEvalDriver.ts` (2, 13),
`e2e/harness/herdrServer.ts` (12, 13), `e2e/harness/appEvalIterm.ts` (14, 15), `e2e/dialAppEvalIterm.e2e.ts` (12, 14),
`e2e/harness/appEvalClaude.ts` (14), `e2e/harness/codexOutside.ts` and `ownTmux.ts` (15). No task edits another app's
catalog file: one that finds an entry wrong reports it.

Longest chain: 1 → 2 → 3 → 4 → 5 → 7 → 9 → 14 → 15 → 17 (ten tasks; 6 in place of 5, or 10 in place of 14, is as long).

---

## Before any code

### Task 1: After the rebase: reconcile this plan with Orca's merged code

**Files:** Modify `docs/plans/2026-11-22-dial-eval-iterm2-plan.md`; commit it with
`docs/plans/2026-11-22-dial-eval-iterm2-design.md`. **Depends on:** Orca's pull request merged to `main` (the main session
says so). **Effort:** high. No behaviour change: one commit, no failing test.

- [x] **Step 1:** `git fetch origin && git rebase origin/main` (the branch's one docs commit, the spec and this plan,
  replays onto `main`).
- [x] **Step 2:** Check each row of "Sequencing and the Orca contract" on `main` (`git grep` each symbol). Where the merged
  code differs (a name, a shape, a file, the held-out and main counts, the tmux model, the run log's form or reader), edit
  every task of this plan that names it, and add a closing section "Reconciled with Orca's merge" listing each change.
- [x] **Step 3:** A piece this plan builds on that is missing on `main` (Orca's tmux process model, `FRONT_NAMES`,
  `dropSession`, the run log): stop and return to the main session; do not rebuild it here.
- [x] **Step 4:** Fold the edits into the branch's docs commit: `git add docs/plans/2026-11-22-dial-eval-iterm2-design.md
  docs/plans/2026-11-22-dial-eval-iterm2-plan.md && git commit --amend -m "Dial eval for iTerm2: spec and plan"`, so the
  branch is one docs commit on `main`.

## Foundations

### Task 2: iTerm2 in the contract, the grader and the report

**Files:** Modify `cli/src/testing/dialAppEval/types.ts`, `types.spec.ts`, `grade.spec.ts`, `report.ts`, `report.spec.ts`,
`catalog.spec.ts` (`stepKeys`, `sees`, the kind-coverage case), `tierA/driver.ts` (the stubs), `tierA/steps/window.ts`
(the front's name through `frontName`) and `window.spec.ts` (its every-app, every-platform front case),
`cli/e2e/harness/appEvalDriver.ts` (`GENERIC.front`, the same). **Depends on:** 1. **Effort:** high.

**Interfaces:** Produces (beside what `types.ts` has after Orca):

```ts
export type App = 'claude' | 'chatgpt' | 'vscode' | 'cursor' | 'orca' | 'iterm'
export const APPS: readonly App[]                       // the six, iTerm2 last
// PAGE gains iterm: 'iterm'
export type LinkedApp = Exclude<App, 'orca' | 'iterm'>
/** Where an iTerm2 session runs (Decision 1). */
export type ItermPlace = 'tab' | 'tmux' | 'herdr'
// SessionDef: place?: Place | ItermPlace; window/tab/split doc-commented for iTerm2 too (Decision 1; tab and split
//   say "Orca only" on main);
//   herdrSession?: false   /** herdr's row gives no session id (IH4). */
// FRONT_NAMES.darwin gains iterm: 'com.googlecode.iterm2'; Linux and Windows have no iTerm2 entry: its type, on main
//   Record<Platform, Record<App | 'other', string>>, becomes one that lets an app be missing on a platform
/** The app's front name on the platform; throws `<app> has no front name on <platform>` for one it has none on. */
export function frontName(platform: Platform, app: App | 'other'): string
/** An iTerm2 session's place, `tab` when unset; undefined for every other app. */
export function itermPlaceOf(s: Pick<SessionDef, 'app' | 'place'>): ItermPlace | undefined
// STEP_KINDS gains, with these Step members (doc-commented from Decision 9):
//   | { kind: 'iterm.tab'; window: string; tab: number } | { kind: 'iterm.split'; window: string; tab: number; split: number }
//   | { kind: 'iterm.closeTab'; window: string; tab: number } | { kind: 'iterm.select'; window: string; tab: number; split?: number }
//   | { kind: 'iterm.relaunch' } | { kind: 'tmux.detach'; session: SessionKey }
//   | { kind: 'tmux.attach'; session: SessionKey; window: string; tab: number } | { kind: 'tmux.selectPane'; session: SessionKey }
//   | { kind: 'herdr.focus'; session: SessionKey } | { kind: 'herdr.restart' } | { kind: 'devices.restart' }
// Check open gains: tab?: string   // Decision 10
// Seen.streams' doc names the watch's tabs stream too (Decision 3)
```

- `owned()` also refuses an iTerm2 place on another app's session, an editor place or `tmux: true` on an iTerm2 one.
- `report.ts` names iTerm2 `iTerm2`, after Orca; its Not covered line is unchanged.
- `windowSteps.front` and the tier B watch's front line take `frontName(platform, app)`.
- `tierA/driver.ts` gets a handler per new step kind that throws `tier A: the <kind> step is not built yet`.
- `catalog.spec.ts`: `stepKeys` names the `session` of `tmux.detach`, `tmux.attach`, `tmux.selectPane`, `herdr.focus`;
  `sees` gains `iterm.tab: ['ring', 'open']`, `iterm.split: ['ring', 'open']`, `iterm.closeTab: ['ring']`, `iterm.select:
  ['focus']`, `iterm.relaunch: ['ring', 'open']`, `tmux.detach: ['ring', 'open']`, `tmux.attach: ['ring', 'open']`,
  `tmux.selectPane: ['focus']`, `herdr.focus: ['focus']`, `herdr.restart: ['ring']`, `devices.restart: ['ring', 'open']`;
  the kind-coverage case iterates only kinds some scenario uses (Decision 18).

- [ ] **Step 1: Failing tests.** `types.spec.ts`: `APPS is the six apps, iTerm2 last`; `PAGE names iTerm2's page iterm`;
  `iTerm2's macOS front name maps through frontAppId to iterm, and frontName throws for iTerm2 on Linux and Windows`;
  `every app but Orca and iTerm2 maps through frontAppId to its own page from its front name on every platform; Orca's
  macOS name maps to orca` (main's `every app but Orca maps …` case, narrowed); `window.spec.ts`: `the front step tells
  the listener what frontAppId makes of the platform's own front name, for each app and platform it has one on, Orca's
  and iTerm2's included` (main's case, iTerm2 on darwin alone);
  `itermPlaceOf is tab by default and undefined off iTerm2`; `an iTerm2 place on a VS Code session, an editor place or
  tmux: true on an iTerm2 session, are refused`. `grade.spec.ts`: `iTerm2 is scored from its own results, the other five
  untouched`. `report.spec.ts`: `the score and held-out tables have a row for iTerm2, after Orca`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/types.spec.ts src/testing/dialAppEval/grade.spec.ts
  src/testing/dialAppEval/report.spec.ts src/testing/dialAppEval/tierA/steps/window.spec.ts` → FAIL.
- [ ] **Step 3:** Implement the list above.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts` → PASS,
  `matches the baseline` included (no result moved); `npm run typecheck`.
- [ ] **Step 5:** Commit red, then green.

### Task 3: iTerm2's records: tab labels and panes named by session

**Files:** Create `cli/src/testing/dialAppEval/itermRecords.ts`, `itermRecords.spec.ts`. **Depends on:** 2. **Effort:** medium.

**Interfaces:** Produces (Decisions 2 and 3), pure, for both tiers and the checks:

```ts
export const TABS_STREAM = 'tabs'
export interface TabRef { window: string; tab: number; split?: number }
export function tabLabel(ref: TabRef): string                                  // `w1.1.0`; split 0 when unset
/** The tab an iTerm2 session's select names: its own tab and split, or for tmux and herdr its client's tab (split 0). */
export function sessionTab(s: Pick<SessionDef, 'place' | 'window' | 'tab' | 'split'>): string
/** A tmux or herdr command's arguments with each pane id (`%N`, herdrClient.ts HERDR_PANE) written `pane:<key>`,
 *  `pane:other` for one keyOf names none; every other argument as it is. */
export function namedPanes(argv: readonly string[], keyOf: (pane: string) => SessionKey | undefined): string[]
/** A select the devices wrote on the tabs stream as recorded: its tty as its tab's label, `other` for none. */
export function selectRecord(line: { app: string; tty: string; raise?: boolean },
  labelOf: (tty: string) => string | undefined): { app: string; tab: string; raise?: true }
```

- [ ] **Step 1: Failing tests** in `itermRecords.spec.ts`: `a tab's label is window.tab.split, split 0 by default`; `a tmux
  or herdr session's tab is its client's, split 0`; `namedPanes writes %3 and w1:p2 as their sessions' keys and an
  unknown one as pane:other, and leaves formats, session names and other arguments as they are`; `selectRecord names the
  tab by label, other for an unknown tty, and keeps raise only when true`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/itermRecords.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

## Tier A

### Task 4: Tier A: iTerm2, its tabs and the watch's tabs stream, and the 60 s budget

The first tier A task that runs an iTerm2 scenario: it measures against the 60 s budget before any catalog entry lands.

**Files:** Create `cli/src/testing/dialAppEval/tierA/steps/iterm.ts`, `tierA/steps/iterm.spec.ts`; Modify `tierA/machine.ts`,
`tierA/steps/sessions.ts`, `tierA/steps/sessions.spec.ts`, `tierA/world.ts`, `tierA/driver.ts`, `catalog.ts` (builders
only), `dialAppEval.spec.ts`. **Depends on:** 2, 3. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 2's contract; Task 3's `tabLabel`, `sessionTab`, `selectRecord`.
- Produces:
  ```ts
  // machine.ts
  itermHome?: string           // set by an iTerm2 scenario's world; the learnApps mock walks scannedApps there (Decision 4)
  installed: Map<string, string>     // program → made-up path on this machine (tmux, herdr: Tasks 5 and 6); reset empties it
  atimes: Map<string, number>        // each tty's last access (bare name), at virtual time
  // world.ts: TierAWorld gains
  readonly panes: Map<string, SessionKey>   // each tmux and herdr pane the models open, by id (Tasks 5 and 6); ran()
                                            // records a tmux or herdr command through namedPanes with it
  // catalog.ts
  export function itermSession(key: SessionKey, more?: Partial<SessionDef>): SessionDef      // Decision 1
  export const itermGhost: SessionDef                                                        // key z, ghost
  export function turned(keys: SessionKey[]): Step[]   // each a turn-start, a 1 s wait, a turn-stop (Decision 13)
  // tierA/steps/iterm.ts: tier A's iTerm2
  export const itermSteps: { [K in 'iterm.tab' | 'iterm.split' | 'iterm.closeTab' | 'iterm.select' | 'iterm.relaunch']: StepHandler<K> }
  /** The watch's tabs stream, opened on the devices' own handler (world.listener.tabs) with a recording stream. */
  export function openTabs(world: TierAWorld): void
  /** A tab's or split's shell, opened (login, shell, tty) when none is. */
  export function tabShell(world: TierAWorld, ref: TabRef): { pid: number; tty: string }
  export function labelOf(world: TierAWorld, tty: string): string | undefined
  export function selectedTab(world: TierAWorld): TabRef | undefined     // the last iterm.select
  ```
- `sessions.ts`: an iTerm2 tab session's agent runs under `tabShell`, hooks with Decision 8's tab hints; a tmux or herdr
  one throws `tier A: an iTerm2 session in <place> is not built yet` until Tasks 5 and 6. Its private `startProcess` and
  `nextTty` (Orca's) are exported for `iterm.ts`, `tmux.ts` and `herdr.ts`: one pid count and one tty count per world.
  A tab's login joins its session's `Live.others`, so `dropSession` ends it.
- `world.ts`: `deps.tty` answers `/dev/` + the model's tty; an iTerm2 scenario sets `machine.itermHome` to its root.
- `driver.ts`: registers `itermSteps`; an iTerm2 scenario's start runs `openTabs` before the dial is plugged; its
  header's `process.platform` list adds the reads on iTerm2's paths (`tabs.ts`, `scannedApp.ts`, `hostDetect.ts`): each a
  dep, or a `world.gap` where one decides a check.
- `dialAppEval.spec.ts`: the `learnApps` mock answers by `machine.appOf`, then for the rest, on a machine with
  `itermHome`, by the real `scannedApps(pids, { platform: 'darwin', roots: appRoots(home), processes: <the model's rows>,
  bundleId: <machine.bundleIds>, home })`.

- [ ] **Step 1: Failing tests.** `iterm.spec.ts` (a fake world whose listener records): `a tab's agent runs under its
  shell, under login, under iTerm2's server, under iTerm2, all on the tab's tty`; `a split is a shell of its own on a tty
  of its own in the same tab`; `openTabs opens the devices' tabs stream, and each select they write is recorded naming
  its tab by label, other for a tty no tab holds`; `iterm.select tells the listener {type: tab, app: iterm, tty:
  /dev/ttysNNN} and records it by label`; `a refused tab report throws`; `iterm.closeTab ends its shells and all under
  them, with no hook`; `iterm.relaunch ends iTerm2's process and leaves its server under launchd with every shell
  running`; `the devices read a tab's tty as /dev/ttysNNN and the table's as ttysNNN`. `sessions.spec.ts`: `a Claude Code in
  an iTerm2 tab hooks with TERM_PROGRAM=iTerm.app and iTerm2's bundle id`; `the other apps' hooks, hints and processes
  are as before`. `dialAppEval.spec.ts` (inline `scenario()`s of Task 9's rows, asserted on `driver.seen()`): `the walk
  names a plain tab's agent iterm by iTerm2's server, under iTerm2 and under launchd` (the mocked `learnApps`); `I5 on
  darwin: a tap on b runs open -b com.googlecode.iterm2 and writes b's select with raise on the tabs stream, and none for
  another tab`; `I8: b's tab selected with iTerm2 settled in front turns the dial to b within 1 s`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/ src/testing/dialAppEval/dialAppEval.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included; typecheck.
- [ ] **Step 5: Measure.** The tier A spec's wall time at this head (its Vitest duration); the inline I5 on darwin five
  times (`-t`); a 20-tab inline case (IH3's row) once. Project `spec + 25 × max(I5) + the 20-tab case` (26 iTerm2 runs in
  tier A, darwin alone). Record the numbers in the commit message and the report.
- [ ] **Step 6: Budget.** Over 60 s: stop and report the numbers to the main session; which scenarios leave tier A is the
  PM's call.
- [ ] **Step 7:** Commit red, then green.

### Task 5: Tier A: tmux inside iTerm2

**Files:** Create `cli/src/testing/dialAppEval/tierA/steps/tmux.ts`, `tierA/steps/tmux.spec.ts`; Modify `tierA/machine.ts`,
`tierA/steps/sessions.ts`, `tierA/steps/sessions.spec.ts`, `tierA/world.ts`, `tierA/driver.ts`, `dialAppEval.spec.ts`.
**Depends on:** 4. **Effort:** high.

**Interfaces:**
- Consumes: Task 4's `tabShell`, `selectedTab`, `labelOf`, `machine.installed`, `machine.atimes`, `world.panes`,
  `startProcess`, `nextTty`; Orca's tmux process model, the `s.tmux` branch of `sessions.ts`'s private `orcaPane`, which
  this task moves into `tmuxPane` (Decision 5).
- Produces:
  ```ts
  // tierA/steps/tmux.ts
  export const tmuxSteps: { [K in 'tmux.detach' | 'tmux.attach' | 'tmux.selectPane']: StepHandler<K> }
  export function answerTmux(world: TierAWorld): void                       // Decision 5's rules
  export function tmuxPane(world: TierAWorld, s: SessionDef): { shell: number; tty: string; pane: string }
  /** Decision 6, before a tmux session's turn-start hook. */
  export function typedThrough(world: TierAWorld, key: SessionKey): void
  ```
- `world.ts`: `ANSWERED` gains `tmux`; an iTerm2 scenario's world sets `machine.installed` (`tmux`) and calls `answerTmux`.
- `dialAppEval.spec.ts`: `ensureTmuxOnPath` answers `{ state: 'adopted', path: machine.installed.get('tmux'), from:
  'standard install location' }` when the machine has tmux, else today's `absent`.
- `sessions.ts`: a tmux session's agent runs under `tmuxPane`'s shell with Decision 8's tmux hints (a Codex under the
  daemon's `CODEX_HOME`, as today by engine); its `turn-start` runs `typedThrough` first. `orcaPane`'s tmux branch calls
  `tmuxPane` too, its client under the Orca pane's shell; Orca's hint keeps `TMUX_PANE` `%<index>`, the model's pane id.

- [ ] **Step 1: Failing tests.** `tmux.spec.ts` (a fake world): `the server is launchd's child on no tty; each pane's shell
  is its child on a tty of its own; each client runs under its tab's shell on that tab's tty`; `display-message,
  list-clients in both formats and list-panes answer from the model; a format name the model does not know is a gap`;
  `select-window ; select-pane makes the pane its window's active one, and is recorded with the pane as pane:<key>`;
  `switch-client moves that client`; `tmux.detach ends the session's clients; tmux.attach adds one in its tab, used now`;
  `tmux.selectPane moves the active pane and records no command`; `a turn-start while the selected tab holds a client of
  the session moves that client's activity and its tty's atime, and with none selected moves nothing`.
  `sessions.spec.ts`: `a Claude Code in tmux hooks with TERM_PROGRAM=tmux, its TMUX_PANE and iTerm2's bundle id`; `a Codex
  in tmux writes its rollout under the daemon's CODEX_HOME`; main's Orca case `under tmux its hook adds TMUX_PANE, and its
  agent runs under a tmux server` passes on the moved model on darwin and linux, its server read by basename (it expects
  the bare `tmux` today), and its drop case (`a drop or Orca's quit ends every process of the pane`) unchanged. `dialAppEval.spec.ts`: `tmux is found on an iTerm2
  scenario's machine alone` (C1's devices run no tmux); `I6 inline: a rest on the tmux row with iTerm2 in front writes its
  client's tab select without raise and runs select-window ; select-pane for its pane`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/ src/testing/dialAppEval/dialAppEval.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 6: Tier A: herdr inside iTerm2

**Files:** Create `cli/src/testing/dialAppEval/tierA/steps/herdr.ts`, `tierA/steps/herdr.spec.ts`; Modify `tierA/machine.ts`,
`tierA/steps/sessions.ts`, `tierA/steps/sessions.spec.ts`, `tierA/world.ts`, `tierA/driver.ts`, `dialAppEval.spec.ts`.
**Depends on:** 4. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 4's `tabShell`, `selectedTab`, `machine.installed`, `machine.atimes`, `world.panes`, `startProcess`,
  `nextTty`; Orca's `dropSession` (awaited for each herdr session at `herdr.restart`; the server and clients the step
  ends itself). Decision 6 for a herdr session is this task's own: its `turn-start` typed through the selected tab's
  herdr client moves that client's tty's access time first.
- Produces:
  ```ts
  // machine.ts
  socketWatches: Set<() => void>        // what the watchSocket mock was handed, until each stop
  // tierA/steps/herdr.ts
  export const herdrSteps: { [K in 'herdr.focus' | 'herdr.restart']: StepHandler<K> }
  export function herdrClient(world: TierAWorld): HerdrClient            // Decision 7
  export function answerHerdr(world: TierAWorld): void   // lsof -F pdn, /bin/ps -o pid=,tty=, herdr agent focus
  export function herdrPane(world: TierAWorld, s: SessionDef): { shell: number; tty: string; pane: string }
  /** A herdr session's hook, as herdr sees its agent: its status told to the subscriptions naming its pane. */
  export function herdrHeard(world: TierAWorld, key: SessionKey, event: StepOf<'hook'>['event']): void
  ```
- `world.ts`: `ANSWERED` gains `herdr`, `lsof`, `ps`; an iTerm2 scenario's world installs herdr, hands `deps.herdr`
  `herdrClient(this)` and calls `answerHerdr`; the `orca` deps' `onPath` (on `main` the constant `ON_PATH[platform]`,
  empty on darwin, so it finds nothing on macOS today) finds `herdr` where `machine.installed` says, before that table. `ANSWERED` is matched by `argv.ts` `programOf` (the
  basename, `.exe` dropped), so `/bin/ps` is `ps`.
- `dialAppEval.spec.ts`: mocks `../../cable/hosts/herdrOuter.js` (`ttyAtime(tty)` answers `machine.atimes` of the bare
  name); the `watchSocket` mock adds each watch to `machine.socketWatches` and its stop removes it.

- [ ] **Step 1: Failing tests.** `herdr.spec.ts`: `the server is its first client's child on no tty, each pane's shell its
  child on a tty of its own, each client under its tab's shell`; `agent.list answers each live herdr session's pane,
  status, folder and session, with no session for herdrSession false and no name`; `a subscription hears each status
  change of a pane it names, and closes when the server ends`; `a prompt to a session's pane is a typed delivery to it,
  and to none for a pane no session holds`; `the gate counts a prompt to the other pane, and one to a pane no session
  holds, as wrong-session sends` (through `checks.ts` `wrongSends`); `lsof names each client connected to the server's
  client socket and ps their ttys`; `herdr agent focus answers 0 and is recorded with its pane as pane:<key>`;
  `herdr.focus records no command`; `herdr.restart ends the server, its clients and agents with no hook, then starts each
  session again on a new pane with its start hook and fires every socket watch`; `ttyAtime answers the model's access
  time`. `sessions.spec.ts`: `a Claude Code in herdr hooks with HERDR_PANE_ID, TERM_PROGRAM=iTerm.app and iTerm2's bundle
  id`. `dialAppEval.spec.ts`: `I7 inline: a tap on a herdr row runs herdr agent focus for its pane and open -b iTerm2, and
  writes its client's tab select with raise`; `every scenario but iTerm2's keeps noHerdr: C1's devices ask no herdr`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/steps/ src/testing/dialAppEval/dialAppEval.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 7: Tier A: the devices start again

**Files:** Modify `cli/src/testing/dialAppEval/tierA/world.ts`, `tierA/world.spec.ts`, `tierA/driver.ts`, `tierA/steps/iterm.ts`,
`tierA/steps/iterm.spec.ts`, `dialAppEval.spec.ts`. **Depends on:** 5, 6. **Effort:** xhigh.

**Interfaces:**
- Consumes: Tasks 4–6's models; `openTabs`.
- Produces: `World.restartDevices(): Promise<void>` (the devices stopped on virtual time and started again on the same
  root, deps, sessions and dial); `driver.ts`'s `devices.restart` step: `restartDevices`, then a bounded wait
  (`START_WITHIN_MS`) for the dial's next welcome (it fails the step naming it), then `openTabs` again for an iTerm2
  scenario, as the watch opens its stream again. No `not built yet` step is left in `driver.ts`.

- [ ] **Step 1: Failing tests.** `world.spec.ts`: `restartDevices stops the devices and starts them on the same root,
  dial and sessions`. `iterm.spec.ts`: `after a restart the tabs stream is open on the new devices' handler`.
  `dialAppEval.spec.ts` (inline): `I3: the four of I2, each with a turn behind it, are on iTerm2's page after the devices
  start again, before any hook, and on no tmux, herdr or Other page`; `after the devices start again the mod polls the
  new devices: a voice reaches its session`; `I2 twice gives the same frames, streams, commands and deliveries at the same
  virtual times`, and the same for I3 across its restart; `no result carries an absolute path, a tty or a pane id` (the
  file's case, extended with `/dev/tty`, `ttys0`, `%0`, `:p1`).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/tierA/ src/testing/dialAppEval/dialAppEval.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 8: Checks: `open` of an iTerm2 row by its place

**Files:** Modify `cli/src/testing/dialAppEval/checks.ts`, `checks.spec.ts`. **Depends on:** 2, 3. **Effort:** high.

**Interfaces:** Produces `open` for an iTerm2 row (Decision 10), reading `Seen.streams` of window `TABS_STREAM` and
commands with panes named by key (Decision 2), by `itermPlaceOf` and `sessionTab`. Evidence names keys, labels and times:
`select at <t>: <label>[ raise]`, a command as its kind (`front`, `pane`, `failed`, `other`), the inputs as today.

- [ ] **Step 1: Failing tests** (hand-made `Seen`), a pass, a fail and a latency case each where timed: `a tap on a tab
  row passes on iTerm2 brought forward and its tab's select with raise`; `a select of its split's sibling, or one more
  select of another tab in the window, fails tab`; `a select without raise fails a tap's tab, and one with raise fails a
  rest's`; `a rest has tab and noRaise and no latency, and an open -b in the window fails noRaise`; `a tmux row also
  needs select-window ; select-pane for pane:<key> that succeeded, and fails on one for another session's pane or one
  that failed`; `a herdr row also needs herdr agent focus for pane:<key>`; `with check.tab the select must name that tab,
  not the session's own`; `latency is to the latest of the passing parts, null when one fails`; `an iTerm2 row the dial
  was never sent scores 0 on every part`; `no evidence holds a tty, a pane id or a tmux session name`; `the other apps'
  checks score as before` (one case per kind from the current spec, unchanged).
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/checks.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → PASS, `matches the baseline` included; typecheck.
- [ ] **Step 5:** Commit red, then green.

## Catalog

Rows below use: `a(0)` `itermSession('a', { tab: 0 })`, a Claude Code in w1's tab 0; `a(0.1)` its split 1; `b(tmux 1)` in
tmux, its client in tab 1 (`d(tmux 1.1)` the second pane of that window); `c(herdr 2)`, `d(herdr 2.1)` the first and
second herdr panes of tab 2's client; "started k…" the catalog's `started` (a second apart, the last newest); "turned
k…" `turned`; "listed […]" `listed('iterm', […])`; "select N" `iterm.select` w1 tab N; "restart" `devices.restart`.
Every scenario is `platforms: ['darwin']`, both tiers unless named, declares `itermGhost` (`z`), and gets its `cost` check
in tier B from `scenario()`. Rings are on `iterm` with `apart: []` unless named. Probes name `z`.

### Task 9: Catalog: iTerm2, I1–I21

**Files:** Create `cli/src/testing/dialAppEval/itermScenarios.ts` (`export function itermScenarios(): Scenario[]`, a
function as `heldOut()` and `orcaScenarios()` are), `itermScenarios.spec.ts` (as `orcaScenarios.spec.ts`); Modify
`catalog.ts` (`MAIN` spreads it after `...orcaScenarios()`), `catalog.spec.ts` (its enumerations on `main`: `the main ids
are C1-C12, X1-X11, V1-V15, U1-U14 and O1-O17` gains I1-I21; the own waits; the inputs rule's `inputs` and `quick`
(`X11`, `XH3`, `OH2`) sets (Decision 11); `X3, V11 and UH1 are macOS only`, which holds every other scenario to all three
platforms, gains every I scenario). **Depends on:** 7, 8. **Effort:** high.

| Id | Sessions and steps (labels in quotes) | Checks | Probe |
|---|---|---|---|
| I1 | a(0). Started a | ring D1 [a] | ring + z |
| I2 | a(0), b(tmux 1), c(herdr 2), d(herdr 2.1). Started d c b a | ring D1 [a b c d] | ring + z |
| I3 | As I2. Started d c b a; turned d c b a; listed [a b c d]; "restart": restart | ring D1 [a b c d] after restart; ringKept D7 [a b c d] after restart | ring + z after restart |
| I4 | a(0), b(0.1). Hook start a; wait 1 s; "split": iterm.split w1 0 1; wait 1 s; hook start b; listed [b a]; "tapA": tap a; wait 2 s; "tapB": tap b | ring D1 [b a]; open D3 a after tapA at tapB; open D3 b after tapB | open z after tapB |
| I5 | a(0), b(1). Started b a; listed [a b]; "tap": tap b | open D3 b after tap | open z |
| I6 | a(0), b(tmux 1). Started b a; listed [a b]; "rest": swipe b; wait 2 s | open D3 b after rest | open z after rest |
| I7 | a(0), c(herdr 1), d(herdr 1.1). Started d c a; listed [a c d]; "tapC": tap c; wait 2 s; "tapD": tap d | open D3 c after tapC at tapD; open D3 d after tapD | open z after tapD |
| I8 | a(0), b(1). Started b a; listed [a b]; "select": select 1 | focus D2 b after select | focus z after select |
| I9 | a(0), b(1). Started b a; listed [a b]; "toB": swipe b; wait 1 s; "toA": swipe a; wait 500; "echo": select 1; wait 3 s | focus D2 a noBounce after toA (`echo`); still D7 3000 after echo | focus z after toA |
| I10 | a(tmux 0), b(tmux 0.1). Started b a; listed [a b]; "select": select 0; wait 2 s; "pane": tmux.selectPane b | focus D2 b after pane | focus z after pane |
| I11 | c(herdr 0), d(herdr 0.1). Started d c; listed [c d]; "select": select 0; wait 2 s; "pane": herdr.focus d | focus D2 d after pane | focus z after pane |
| I12 | a(0), b(1), c(2). Started b a; listed [a b]; "close": iterm.closeTab w1 1; listed [a]; "new": iterm.tab w1 2; hook start c; listed [c a] | ring D1 timed [a] after close at new (`closed`); ring D1 timed [c a] after new (`added`); ringKept D7 [c a] after new | ring + z after new |
| I13 | a(0), b(tmux 1). Started b a; listed [a b]; "detach": tmux.detach b; wait 2 s; iterm.tab w1 2; "attach": tmux.attach b w1 2; wait 2 s; "tap": tap b | ringKept D7 [a b] after attach at tap; open D3 b tab `w1.2.0` after tap | open z after tap |
| I14 | a(0), c(herdr 1), d(herdr 1.1). Started d c a; listed [a c d]; "restart": herdr.restart; listed [a c d] | ring D1 [a c d] after restart; ringKept D7 [a c d] after restart | ring + z after restart |
| I15 | a(0), b(tmux 1), c(herdr 2). Started c b a; turned c b a; listed [a b c]; "relaunch": iterm.relaunch; wait 2 s; "restart": restart; listed [a b c]; "tapB": tap b; wait 2 s; "tapC": tap c | ring D1 [a b c] after restart at tapB; ringKept D7 [a b c] after restart at tapB; openKept D7 b after tapB at tapC; openKept D7 c after tapC | ring + z after restart |
| I16 | a(0). Started a; listed [a]; "turn": hook turn-start a; wait 30 s; "stop": hook turn-stop a `Eval answer one.` | state D4 working after turn at stop; state D4 done after stop; recap D6 a after stop | recap z after stop |
| I17 | b(tmux 0). Started b; listed [b]; "turn": hook turn-start b; wait 2 s; "ask": hook needs-input b permission | state D4 needs-you after ask | state z needs-you after ask |
| I18 | a(0), b(1). Started b a; listed [a b]; "voice": `Eval words for alpha.` → a | voice D5 a | voice z |
| I19 | a(0), b(tmux 1). Started a b; listed [b a]; "voice": `Eval words for bravo.` → b | voice D5 b | voice z |
| I20 | c(herdr 0), d(herdr 0.1). Started c d; listed [d c]; swipe c; wait 1 s; "voice": `Eval words for charlie.` → c | voice D5 c | voice z |
| I21 | a(0), b(tmux 1), c(herdr 2). Started c b a; listed [a b c]; swipe b; wait 1 s; "unplug"; wait 3 s; "replug"; listed [a b c] | ringKept D7 [a b c] after replug; focusKept D7 b after replug | ring + z after replug |

- [ ] **Step 1: Failing tests** in `itermScenarios.spec.ts`: `iTerm2's main ids are I1-I21, none held out, 21`; `every I
  scenario runs on darwin alone, in both tiers`; `each I scenario's checks cover exactly the spec's dims` (I1 I2 D1; I3 D1
  D7; I4 D1 D3; I5 I6 I7 D3; I8 D2; I9 D2 D7; I10 I11 D2; I12 D1 D7; I13 D7 D3; I14 I15 D7 D1; I16 D4 D6; I17 D4; I18 I19
  I20 D5; I21 D7; plus D8 in tier B); `no two sessions of a scenario share a tab, a split or a multiplexer pane`; `I13's
  open names the new client's tab`; `I3, I15 and IH4's sessions have a turn before their restart`. In `catalog.spec.ts`,
  its extended enumerations.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/itermScenarios.spec.ts src/testing/dialAppEval/catalog.spec.ts`
  → FAIL.
- [ ] **Step 3:** Write the scenarios.
- [ ] **Step 4:** Same → PASS; `npx vitest run src/testing/dialAppEval/` → every I scenario in tier A runs with no error, no
  wrong send and its probe caught (the failures the spec predicts are not asserted); a wrong send stops the task: report
  it. Typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 10: Catalog: iTerm2's held-out set, IH1–IH5

**Files:** Modify `cli/src/testing/dialAppEval/heldOut.ts`, `catalog.spec.ts`. **Depends on:** 9. **Effort:** high.

| Id | Sessions and steps | Checks | Probe |
|---|---|---|---|
| IH1 | a(0), b(1). Started b a; listed [a b]; "select": select 1; wait 200; "voice": `Eval words for bravo.` → b | voice D5 b | voice z |
| IH2 | a(0), b(tmux 1). Started b a; listed [a b]; iterm.tab w1 2; "attach": tmux.attach b w1 2; wait 1 s; select 1; wait 1 s; hook turn-start b; wait 2 s; hook turn-stop b; wait 1 s; select 2; wait 1 s; "turn": hook turn-start b; wait 2 s; "tap": tap b | open D3 b tab `w1.2.0` after tap | open z after tap |
| IH3 | s01–s20, sNN in tab NN−1; tier A only. Started s20…s01 | ring D1 [s01–s16] | ring + z |
| IH4 | c(herdr 0, `herdrSession: false`). Started c; turned c; listed [c]; "restart": restart; listed [c]; "tap": tap c | ring D1 [c] after restart at tap; open D3 c after tap | open z after tap |
| IH5 | b(tmux 0, `engine: 'codex'`). Started b; listed [b]; "turn": hook turn-start b; wait 2 s; "stop": hook turn-stop b `Eval codex answer.` | state D4 working after turn at stop; state D4 done after stop; recap D6 b after stop | recap z after stop |

- [ ] **Step 1: Failing tests** in `catalog.spec.ts`: `the held out are CH1-CH3, XH1-XH3, VH1-VH4, UH1-UH3, OH1-OH4 and
  IH1-IH5: 22 of 112, VS Code 4 of 19, Cursor 3 of 17, Orca 4 of 21, iTerm2 5 of 26` (main's `… and OH1-OH4: 17 of 86 …`
  case, extended; Task 1 checked Orca's counts on `main`); `IH1 is D5 alone; IH3 tier A only`; `IH4's herdr row gives no
  session`; `IH5's Codex runs in tmux under the daemon's CODEX_HOME`; the extended enumerations (IH1's 200 ms wait among
  the own waits, IH1 in the quick set, every IH scenario in the macOS-only case). Its header stays as it is.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/catalog.spec.ts` → FAIL.
- [ ] **Step 3:** Write the scenarios in `heldOut()`.
- [ ] **Step 4:** As Task 9's Step 4, for IH1–IH5.
- [ ] **Step 5:** Commit red, then green.

## Tier B

### Task 11: The eval command runs the iTerm2 tier B file

**Files:** Modify `cli/src/testing/dialAppEval/runner.ts`, `runner.spec.ts`, `run.ts`, `run.spec.ts`. **Depends on:** 1.
**Effort:** medium.

`runner.ts`: `Source` and `SOURCES.b` gain `iterm` before `heldOut`. `run.ts`: `FILES.b` gains `e2e/dialAppEvalIterm.e2e.ts`
before the held-out file.

- [ ] **Step 1: Failing tests:** `run.spec.ts` `--tier b runs the seven e2e files, iTerm2's before the held-out`; `a run
  whose iTerm2 file wrote no results writes no baseline, naming the file`; `runner.spec.ts` `iTerm2's results file is
  results-b-iterm.json and merges with the others`.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEval/run.spec.ts src/testing/dialAppEval/runner.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; typecheck.
- [ ] **Step 5:** Commit red, then green.

### Task 12: Tier B harness: the fake iTerm2 and herdr started from its tab

**Files:** Modify `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/harness/herdrServer.ts`; Create `cli/e2e/dialAppEvalIterm.e2e.ts`
(its harness cases only). **Depends on:** 1. **Effort:** xhigh.

**Interfaces:** Produces
```ts
// outsideAgent.ts: FakeApp gains 'iterm': a bundle iTerm.app in the throwaway home's Applications, id com.googlecode.iterm2,
//   whose tabs run under its server (its child, at $HOME/Library/Application Support/iTerm2/iTermServer-3.6.6), then the pty
//   helper, then the command; 'iterm-server' stays launchd's. openTab and tabUnder take it; Tab and tabUnder's answer gain
//   appPid?: number (the fake iTerm2's process)
/** The fake iTerm2 ends; its server and tab run on under launchd, as iTerm2 relaunched keeping its sessions. */
export function relaunchIterm(tab: { appPid?: number }): Promise<void>
// herdrServer.ts
/** herdr's server started by its first client, run in a tab of [app] (tabUnder), as a person starts herdr in a terminal:
 *  the server is that client's child (Decision 15). [env] as start's. */
static startIn(d: IsolatedDaemon, app: FakeApp, options?: { env?: NodeJS.ProcessEnv }): Promise<PrivateHerdr & { tab: { pid: number; tty: string; close(): Promise<void> } }>
// hooked(folder, { resume?: string }): the fake Claude Code going on in that conversation (--resume), for herdr.restart
/** herdr's own Claude Code report of the pane's session, as its integration's SessionStart hook sends it. */
reportSession(paneId: string, sessionId: string): Promise<void>
```

- [ ] **Step 1: Failing tests** in `dialAppEvalIterm.e2e.ts` (skipped off macOS; each process read is one of this test's
  own, by `ps -o ppid=,comm= -p <pid>`): `a tab of the fake iTerm2 runs its command under iTerm2's server, whose parent is
  the fake iTerm2, and the server is inside the daemon's home`; `once the fake iTerm2 ends its server is launchd's child
  and the tab's command runs on`; `herdr started from a fake iTerm2 tab runs its server under that client, and a hooked
  pane's agent's parents reach the fake iTerm2 and never this worker`; `a pane's session reported to herdr is in its
  agent.list row`. `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts
  e2e/dialAppEvalIterm.e2e.ts` → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Same → PASS on this Mac; then the changed harness's other users on this Mac: `TMPDIR=/tmp caffeinate -i
  npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts e2e/dialHerdrTerminal.e2e.ts
  e2e/dialTerminalFollow.e2e.ts e2e/dialHostHerdrPane.e2e.ts e2e/deviceHerdr.e2e.ts e2e/dialAppEvalVscode.e2e.ts
  e2e/dialAppEvalCursor.e2e.ts e2e/dialCodexApp.e2e.ts` → PASS (a file whose host is missing skips, as today); typecheck.
- [ ] **Step 4:** Commit red, then green.

### Task 13: Tier B driver: the watch's selects, tab reports, recording wrappers, the devices' restart

**Files:** Create `cli/e2e/harness/runLog.ts`; Modify `cli/e2e/harness/appEvalDriver.ts`, `cli/e2e/harness/herdrServer.ts`
(its `herdr` wrapper records), `cli/e2e/harness/fakeOrca.ts` (its launcher's `note()` and `FakeOrca.log()` from
`runLog.ts`), `cli/src/testing/dialAppEvalTierB.spec.ts`. Runs unchanged: `cli/src/testing/fakeOrca.spec.ts` (the run
log's writer and reader cases) and `cli/src/testing/dialAppEvalTierBOrca.spec.ts` (`orcaCommands`, `orcaDeliveries`).
**Depends on:** 2, 3. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 3's `namedPanes`, `selectRecord`, `TABS_STREAM`; `ownHerdrsOnly`, `devicesPids`.
- Produces:
  ```ts
  // runLog.ts: Orca's run-log form (Decision 14), one writer and one reader, moved from fakeOrca.ts
  /** The shell `note()` the fake Orca's launcher defines today: its arguments (the exit, the name run by, each argument)
   *  one a line, in a file `log/run.XXXXXX` under [dir], written aside and moved in whole. */
  export function noteFunction(dir: string): string
  /** A wrapper script: runs [real] as its child and notes the run under [dir] (noteFunction) when its first argument is
   *  one of [recorded], exiting with its status; any other run execs [real] as it was. */
  export function recordingWrapper(real: string, dir: string, recorded: readonly string[]): string
  /** Every run noted under [dir], oldest first: today's FakeOrca.log(), which now returns it. */
  export function runLog(dir: string): Array<{ argv: string[]; ok: boolean; at: number }>   // argv[0] the name run by
  // appEvalDriver.ts: OrcaRun becomes runLog's entry type; orcaCommands and orcaDeliveries read it as today
  // appEvalDriver.ts: TierBWorld gains
  readonly tabs: Map<string, string>          // each iTerm2 tab's tty by its label, as the iTerm2 steps open them
  readonly muxPanes: Map<string, SessionKey>  // each tmux and herdr pane's session, by pane id (`panes` is Orca's
                                              //   private field on main: its panes' handles over time)
  reportTab(label: string): void              // the person's tab report on the watch, recorded on the tabs stream
  readonly herdrs: { kept(): number[]; dropped(): number[] }   // ownHerdrsOnly's notes for this daemon
  // exported for the unit spec
  export function selectOf(line: string): { app: string; tty: string; raise?: boolean } | undefined  // a watch stdout line
  ```
- `openRig`: the recording `tmux` wrapper first on the daemon's PATH (the real one resolved off it), and `ownHerdrsOnly`,
  before `d.start()`; both inside the root, checked as its other places are. The watch's stdout, `'ignore'` on `main`
  (`stdio: ['pipe', 'ignore', 'pipe']`), is piped and read: each `select` line becomes a tabs record (`selectRecord`
  over `tabs`) at its arrival. `tell()`, typed `{ front } | { thread }` on `main`, takes the tab line too (`reportTab`).
  As the world stops it takes the tmux and herdr run logs once, beside `takeOrca`, as commands at their own times, panes
  named by `muxPanes`. `GENERIC` gains `devices.restart`: every devices pid
  SIGKILLed, then bounded waits for a new pid and the dial's next welcome.

- [ ] **Step 1: Failing tests** in `dialAppEvalTierB.spec.ts`: `the recording wrapper notes a recorded run's arguments
  (one with spaces whole) and exit, and exits with the real program's status` (a temp dir, `/usr/bin/false` and
  `/bin/echo` as the real one); `a run it does not record execs the real program and notes nothing`; `runLog reads each
  run at its mtime, and skips a note not yet moved in`; `selectOf reads a watch select line, with and without raise, and
  nothing else`; `a tmux run becomes a command with its panes named by key`. The fake Orca's runs read as before through
  `runLog`: `fakeOrca.spec.ts` and `dialAppEvalTierBOrca.spec.ts`, unchanged.
- [ ] **Step 2:** `cd cli && npx vitest run src/testing/dialAppEvalTierB.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same, with `src/testing/fakeOrca.spec.ts src/testing/dialAppEvalTierBOrca.spec.ts` → PASS; typecheck;
  the driver's and the fakes' other users on this Mac (`FakeOrca.log()`'s among them), with no pass/fail result changed:
  `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalClaude.e2e.ts
  e2e/dialAppEvalChatgpt.e2e.ts e2e/dialAppEvalVscode.e2e.ts e2e/dialAppEvalCursor.e2e.ts e2e/dialAppEvalOrca.e2e.ts
  e2e/dialAppEvalHeldOut.e2e.ts e2e/dialOrcaFocus.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialHostOrcaPane.e2e.ts
  e2e/deviceOrcaHomes.e2e.ts e2e/dialHerdrTerminal.e2e.ts` → PASS (a file whose host is missing skips, as today).
- [ ] **Step 5:** Commit red, then green.

### Task 14: Tier B: iTerm2

**Files:** Create `cli/e2e/harness/appEvalIterm.ts`, `cli/src/testing/dialAppEvalTierBIterm.spec.ts`; Modify
`cli/e2e/dialAppEvalIterm.e2e.ts`, `cli/e2e/harness/appEvalClaude.ts` (its session code takes any Claude Code terminal,
not copied). **Depends on:** 9, 11, 12, 13. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 12's `'iterm'` fake app, `relaunchIterm`, `PrivateHerdr.startIn`, `hooked`, `reportSession`; Task 13's
  `tabs`, `muxPanes`, `reportTab`, `herdrs`, `devices.restart`; `InOwnTmux`, `tabClient`; the driver's `speak`.
- Produces: `export const itermSteps: AppSteps`; `appEvalClaude.ts`'s turn steps (turn-start, needs-input, turn-stop, end,
  the mod's poll, `typedPrompts`) exported to take the session's terminal (an `Outside`, an `InOwnTmux` pane or a herdr
  pane: what can be typed into and whose hooks `d.hookLog()` names).
- `itermSteps`: a tab session through `Outside.start(..., 'iterm')` with Decision 8's hints; a tmux one by `InOwnTmux` on
  the daemon's private server (its `env` gives iTerm2's bundle id), its first client `tabClient(d, session, 'iterm')`; a
  herdr one in a pane of `PrivateHerdr.startIn(d, 'iterm', { env })`, reported to herdr unless `herdrSession: false`. Each
  tab's tty (`ps -o tty=` of its own tab process) goes into `tabs` by label, each pane id into `muxPanes`. The steps of
  Decision 9 on these: `iterm.tab` and `iterm.split` open an empty tab of the fake iTerm2 running a shell (`openTab`;
  a split is a tab on a pty of its own); `iterm.closeTab` closes the tab and its splits with no hook (`closeTab`);
  `iterm.select` `reportTab`; `iterm.relaunch` `relaunchIterm` for every fake iTerm2 of the world;
  `tmux.detach`/`attach` close or open its clients' tabs; `tmux.selectPane` the harness's own `d.tmux.run('select-pane',
  …)`; `herdr.focus` herdr's own RPC; `herdr.restart` herdr's `stop`, then `startIn` in a new tab under the same label and
  each session `hooked` again with `resume`. Every process in `world.children`.
- `dialAppEvalIterm.e2e.ts`: an `it.for` over tier B's iTerm2 main scenarios as `dialAppEvalVscode.e2e.ts` does (source
  `iterm`), each checking the daemon's home, open, iTerm2 server, `TMUX_TMPDIR` and herdr config inside its root, every
  herdr the table dropped one of `othersNow()` and none it kept outside this worker, no network reached, no wrong send and
  its probe caught; `ALSO`: I2 `the devices' tmux runs reached the daemon's private server alone`; I5 `the watch's select
  names b's tab by label and no tty is in a result`; I19 `the tmux session's mod polled before the voice`. Its `afterAll`,
  at file level, writes `results-b-iterm.json` on every host, empty off macOS (Decision 16).

- [ ] **Step 1: Failing tests.** `dialAppEvalTierBIterm.spec.ts`: `a tab, a tmux and a herdr session's hints are Decision
  8's`; `a tab label maps to the tty its tab opened on, and a restart's new tab takes the label over`. The e2e file's
  `it.for` → `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalIterm.e2e.ts`
  → FAIL (no iTerm2 steps).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `npx vitest run src/testing/dialAppEvalTierBIterm.spec.ts src/testing/dialAppEvalTierB.spec.ts` → PASS; the
  e2e file → PASS on this Mac; each scenario's time and the file's reported; over about 6 minutes: stop and report the
  numbers (the PM decides what leaves tier B). No wrong send and no network reached (else stop and report).
  `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialAppEvalClaude.e2e.ts` → PASS (the
  changed session code's other user); typecheck.
- [ ] **Step 4:** Commit red, then green.

### Task 15: Tier B: iTerm2's held-out scenarios

**Files:** Modify `cli/e2e/dialAppEvalHeldOut.e2e.ts`, `cli/e2e/harness/appEvalIterm.ts` (only what IH1–IH5 need),
`cli/e2e/harness/ownTmux.ts` (`tabClient` gains `type(text)`: keys into its tab's pty, so the client is used, for IH2),
`cli/e2e/harness/codexOutside.ts` (a Codex run as a pane of the daemon's private tmux server under the daemon's
`CODEX_HOME`, its hooks' caller its process, for IH5). **Depends on:** 10, 14. **Effort:** high.

- [ ] **Step 1: Failing test:** the held-out file's `TierBDriver` has no iTerm2 steps, so its `it.for` over `HELD_OUT`
  fails on IH1: `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts
  e2e/dialAppEvalHeldOut.e2e.ts` → FAIL.
- [ ] **Step 2:** Give the driver `itermSteps`; its path checks add iTerm2's server; build IH2's typing through the
  selected tab's client (Decision 6), IH4's unreported herdr session and IH5's Codex in tmux.
- [ ] **Step 3:** Same → PASS on this Mac, under about 6 minutes; no wrong send and no network reached (else stop and
  report); `TMPDIR=/tmp caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts
  e2e/deviceCodex.e2e.ts e2e/dialCodexApp.e2e.ts` → PASS (the changed harness's other users).
- [ ] **Step 4:** Commit red, then green.

## CI

### Task 16: `ci-plan.py`: the iTerm2 file is macOS only

**Files:** Modify `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`. **Depends on:** 1.
**Effort:** high.

`LINUX_E2E_NEVER` gains `cli/e2e/dialAppEvalIterm.e2e.ts`, its comment naming why (iTerm2, macOS only; run by the tester).
`LINUX_E2E_APP_EVAL_FILES` (six on `main`, Orca's among them), `LINUX_E2E_APP_EVAL_PATHS` and `test_ci_plan.py`'s
`APP_EVAL_FILES` are unchanged: `appEvalIterm.ts` is an `appEval*.ts` path.

- [ ] **Step 1: Failing tests:** `test_some_files_never_run_on_linux` covers the iTerm2 file; a new case `a change to the
  iTerm2 file selects no linux-e2e file of its own, and one to appEvalIterm.ts runs the app eval's Linux files, not the
  iTerm2 file`.
- [ ] **Step 2:** `python3 scripts/tests/test_ci_plan.py` → FAIL.
- [ ] **Step 3:** Implement. `docs/validation-and-release.md`, the linux-e2e row: `dialAppEvalIterm.e2e.ts` (macOS only)
  among the files linux-e2e never runs.
- [ ] **Step 4:** Same → PASS; `CROSS_READ_SCAN_REQUIRED=1 python3 -c 'import sys; sys.path.insert(0, "scripts/tests");
  import unittest, test_ci_plan; unittest.main(module="test_ci_plan", argv=["x", *test_ci_plan.FullCheckoutTests.NAMES])'`
  → PASS.
- [ ] **Step 5:** Commit red, then green.

## Baseline

### Task 17: The baseline

**Files:** Modify `cli/src/testing/dialAppEval/baseline.json`, `cli/ci-e2e-durations.json`, `catalog.spec.ts` (the
kind-coverage case over every kind but `wait` and `stroke`, as on `main`). **Depends on:** 10, 11, 14, 15. **Effort:** xhigh.

- [ ] **Step 1: Failing tests (existing):** the tier A spec's `matches the baseline` (stale: iTerm2's checks are new) and
  the iTerm2 file's `matches this platform's baseline` → FAIL. Restore the kind-coverage case over every step kind but
  `wait` and `stroke` (main's `STEP_KINDS.filter(...)`, with its reason for `stroke`); `grep -rn "not built yet" cli/src/testing/dialAppEval cli/e2e/harness` prints nothing.
- [ ] **Step 2: The baseline run** on this Mac at this head (Open question 1): `cd cli && git show
  main:cli/src/testing/dialAppEval/baseline.json > /tmp/dial-eval-main-baseline.json && TMPDIR=/tmp
  DIAL_EVAL_OUT=/tmp/dial-eval-baseline caffeinate -i npm run eval:dial-apps -- --update-baseline`. It writes tier A
  (darwin, linux, win32) and tier B darwin; no Linux tier B entry. **A wrong-session send, or a test failing on the network guard: stop and report
  (the PM decides before anything merges).** Keep `/tmp/dial-eval-baseline/report.md` for the PR.
- [ ] **Step 3: The other apps' held checks equal `main`'s.** Orca's Task 17 script, inline in
  `docs/plans/2026-11-22-dial-eval-orca-plan.md` Task 17 Step 3 (no script file on `main`), run from `cli` with its
  `other` test's ids `C|X|V|U|O|CH|XH|VH|UH|OH` and its `apps.a` loop over `claude`, `chatgpt`, `vscode`, `cursor`, `orca`. Expected: exit
  0, `held checks equal main: true`. A key that differs is a shared change moving another app (Review Focus 1): do not
  commit the baseline; report the keys and return the task for a fix in the task that owns the change.
- [ ] **Step 3b: The delta for the PR body.** The report's Delta section under "Baseline delta", with Step 3's summary
  line. For the other apps a change there is a timed `b/darwin` check or a `b/darwin` app score; anything else means Step 3
  missed one: stop and report.
- [ ] **Step 4: Times.** The tier A spec under 60 s (else stop and report, as Task 4's Step 6); the iTerm2 file's time into
  `cli/ci-e2e-durations.json` (`durationMs`), and the held-out file's anew, each under about 6 minutes.
- [ ] **Step 5:** `npx vitest run src/testing/dialAppEval/ src/testing/dialAppEvalTierB.spec.ts
  src/testing/dialAppEvalTierBEditor.spec.ts src/testing/dialAppEvalTierBOrca.spec.ts src/testing/fakeOrca.spec.ts
  src/testing/dialAppEvalTierBIterm.spec.ts` → PASS; the seven eval e2e files → PASS on this Mac under `caffeinate -i`;
  `npm run typecheck`.
- [ ] **Step 6:** Commit once (the failing ratchet is the existing test).

---

## Verification

Isolation follows the repo's own e2e rules (`cli/AGENTS.md` rules 5 and 6, `cli/e2e/harness/daemon.ts`): each
`IsolatedDaemon` has a throwaway root, home, data folder, socket and port (never 18473), the in-memory fake backend with a
made-up machine and token (no account of anyone's), the recording `open` (`HARNESS_OPEN_BIN`), the network guard in every
process, and these for iTerm2:
- **tmux:** the daemon's private server, its own socket and `TMUX_TMPDIR` inside the root, `TMUX` and `TMUX_PANE` unset;
  the devices' `tmux` is a recording wrapper on the daemon's PATH that reaches that server alone.
- **herdr:** `PrivateHerdr`, its config under the throwaway home with update and manifest checks off, the daemon's `herdr`
  wrapper pinned to it, started from a fake iTerm2 tab; `ownHerdrsOnly` hides every herdr outside the test's tree from
  the daemon's process table, and each scenario checks what it kept and dropped.
- **iTerm2:** a Node under `$HOME/Applications/iTerm.app` of the throwaway home, its server under the throwaway home's
  `Library/Application Support/iTerm2/`; no Harness Device runs, no window opens, no `osascript`, no AppleScript.
- **The watch:** the real `harness hardware watch --json` under the daemon's environment alone, its lines written and
  read by the test.
- **No walk reaches this machine's terminal** (Decision 15), and no other process's environment or argv is read.

The tester's own iTerm2, tmux server, herdr, `~/.claude`, `~/.codex`, daemon and dial may run on the Mac: none is reached.
No check needs a person's login, their eye or production.

1. **Tier A on macOS** (this Mac, final head): `cd cli && npx vitest run src/testing/dialAppEval/`. Seen: all pass, the
   tier A spec under 60 s, `matches the baseline` green, no scenario erroring.
2. **Tier A on Linux:** PR CI's `cli-tests` runs the same spec, iTerm2's scenarios on injected darwin, against the
   macOS-written baseline. Seen: green; a difference is a determinism bug, not a baseline to refresh. This is the one PR CI
   guard of iTerm2 (decision 3).
3. **Tier B on macOS, by the tester, on this Mac** (needs `tmux`, `herdr` 0.9.5 or later and `cc` installed; the files
   skip a scenario whose host is missing, which fails the check): `cd cli && TMPDIR=/tmp caffeinate -i npx vitest run
   --config vitest.e2e.config.ts e2e/dialAppEvalIterm.e2e.ts e2e/dialAppEvalHeldOut.e2e.ts`. Seen: both pass, each
   scenario's time printed, each file under about 6 minutes; no wrong send, no network reached. No repo workflow runs
   macOS e2e files.
4. **The whole eval on macOS, by the tester, on this Mac:** `cd cli && TMPDIR=/tmp caffeinate -i npm run eval:dial-apps`.
   Seen: exit 0; the report (terminal and `report.md`) has the score table with six rows (`iTerm2` last) and each app's
   left-out count, the held-out table, `Gate: passed`, the ranked groups; the other apps' tier A checks and tier B
   pass/fail checks as on `main`.
5. **PR CI jobs that start on their own:** `cli-tests` (check 2 and the unit specs); `linux-e2e` (the app eval's Linux
   files, as `cli/src/testing/dialAppEval/` and `appEval*.ts` changed; Orca's files, as `fakeOrca.ts` changed; the canary,
   as the harness changed; `dialAppEvalIterm.e2e.ts` never), on ubuntu-24.04: `linux-e2e-summary` green; `dial-hosts`
   (`outsideAgent.ts`, `herdrServer.ts`, `fakeOrca.ts` are `DIAL_HOST_PATHS` entries): green, none skipped; the planner's
   own tests for `scripts/ci-plan.py`. If linux-e2e did not select the eval's files, run once by hand: **Actions → CI → Run
   workflow**, `scope=linux-e2e`, `e2e_files="cli/e2e/dialAppEvalHeldOut.e2e.ts cli/e2e/dialAppEvalClaude.e2e.ts"`. No
   other extra run.
6. **Local gates** PR CI does not run, at the final head from a clean tree: `cd cli && npm run typecheck`; the touched
   specs (check 1, `src/testing/dialAppEvalTierB.spec.ts`, `src/testing/dialAppEvalTierBIterm.spec.ts`, and for the moved
   run log `src/testing/fakeOrca.spec.ts`, `src/testing/dialAppEvalTierBOrca.spec.ts`); `python3
   scripts/tests/test_ci_plan.py` and the `CROSS_READ_SCAN_REQUIRED=1` full-checkout run (Task 16's Step 4); then `python3
   scripts/local-checks.py --run`, its fence pasted into the PR body. `npm run test:core` does not apply: nothing under
   `src/core/` or `src/services/` changes.
7. **PR evidence:** the baseline run's report (iTerm2's score per dimension beside the other five apps, the held-out
   scores, the wrong-session count, the ranked groups), its Delta under "Baseline delta" with Task 17 Step 3's summary
   line, Task 4's budget numbers and the final tier A time, the iTerm2 file's time and each scenario's, the red-then-green
   commits; platforms: macOS in both tiers (tier B by the tester), Linux in tier A by injection.
8. **Gaps and proposals named in the PR:** iTerm2 off macOS (decision 2); tier C, the real iTerm2; no PR CI for tier B.
   Proposal, not in this PR (as #4500 and #4544 proposed): a macOS run of the eval's e2e files on pull requests that change
   their paths, since tier B's ratchet is held on macOS alone and no PR CI suite runs macOS.
9. **After merge** (main session, with the PM): run both tiers on `main` (`TMPDIR=/tmp caffeinate -i npm run
   eval:dial-apps` on this Mac) and report iTerm2's baseline: the score per dimension, the held-out score, the
   wrong-session count, the coverage gaps, and the failing groups ranked by points lost, each with a one-line cause. The PM
   opens the hill-climb items.

## Open questions

1. **Who writes iTerm2's tier B baseline entries.** The spec says they come from "the tester's run". This plan has Task 17
   run the baseline on this Mac, as the editors' and Orca's plans did, and the devcrew tester re-runs it on the final head
   (Verification 3 and 4). Or should the tester's own run after the final review write them, with the baseline committed
   after it?
2. **A closed tab's agent (I12): end hook or not.** Default here: the agent ends with no hook, as tier B's `closeTab` kills
   it and as Orca's `orca.close` does; so its row leaves at the observed tick, likely a baseline failure. The editors'
   `editor.closeTerminal` sends the end hook instead. Which models a closed iTerm2 tab?
3. **Order on a rest (I6).** The spec leaves order out of a tap's `open` only; I6 says "its client's tab is selected, then
   its pane". Default here: order is not graded on a rest either (the person sees the end state, and tier B's watch
   output and wrapper logs keep different clocks). Should a rest grade tab-before-pane?
4. **One tmux model for Orca and iTerm2 (raised by the merge).** `main` has Orca's tmux model inline in `sessions.ts`'s
   private `orcaPane`, a server per tmux session. Default here (Decision 5, the spec's "not a second one"): Task 5 moves
   it into `tierA/steps/tmux.ts`, one server per world, and O11 runs on it with its results unchanged; main's Orca case
   in `sessions.spec.ts` then reads the server by basename. If O11's results move, Task 5 stops and reports. Or should
   Orca's inline model stay and iTerm2's be built beside it?
5. **tmux sessions in tier B (raised by the merge).** Orca's tier B starts its person's tmux session itself on the
   daemon's private server (`appEvalOrca.ts` `personsTmux`: `d.tmux.run('new-session', …)`, hints from
   `display-message`), with no client. Default here: iTerm2's tmux sessions use `InOwnTmux` and `tabClient` (Task 14),
   since a client in a fake iTerm2 tab is what the devices walk; `personsTmux` stays Orca's. Should Task 14 build on
   `personsTmux` instead?

## Reconciled with Orca's merge

Task 1, 2026-11-23: the branch rebased onto `main` at `135c5e99fa` (#4551). Every row of "Sequencing and the Orca
contract" was checked on `main` with `git grep`; nothing this plan builds on is missing. What differed from the plan as
first written, and what changed here:

1. Orca's spec and plan are on `main`, no longer read from `feat/dial-eval-orca` (header, Sequencing).
2. `FRONT_NAMES` (`types.ts`) is typed `Record<Platform, Record<App | 'other', string>>`, every app on every platform:
   Task 2 changes the type. `frontAppId` is the product's (`cable/hosts/frontApp.ts`, mapping iTerm2's bundle id through
   `hostDetect.ts` `BUNDLE_APPS`); tier B's `appEvalDriver.ts` `GENERIC.front` writes the raw name.
3. `tierA/steps/window.spec.ts`'s case `the front step tells the listener what frontAppId makes of the platform's own
   front name, for each app and platform, Orca's included` reads `FRONT_NAMES[platform][app]` for every app: Task 2's
   Files and Steps gain it; `types.spec.ts`'s case to narrow is named as on `main`.
4. `SessionDef.tab` and `split` are doc-commented "Orca only" on `main`: Task 2 re-docs them (Decision 1).
5. `launchOf` does not exist: Orca's launch is `sessions.ts` `State.orcaLaunch`, read through `types.ts`
   `orcaPaneHandle`/`hookHandle` and `sessions.ts` `orcaHandleOf`. No iTerm2 task used it; it left the contract table.
6. The tmux model is inline in `sessions.ts`'s private `orcaPane` (a server per tmux session, bare `tmux`, `TMUX_PANE`
   `%<index in scenario.sessions>`), not a reusable piece: Decision 5 and Task 5 now move it into `tierA/steps/tmux.ts`
   (`tmuxPane`), keep Orca's pane-id rule in place of "`%0` first", and keep O11 unchanged (Open question 4).
7. Ttys come from `sessions.ts`'s private `nextTty` (one counter per world, `ttys000` first; `pts/N` on Linux):
   Decisions 4, 5 and 7 use it in place of the plan's own ranges (`ttys001`, `ttys101`, `ttys201`); Task 4 exports it
   and `startProcess`.
8. `dropSession` is `async (world, key): Promise<void>`, one session at a time, throwing for one not running, ending its
   agent, shell and `Live.others`: Decision 9's `iterm.closeTab` and Task 6's `herdr.restart` await it per session and
   end empty shells and multiplexer clients themselves; Task 4 puts a tab's login in `Live.others`.
9. `ANSWERED` is `open`, `xdg-open`, `xdg-mime`, `harness-pty`, `raise` and `argv.ts` `ORCA_PROGRAMS` (`orca`,
   `orca-ide`), matched by `programOf`'s basename; the world's `orca` deps' `onPath` reads the constant
   `ON_PATH[platform]`, whose `darwin` entry is empty: Task 6 has `machine.installed` answer first, so herdr is found.
10. Tier A starts no process (`tierA/refuseProcesses.ts`, the spec's `child_process` mocks): a Global Constraint now.
11. The run log's writer is the fake Orca launcher's shell `note()` and its reader `FakeOrca.log()`, typed `OrcaRun` in
    `appEvalDriver.ts` for `orcaCommands` and `orcaDeliveries`; its cases are in `src/testing/fakeOrca.spec.ts` and
    `src/testing/dialAppEvalTierBOrca.spec.ts`, not `dialAppEvalTierB.spec.ts`: Decision 14 and Task 13 move both into
    `runLog.ts` (`noteFunction`, `runLog`), run those two specs unchanged, and add `FakeOrca.log()`'s e2e users to Task 13's
    Step 4; Task 17 Step 5 and Verification 6 run them too.
12. Orca's main scenarios are `orcaScenarios.ts` `orcaScenarios()`, spread last in `MAIN`; Task 9's `itermScenarios()`
    follows it, and Task 9's and 10's `catalog.spec.ts` cases are named as on `main` (main ids, `X3, V11 and UH1 are macOS
    only`, the `quick` set `X11`, `XH3`, `OH2`). Counts equal the plan's: 17 of 86 held out, Orca 4 of 21; with iTerm2 22
    of 112.
13. Session ids come from `catalog.ts`'s private `uuid(key, variant)` (Orca's `8c`): Decision 1's id is `uuid(key, '8e')`.
14. The kind-coverage case runs over every step kind but `wait` and `stroke` (its reason in the case): Decision 18 and
    Task 17 restore it so.
15. The held-check script is no file: it is inline in Orca's plan, Task 17 Step 3; Task 17 names it there. Orca's
    `baseline.json` entries are `a/darwin`, `a/linux`, `a/win32` and `b/darwin`, and `apps.a`/`apps['b/darwin']` hold `orca`.
16. As the plan expected: `results-b-orca.json` and `SOURCES.b` (`runner.ts`), `FILES.b` (`run.ts`), the six
    `LINUX_E2E_APP_EVAL_FILES` (`scripts/ci-plan.py`), `Seen.faces[].refused`, the `face` check, `worktree`, `handle`,
    `held`, `LinkedApp`, `PAGE.orca` and the `learnApps`, `readTtyName`, `watchSocket` and `ensureTmuxOnPath` mocks.
17. Tier B's `TierBWorld` already has a private `panes` (Orca's handles over time, `appEvalDriver.ts`): Task 13's and
    Task 14's map of tmux and herdr panes is `muxPanes`. The watch's stdout is `'ignore'` on `main` and `tell()` takes
    `{ front } | { thread }`: Task 13 pipes the stdout and widens `tell()` for the tab line. The fake Orca's log is read
    once as the world stops (`takeOrca`); Decision 14 and Task 13 read the tmux and herdr logs the same way.
18. `deps.tty` reaches only a tab app's agent on darwin (`services/devices.ts` `ttyOf`, `observed.ts`, `tabs.ts`
    `TAB_APPS`), never Orca's: Review Focus 1 names what the `/dev/` form can move (X10's Ghostty Codex CLI).
