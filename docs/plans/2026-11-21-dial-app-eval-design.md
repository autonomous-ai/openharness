# Dial eval for the Claude app and the ChatGPT app

Branch: `feat/dial-app-eval`. Component: `cli/` (test code, the e2e harness, and two test seams in the devices process's `DevicesDeps`), with
`scripts/ci-plan.py` and its test for when tier B runs on a pull request. Platforms: macOS, Linux and Windows for tier A
(each OS branch the devices code has, chosen by an injected platform); macOS and Linux for tier B; Windows tier B is a
gap (see Out of scope). Nothing a person sees changes; no product behavior changes.

Source: the eval proposal (`eval-dial-claude-chatgpt.md`, Vietnamese, approved by Diego 2026-11-21 with the decisions
in its section 7). This spec is its English, buildable form.

## Why

Whether the dial works with the Claude app (Claude Code sessions) and the ChatGPT app (Codex threads) is judged today by
hand and by pass/fail tests of single functions. We want one number per app, from a fixed scenario set and an automatic
grader, so that each fix is a hill-climb step: measure, fix the group that loses the most points, measure again, keep
the change only when the app's score rises, the other app's does not fall, and no voice prompt reaches the wrong
session.

## Decisions (Diego, 2026-11-21, from the proposal's section 7, and the orchestrator's brief)

- **C8:** voice to a resting Claude-app session (no process) **opens that session, then sends**. That feature is a
  separate item (`feat/dial-claude-app-wake-send`). Here C8 is a normal scenario graded on that behavior; it fails at
  baseline.
- **Target:** ≥ 95/100 per app and zero wrong-session sends.
- **Tiers A and B only.** Tier C (real apps on a VM) is out of scope.
- **Never** the real `~/.claude`, `~/.codex`, Claude/ChatGPT apps, accounts, or Diego's apps: throwaway homes and temp
  folders only, as `scripts/benchmark-codex-app-threads.ts` and the existing e2e files do. No real Claude or ChatGPT app
  is ever run.
- Weights: D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5.
- **Hard gate:** a voice prompt delivered to a session other than the scenario's target fails the whole run, whatever
  the score.
- About 20% of scenarios are a held-out set, not looked at while fixing, scored and reported separately.

## What we measure

Each app's score is 0–100, the weighted mean of its dimension scores. A dimension's score is the mean of every check of
that dimension the run made for that app (main set only), across scenarios, platforms and tiers. A dimension with no
check in a run is left out and the weights of the others are renormalised; the table shows `—` for it (tier A alone
has no D8 check, see below).

| # | Dimension | Checks |
|---|---|---|
| D1 | List (ring) vs the app's sidebar | recall and precision of the rows on the app's page; order (share of expected rows at their expected index); share of names right; at most 16; no archived row |
| D2 | Follow (app → dial) | the dial's `focus` lands on the right row; latency |
| D3 | Open from the dial | a tap or a swipe rest runs the app's link for the right session (`claude://code/continue?session=…`, `codex://threads/<id>`), and the command that brings the app to the front is run (the eval sees commands, not windows); latency |
| D4 | State | working / needs-you / done / idle shown right; latency of the change |
| D5 | Voice send | the transcript reaches the target session, once, with the exact text; any other session receiving it is a **wrong-session send** (gate). Every delivery path is recorded with its target: the Claude mod's inbox, the core's `turns.send`, the Codex queue's `codex` run, and words typed into a terminal through the injected `run` |
| D6 | Recap / last answer | the dial's summary is the session's last answer, exactly |
| D7 | Robustness | the ring, follow and open are still right after quit/relaunch, archive, new thread, 200–2,000 threads, two windows, Accessibility missing, replug |
| D8 | Cost | devices-process CPU over the scenario, event-loop delay p99, processes left behind |

**Latency thresholds** (a check scores 1, 0.5 or 0). The clock starts at the event the person makes (the window title
line, the attach post, the tap frame, the hook) and stops at the frame or command the person sees.

| Check | Full | Half | None |
|---|---|---|---|
| D2 follow | ≤ 1 s | ≤ 3 s | > 3 s or never |
| D3 open | ≤ 1 s | ≤ 3 s | > 3 s or never |
| D4 working, needs-you | ≤ 1 s | ≤ 3 s | > 3 s or never |
| D4 done (the 1.5 s answer grace is by design) | ≤ 2.5 s | ≤ 5 s | > 5 s or never |
| D1 a change (archive, new thread, rename) on the ring | ≤ 2 s | ≤ 5 s | > 5 s or never |
| D8 event-loop delay p99 | ≤ 50 ms | ≤ 200 ms | > 200 ms |

D5, D6 and D7 checks are pass/fail. D8 also checks: no process the scenario started outlives it (pass/fail), and
devices-process CPU ≤ 10% of the scenario's wall time (full), ≤ 25% (half).

**Points lost.** For a check `c` of dimension `d` with `n_d` checks for that app, the points it loses are
`100 · (w_d / Σw) · (1 − score_c) / n_d`. The report ranks failing groups (app × dimension × scenario) by points lost.

## Scenarios

One catalog, typed TypeScript data, shared by both tiers, in the eval's own folder `cli/src/testing/dialAppEval/`
(catalog, drivers, grader, runner, baseline). A scenario is a list of steps and a list of checks; a tier's
driver turns each step into what that tier can do. Every scenario names its app, its dimensions, the platforms it
applies to and whether it is held out.

Steps (the full set; the planner may add one when a scenario needs it): write or remove a store session (Claude), write
or update threads and names and the sidebar state (Codex), a hook event for a session (start, turn start, needs input,
turn stop with a last answer, end), the app in front (`{front}`), a window title (`{thread}`), the Claude mod's attach,
a tap or a swipe rest on a row, voice (begin, audio, end, with the transcript the fake speech-to-text returns), quit and
relaunch the app (its sessions' processes end and come back), unplug and replug the dial, and wait until a check's
condition or a time limit.

**The fake apps react to links.** Both tiers' fake Claude app and fake ChatGPT app watch the commands a tap runs: when
`claude://code/continue?session=<id>` (or `codex://threads/<id>`) is run for a session the scenario marks as one the app
can resume, the fake app starts that session (its process, its start hook and, for Claude, the mod's open inbox poll),
as the real app does. Without it C8 and C10 could never pass, even once their behavior ships.

### Main set: the Claude app

- **C1.** 5 sessions in the app → the ring has exactly those 5, newest first, right names. (D1)
- **C2.** Archive one in the app → it leaves the ring within 2 s. (D1, D7)
- **C3.** 30 sessions → the ring keeps the newest 16. (D1, D7)
- **C4.** Tap a resting session (no process) → the app opens it with `claude://code/continue?session=<id>`. (D3)
- **C5.** Another session opened in the app (attach with the app in front) → the dial follows within 1 s. (D2)
- **C6.** A long turn → working, then done or idle; the last answer is the recap. (D4, D6)
- **C7.** Claude asks (permission or a question) → needs-you. (D4)
- **C8.** Voice on a resting session → the session opens, then the exact text is sent to it, once. (D5, D3) Fails at
  baseline.
- **C9.** A new session with no hook yet → a swipe reaches it; when its hook arrives the two copies become one row. (D3,
  D1, D7)
- **C10.** Quit the app and relaunch it → the ring comes back right, no duplicate rows. (D7, D1)
- **C11.** Unplug and replug the dial → the ring and the focused row come back. (D7)
- **C12.** Voice on a running, idle Claude-app session → the exact text reaches it, once. (D5)

### Main set: the ChatGPT app

- **X1.** 3 projects and 8 threads → the ring in the sidebar's order, Codex's names (never the first message). (D1)
- **X2.** A thread opened in the app → the dial follows from the window title. (D2)
- **X3.** Accessibility not granted: the ChatGPT app is in front and no title line ever comes → the dial does not move
  by itself; the ring and a tap still work. macOS only. The prompt to grant is the Harness Device app's (its own e2e);
  not measured here. (D7, D2)
- **X4.** Tap a thread → `codex://threads/<id>` opens it and the app comes to the front. (D3)
- **X5.** A thread found by the read, no hook yet → a tap still brings the app up (the fallback when the link fails).
  (D3)
- **X6.** Archive a thread, and a thread with a newer time → the ring updates. (D1, D7)
- **X7.** 2,000 threads while the app's writer keeps the WAL busy → reading does not stall the event loop. (D8, D7)
- **X8.** A Codex turn → working, then done; the last answer is the recap. (D4, D6)
- **X9.** Voice → the text reaches the selected thread exactly. (D5)
- **X10.** A thread only in the ChatGPT app, in the same folder as a Codex CLI session → the two are never one row.
  (D1)
- **X11.** Two ChatGPT windows on two threads, the person switching between them three times 300 ms apart (the
  watch reports only the front window's title, so this is a run of title lines) → the dial ends on the last one's
  thread and never bounces back to an earlier one (the echo rules). (D2, D7)

### Held-out set (6 of 29, 21%)

In their own file (`heldOut.ts` beside the catalog; the tier B ones in their own e2e file), scored and reported
separately, never in the headline score. Whoever fixes a failing group does not read them (the file's header says so).

- **CH1.** 16 sessions and a new one → the oldest leaves, the new one is first. (D1)
- **CH2.** A long title with emoji → the name the daemon sends for the row is the title as the daemon's own title rule
  makes it (`observedTitle`); the firmware's glyph cut is not graded. (D1)
- **CH3.** Voice on the focused Claude-app session while another of its sessions is working → only the focused one gets
  it. (D5, gate)
- **XH1.** A thread renamed in `session_index.jsonl` after it is listed → its row's name updates. (D1)
- **XH2.** A thread opened in the ChatGPT app while the dial shows the Claude app's page → the dial moves to the ChatGPT
  page and that thread. (D2)
- **XH3.** Voice 200 ms after a follow moved the dial → the text reaches the newly focused thread. (D5, gate)

A bug reported from now on becomes a scenario (main or held out) in the same catalog.

## Tier A: replay, in process

Runs in the CLI's normal unit run (`npm test`), so PR CI runs it on every `cli/` change, `cable/hosts/` included.
Deterministic: the same input gives the same result, every run, on every host. Target: the whole tier under 60 s; the
plan's first task measures one scenario and, if the budget does not hold, runs the win32 and linux branches only for
scenarios whose code path has an OS branch.

**What stays real:** `startDevices` (`cli/src/services/devices.ts`) and everything it composes for these two apps:
`DaemonCableHost`, `CableFleet`/`CableSession` and the frame codec (speaking to an in-process fake dial over a loopback
port, as `cableSession.spec.ts`'s `LoopbackPort` does), `HostRegistry`, `AppRings`/`DialRing`, `AppFilter`,
`ObservedSource`, `ClaudeAppSource`, `CodexAppSource`, the follow and echo rules, `Inbox`, the Codex queue's logic,
`createOpenActions`/`createAppLink`, and the real store readers (`ClaudeAppStore` on `claudeAppFixture`'s files,
`CodexAppThreads` on `codexAppFixture`'s `state_5.sqlite`, both in a temp folder). `services/devices.spec.ts` is not the
model here: it replaces `CableFleet` with a recorder; the eval keeps it real.

**What is replaced** (with `vi.mock`, as `devices.spec.ts` does for the same modules, or with an existing
`DevicesDeps` seam):
- the machine readers: `listProcesses`, `processAlive`, `fileStamp` (`cable/hosts/support.ts`), `learnApps`,
  `readProcessNames`, `readBundleId` (`scannedApp.ts`), `OpenSessions`/`SessionRows` (`external.ts`), the folder
  watchers (`folderWatch.ts`), the tmux, zellij and kitty finders: answered from the scenario's model of the machine
  (its live session processes, their app hints, the platform), so the 30 s observed tick sees the scenario's processes
  and nothing of the host's;
- everything that could start a real process or read the real machine: the voice router's warm engine
  (`voiceRouter.ts`), `orcaHomes`, the `cable` options `canUseUsb`, `inUse` and `reset`, `claude`, `bundleId`,
  `storePackageFolder`, the VS Code, Cursor and Orca plugin deps; `orca.run` records every command (`open`,
  `xdg-open`, `xdg-mime`) and answers as the scenario says; `windowsRaise.link` and `.app` record on win32;
- delivery: the Claude mod is the driver itself, holding `ports.devices.inboxPoll` open for every live Claude session
  (so `modReady` holds) and recording what it receives; `codex.run` records the Codex queue's sends; `core.turns.send`
  is recorded by the fake core.

**New seams** in `DevicesDeps` (devices process only; the core is not touched), each documented "For this service's
tests" like its neighbours:
- `transcribe`: the dial's speech-to-text, so a scenario gives the transcript (today `DaemonCableHost.transcribe`
  fetches the backend, `cableHost.ts`);
- `watchStore`: the watcher of the Claude store's folders and of the Codex home (today `watchNearest`, called directly),
  so the driver says when a change is seen.

**Hooks** enter as the core passes them, through `ports.devices.observed(event)`, with the app's hints in `hostHints`.

**The clock.** Fake timers (`vi.useFakeTimers`, `performance` and `Date` included), installed before `startDevices`
(it reads `now` once). The driver moves time only when the devices are quiet: no store read in flight (the store
readers are wrapped to count reads in flight) and no pending I/O; then it advances to the next timer, never by a fixed
step, so a run's virtual times are the same on every host. Latency is virtual milliseconds: the designed delays (the
1 s front settle, the 1 s list gap, the 1.5 s answer grace, the stores' read gaps) count and the machine's speed does
not. Thresholds are inclusive (≤).

**OS branches.** Each scenario runs once per platform it applies to (darwin, win32, linux), with the platform given
to every part that reads it: the `orca` deps' `platform`, the Codex queue's `platform`, and the mocked `learnApps`
(how Linux tells a Claude-app session). The store readers always read the fixture's root, whatever the platform: the
per-OS store locations (`appPlaces.ts`) have their own specs and are not graded. On win32 the links are graded at
`windowsRaise.link`. A branch that still reads `process.platform` and cannot be chosen is a coverage gap for that
scenario and platform: it is left out of the scores (neither pass nor fail), listed in the report, and the number of
scenario × platform runs left out is printed beside each app's score (PM, 2026-11-21).

**No D8** in tier A: cost is a property of a running process; tier A reports D8 as `—`.

**Runner.** `vi.mock` works only under vitest, so tier A is a vitest spec (`dialAppEval.spec.ts` in the eval's
folder) that writes its results as JSON to `DIAL_EVAL_OUT` when set; `npm run eval:dial-apps` runs it through vitest and
reads that file.

## Tier B: scripted end to end, fake apps

E2E files on the e2e harness (`cli/e2e/harness/`: `IsolatedDaemon`, `Desk`/`FakeDial`, `InOrca`, `Outside`,
`schemeApps`, the fake backend's `speech`, `HARNESS_OPEN_BIN`'s recording `open`), as `dialClaudeAppFollow`,
`deviceClaudeAppSessions`, `dialChatgptFollow`, `dialCodexApp`, `deviceCodexAppThreads` do: the real daemon and devices
process, the real `harness hardware watch --json` and `harness device claude link --json`, a throwaway home for each
daemon, the fixtures written inside it and checked to be inside its root before it starts.

- The same catalog, run by a tier B driver. Every scenario runs in tier B unless its catalog entry says it is tier A
  only (a pure list variant whose process-level path another scenario already covers: C3, CH1, CH2, XH1); C10, C11, X7
  and the voice scenarios run in tier B. X9's thread has a running session, idle, when the voice comes.
- **Every tier B scenario carries the three D8 checks** (devices-process CPU, event-loop delay p99, processes left), so
  both apps have a D8 score (PM, 2026-11-21).
- Latency is wall-clock. D8: the devices process's CPU time (`ps`), processes left under the daemon's root after the
  scenario (`devicesPids` and the root's process list), and the devices process's event-loop delay p99, measured as
  `e2e/harness/corePerf.cjs` measures the core, gateway and engine readers (`monitorEventLoopDelay`), extended to the
  devices service (`HARNESSD_SERVICE=devices`). The daemon exposes no such stat itself.
- Harness additions the steps need: a `Stop` hook for `CodexOutside` (`e2e/harness/codexOutside.ts`, for X8's done and
  recap), and the Claude mod's inbox poll moved from single test files (`deviceWithoutApp.e2e.ts`,
  `deviceClaudeOrca.e2e.ts`) into the harness, both files then using it.
- Files: one per app, and one for the held-out set: `cli/e2e/dialAppEvalClaude.e2e.ts`,
  `cli/e2e/dialAppEvalChatgpt.e2e.ts`, `cli/e2e/dialAppEvalHeldOut.e2e.ts`; each under about 6 minutes on a CI runner,
  daemons reused across scenarios where a scenario does not need a fresh one, with hints in `cli/ci-e2e-durations.json`.
- Platforms: macOS (run locally by the tester) and Linux (PR CI's `linux-e2e`, and the nightly full suite). Windows: not
  in this branch.
- **PR CI:** `scripts/ci-plan.py` selects the three files for `linux-e2e` when a pull request changes
  `cli/src/cable/hosts/`, the eval's own folder, the carousel model, the tier B driver (`cli/e2e/harness/appEval*.ts`), or
  the files themselves: a list beside
  `LINUX_E2E_ORCA_FILES` (`LINUX_E2E_APP_EVAL_FILES`) with the same "missing at head" guard. Changes:
  `scripts/tests/test_ci_plan.py`'s assertion that a `DIAL_HOST_PATHS` entry runs `linux-e2e` only when it is a canary
  path now allows this list too; the carousel model's new file in `src/testing/` joins `DIAL_HOST_PATHS` (as
  `fakeDial.ts` is) and the import walk's list; the table row in `docs/validation-and-release.md`.

## The fake dial

Both tiers read what the dial would show from the frames it receives: the `agent` rows (id, name, state), `focus`,
`apps`, and the turn and summary cards. The carousel model (which tiles the firmware holds and which is on the face)
moves from `e2e/harness/fakeDial.ts` to `src/testing/dialCarousel.ts`, and `fakeDial.ts` imports it: a unit spec must
not read `cli/e2e/`, and there is one model, not two. Names, state and recaps are read from the frames, not added to the
carousel.

## Grader and report

- A pure grader (`grade(results, baseline) → report`), unit-tested on its own: per check scores, dimension and app
  scores, held-out scores, the gate, points lost, and the delta against the baseline.
- **Baseline:** a committed JSON file beside the catalog: each check's score keyed by tier, platform, scenario and
  check, and the app scores. Tier B entries are kept per platform; a platform with no baseline entry is graded and
  reported, and only the gate is asserted for it. In this pull request tier B's baseline holds macOS only: Linux is
  gate-only until a later item adds its entries (PM, 2026-11-21).
- **Report** (printed, and written as JSON and Markdown to `DIAL_EVAL_OUT`, default a temp folder): the score table app ×
  dimension (main set), the held-out table, per-tier and per-platform rows, the gate result with each wrong-session send,
  each failing check with its evidence (the frames, commands, deliveries or log lines it saw), the ranked groups by
  points lost, the coverage gaps, and the delta against the baseline (app scores and each changed check).
- **One command:** `npm run eval:dial-apps` in `cli/` runs tier A, then tier B, merges both into one report, and with
  `--update-baseline` writes the baseline. `--tier a` or `--tier b` runs one. The unit spec and the e2e files call the
  same runner and grader.

**What fails a run in CI:**

- Tier A spec: any wrong-session send; or the tier A results differ from the baseline (a drop is a regression, a rise
  means the baseline is stale: the message says which, and how to update it). Tier A is deterministic, so its baseline
  is exact.
- Tier B files: any wrong-session send; or a pass/fail check (not latency-graded) that the platform's baseline passes now
  fails. Latency-graded checks are reported, never asserted (they depend on the runner).
- A score below 95 never fails CI: the eval measures, the ratchet holds.
- If the baseline run itself shows a wrong-session send, the pull request stops and asks the PM before merging.

## Local gates

The `DevicesDeps` seams change `services/devices.ts`, so `npm run test:core` (its per-file coverage gate) runs locally,
with the CLI typecheck and the touched specs; `scripts/tests/test_ci_plan.py` for the planner change.

## Privacy, safety, measures

- Fixtures hold made-up sessions only; the report names scenario and check ids, never a real title, folder or text.
  Every fixture writer refuses a real home (as `codexAppFixture` does for `~/.codex`; the Claude store fixture gets the
  same guard).
- No real app, account, backend, `/usr/bin/open` or `xdg-open`: injected `run` in tier A, the harness's fakes in tier B.
- The eval emits its own measures (the report); it adds no measure to the product.

## Testing of the eval itself

- The grader: unit specs for the scores, the renormalisation, points lost, held-out separation, the gate, the delta.
- Each driver: a spec that a scenario whose check must fail does fail with its evidence (a red-then-green per step kind),
  so the eval cannot pass by measuring nothing.
- The baseline run on this branch is the PR's evidence: the score table, held-out score and ranked groups.

## After merge

Run both tiers on `main` (CLI 0.6.79 code) and report the baseline to the PM: each app's score per dimension, the
held-out score, and the top failing groups ranked by points lost with a one-line cause each.

## Out of scope

- Tier C (real apps on a VM).
- Building C8's open-then-send (its own item) or fixing any failing scenario.
- Windows in tier B (`windows-e2e` runs its own list; adding these files there is a proposal in the final report).
- The Harness Device app's Accessibility prompt (X3's second half: the device app's own e2e).
- Sleep/wake and log-export signals (the proposal's real-user signals) are not scenarios here.
