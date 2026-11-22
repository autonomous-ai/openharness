# Dial eval for the Orca app

Branch: `feat/dial-eval-orca`. Component: `cli/`, test code and the e2e harness only, plus `scripts/ci-plan.py` and its
test, which decide when tier B runs on a pull request.

Platforms:
- tier A: macOS, Linux and Windows, each OS branch the devices code has for Orca, chosen by an injected platform;
- tier B: macOS and Linux. Windows tier B is a gap, listed beside the score.

Orca ships for macOS and Linux (a .deb and an AppImage, `src/testing/recordedOrca.ts`); the code also has a Windows
(`Orca.exe`) branch. Tier A drives all three, and the report lists what it cannot drive.

Nothing a person sees changes, and no product code changes: every stand-in is a `vi.mock`, an existing `DevicesDeps`
seam (`orca`, `orcaReads`, `orcaHomes`, `orcaPlugin`, `listen`) or an e2e harness fake. If a task finds it needs a new
seam, it stops and asks the PM.

Source: Diego (2026-11-22), "mở thêm task eval hill-climb cho Orca", under the rules of the Claude/ChatGPT eval:
`docs/plans/2026-11-21-dial-app-eval-design.md` (the **base spec**, merged in #4537). This spec adds a third app, Orca,
to that eval. It builds on the contract `feat/dial-eval-vscode-cursor` adds
(`docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md`, the **editor spec**): an exported `APPS` list, `engine` on a
session and `agentIdOf` keyed by engine, `Partial` app records in the baseline, `Seen.logs`, `machine.appOf`. Wherever
this spec says nothing, the base spec holds, then the editor spec.

**Sequencing.** The editor branch is changing the same files now. This branch writes its spec and plan first; its code
(phase 3) starts only after the editor branch has merged to `main`, rebased onto it. If the editor branch's merged
contract differs from what this spec names, the plan follows the merged code and says so.

## Why

The dial's work in Orca is checked today by pass/fail tests of single paths (`dialOrcaFocus`, `dialOrcaFullRing`,
`dialHostOrcaPane`, `deviceOrca*` e2e files, and the hosts' specs). We want what the Claude and ChatGPT apps have: one
0–100 number for Orca from a fixed scenario set and an automatic grader, a committed baseline that ratchets, and the
failing groups ranked by points lost, which the PM turns into hill-climb items.

## Decisions

Kept from the base spec: dimensions D1–D8 with weights D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5; the latency
thresholds; the **hard gate** (a voice prompt delivered to a session or pane other than the scenario's target fails the
whole run); about 20% of scenarios held out; a target of ≥ 95/100; tiers A and B only; the network guard on.

**Never the real Orca.** No real Orca app and no real `orca` CLI ever runs, and nothing reads or writes Orca's state,
worktrees, terminals or plugins on the machine the eval runs on. This matters more here than for the other apps: the
eval runs inside Orca (every devcrew session does), so the runner's own environment carries Orca's variables and a real
`orca` is on its PATH.
- Tier A refuses every process start (the base spec's `child_process` mock); every `orca` command goes to the injected
  `orca.run`, answered from the scenario's model of Orca.
- Tier B runs only the harness's fake `orca` (`e2e/harness/fakeOrca.ts`), first on the daemon's PATH and as
  `HARNESS_ORCA_APP_BIN` inside the daemon's root (`IsolatedDaemon` already does both). Linux looks for `orca-ide`
  before `orca` (`devices/orcaHomes.ts` `orcaBinary`), and the daemon's PATH ends in the system's folders, where Orca's
  .deb puts a real `orca-ide`: so the fake is installed as both `orca` and `orca-ide`, and the driver checks, before the
  daemon starts, that the binary resolved the way `orcaBinary` resolves it is inside the root.
- Every process the driver starts (hooks, fake agents, the plugin) gets an environment built from scratch: no `ORCA_*`,
  `TMUX*`, `TERM_PROGRAM` or `__CFBundleIdentifier` value of the runner's is passed on, and the plugin's `HOME` and
  `PATH` are the throwaway home's, with a `harness` shim there, as `dialStream.e2e.ts` does, so it reaches only the
  isolated daemon.
- **No maker walk reaches the runner's terminal.** The maker check walks up from a hook's caller to whatever made its
  tty; from the test worker that is the real Orca running this session. So every Orca agent in tier B, and each of its
  hooks, runs inside a terminal-host stand-in (`orcaHost.ts`), whose name decides own or held.
- A spec asserts each of these three rules.

PM decisions, 2026-11-21, scored as expected behavior:
1. **Agents in another worktree's terminals are skipped.** While Orca is in front and the plugin has said which
   worktree is on screen, the ring lists only agents whose terminal is in that worktree.
2. **tmux inside Orca stays off the ring.** An agent under tmux in an Orca pane is not an Orca row.

PM, 2026-11-22:
3. **Graded on what the person expects, even where no path exists yet**, as the editor spec's decision 1: where the
   person expects the ring or the dial to follow a change and the code has no path for it today, the scenario grades
   the expectation and fails at baseline. Those failures are the hill-climb items. Two such cases:
   - a pane closed while its agent was running, with no end hook (O15);
   - Orca in front on Linux and Windows: `frontAppId` (`cable/hosts/frontApp.ts`) maps no Linux or Windows front name to
     Orca, so the scope, the focus watch and the prompt follow never start there. Every platform is graded on the same
     expectation, and the front goes through `frontAppId` with the platform's own front name in both tiers (below).

## What the dial does with Orca (from the code)

### How the daemon learns Orca's agents

- **Agents** come from their own hooks (Claude Code or Codex in an Orca pane): `hook/notify.mjs` passes
  `ORCA_AGENT_SESSION_ID` and `ORCA_TERMINAL_HANDLE`; the host is `orca` when `ORCA_AGENT_SESSION_ID` is set or the
  bundle id is `com.stablyai.orca` (`hostDetect.ts`). The pane is the handle (`term_<uuid>`, `orca.ts` `paneOf`).
- **Held panes.** The pane takes words only when Orca's terminal host made the agent's terminal: the maker process is
  named `Orca Agents`, `orca-agents` or `orca-ide` (`scannedApp.ts`), read once per caller in the background. Anything
  else, or a maker not read yet, makes the pane **held**, logged once as `[device] orca · held`. Windows skips the maker
  check and trusts the handle.
- **Layout.** `orca terminal list --json --include-visual-layouts`, read only while a dial is attached, one read at a
  time, and only when the set of Orca agents or their panes changes; no polling. The walk stops at 64 worktrees, 256
  handles, depth 32.
- **Focus.** A long-running `orca terminal watch-focus --json`, started when Orca settles in front (1 s) with a dial
  attached, only if `orca terminal --help` lists `watch-focus` (cached per binary path and mtime).
- **The worktree on screen** is pushed by the Orca plugin (set up by default since #4498): on each `workspace.changed`
  it sends `{type:"orcaFront", terminals}` (at most 50) over the devices' listener socket, found with
  `harness device orca link`. The listener takes it only while the plugin's `dial` stream is open; when the stream ends
  the scope is cleared.

### Ring

- **One row per agent** on the `orca` page; a terminal with no agent has no row.
- **Scope** (decision 1): with the dial's `appFilter`, Orca settled in front and the plugin's front known, only agents
  whose shown terminal (own pane, then placed pane, then held pane: `shownAt`, #4534) is in that front.
- **Order:** Orca's tab order from the layout read: worktrees as listed, then group, tab and pane, each split's `first`
  before `second`. Agents with no Orca pane (no layout, or tmux inside Orca: `paneOf` gives none under tmux) go after
  the ranked ones unless elimination placed them (one free terminal and one unplaced agent in the same worktree and
  identity). They have no shown terminal, so a scope leaves them out.
- **tmux inside Orca** (decision 2): a real tmux started in an Orca pane hands its agents the variables it was started
  with: `TMUX`, `TMUX_PANE`, Orca's `ORCA_AGENT_SESSION_ID` and `ORCA_TERMINAL_HANDLE`, and on macOS
  `__CFBundleIdentifier=com.stablyai.orca`. With the bundle id the host is `orca` but the agent has no pane; without it
  the host is `tmux` (`hostDetect.ts`). O11 carries exactly these hints per platform.
- **Names:** a tab the person renamed wins; then the session's own title; then the tab's title; then the folder's name.
- **Cap:** 16 (`select.ts`): needs-you first, then most recent activity; with a full ring an agent enters only if it
  needs the person, replacing the idle agent that rested longest.
- **Two-step ring** (#4522): when the held tiles plus the new ring pass 16, step 1 sends only the held agents in the new
  ring, step 2 the full ring 1 s later (longer while voice is open), so the firmware never refuses a tile and never
  holds tiles with none on the face ("Choose a pane"). When the two rings share no agent, step 1 is empty: the dial
  holds no tile for that second, which is not "Choose a pane", and the first agent of step 2 goes on the face.

### Follow

- **Focus:** each watch line turns the dial to the agent in that pane (never a held pane), unless it echoes a switch
  the dial made in the last 2 s, or Orca is not the settled front app.
- **Prompt:** a person's prompt (`UserPromptSubmit`) moves the dial while Orca is the settled front app. While a watch
  runs, a prompt in an agent with its own Orca pane is skipped (the focus already followed); an agent in a held pane
  (#4534) still moves it.

### Open

- **Switch** (`orca.ts` `switchTo`, for a tap and a rest alike): `orca worktree activate --worktree id:<w> --json`
  whenever the last layout read named the handle's worktree (the shown one too), then `orca terminal switch --terminal
  <h> --json`.
- **Tap:** the switch, then Orca brought forward: `open -b com.stablyai.orca` on macOS, `windowsRaise.app` (`Orca.exe`)
  on Windows, the window raise by pid on Linux. A tap works on a held pane.
- **Swipe rest** (400 ms): the switch only, no raise; never on a held pane.

### State, voice, recap

- **State** from hooks only: working, needs-you, done after the 1.5 s answer grace, idle.
- **Voice**, routes in order: the Codex queue (a Codex session under the daemon's own `CODEX_HOME`); the Claude Code
  mod's inbox when its poll is ready; else typing into the agent's pane, `orca terminal send --terminal <h>
  --text=<line> --enter --wait-submit 5 --json`, only for a pane that is not held, the same pane as before the wait, and
  an idle agent. Control characters become spaces.
- **Recap:** the last answer from the agent's transcript (Claude Code and Codex), cut to 300 characters.

## Scenarios

They use the base spec's catalog, runner, grader, report and baseline (`cli/src/testing/dialAppEval/`). `App` gains
`orca`, its page the wire's app id `orca`. Every scenario has the base spec's ghost probe. Every scenario runs on every
platform and in both tiers unless its entry says otherwise, and every tier B scenario carries the three D8 checks.

An Orca agent is Claude Code (engine `claude`, the default) or Codex (engine `codex`) in an Orca pane. Unless a
scenario says otherwise: the plugin is set up and its stream open, Orca is in front, `watch-focus` is supported, each
agent's terminal was made by Orca's host, and a Codex agent's `CODEX_HOME` is a folder of its own (an Orca account's,
not the daemon's), so its words are typed.

### Main set (17)

- **O1.** Two worktrees, five agents: Claude Code and Codex, one in a split pane, one in a tab the person renamed. The
  plugin's front is unknown (no `workspace.changed` yet). → The ring has exactly those five in Orca's tab order, each by
  the name rule. (D1)
- **O2.** The plugin says worktree W1 is on screen → only W1's agents are listed; an agent whose terminal is in W2
  (though its folder is W1's) is not (decision 1). The person opens W2 → the ring becomes W2's, graded on `ringChange`.
  (D1, D7)
- **O3.** The two-step ring: 16 agents in W1 on the face, then the person opens W2, which has 16 others → no tile is
  ever refused, the dial never holds tiles with none on the face (check `face`), and it ends on W2's 16 with one of them
  on the face. (D1, D7)
- **O4.** The person focuses another pane in Orca (a watch-focus line) → the dial follows within 1 s; the dial's own
  tap, echoed back by the watch, does not bounce it. (D2)
- **O5.** An older Orca whose `terminal --help` has no `watch-focus` → a prompt typed in another agent moves the dial
  within 1 s. (D2)
- **O6.** An agent in a held pane (its terminal made by another program) → a prompt typed there moves the dial to it
  (#4534). (D2, D1)
- **O7.** A tap on an agent in the other worktree → its worktree is activated, its pane switched, then Orca brought
  forward by the platform's command, in that order. A swipe rest on another agent → its worktree activated and its pane
  switched, with no raise. (D3)
- **O8.** A Claude Code turn in an Orca pane → working, needs-you on a permission, then done; the recap is its last
  answer. A Codex turn → working, then done, with its recap. (D4, D6)
- **O9.** Voice on a Claude Code agent at rest in an Orca pane (mod ready) → the exact text reaches it once, through the
  mod; nothing is typed into any pane. (D5)
- **O10.** Voice on a Codex agent at rest in an Orca pane → `orca terminal send` to its handle only, once, with the
  exact text; no other pane gets words. (D5, gate)
- **O11.** Claude Code under tmux in an Orca pane, beside two plain Orca agents, with the hints a real tmux there hands
  on (Ring above) → it is not on the Orca ring (decision 2); the two are, in order. (D1)
- **O12.** Orca quits (its agents end, the watch ends, the plugin stream closes) and relaunches: Orca comes back in
  front, its agents come back with the same session ids in new terminals (new handles), and the plugin re-sends its
  front → the ring comes back right with no duplicate rows, and stays right past the devices' next 30 s observed tick
  after the relaunch; a focus line after that tick is followed. The wait past the tick makes the check the same on
  every run, whatever the tick's phase. (D7, D1, D2)
- **O13.** The plugin is missing or disabled (no `dial` stream ever opens) → every Orca agent is listed in tab order,
  and a tap still switches the pane and brings Orca forward. (D7, D1, D3)
- **O14.** A worktree is added with an agent in it, then another worktree is removed with its agent (its terminals
  close and the agent's process ends with no end hook, as O15's close) → the new agent joins in tab order and the
  removed one leaves, each graded on `ringChange`. Both tiers model the removal with the same events. (D7, D1)
- **O15.** The person splits a pane and starts an agent in the new half → it is listed right after its sibling. Then
  they close a pane whose agent is running (its process ends with no end hook) → it leaves, graded on `ringChange`
  (decision 3). (D7, D1)
- **O16.** Many worktrees: 40 worktrees with one agent each, one of them needing the person → the ring has 16, the
  needs-you agent among them, in tab order; tier B's event-loop p99 is graded as D8. Tier A and B. (D1, D7, D8)
- **O17.** The dial is unplugged and plugged back in → the ring and the focused row come back, and a tap then switches
  that agent's pane. (D7, D3)

### Held-out set (4 of 21, 19%)

In `heldOut.ts` beside the other apps' held-out scenarios, scored and reported apart; whoever fixes a group never reads
them.

- **OH1.** Voice on the focused Codex agent while another Orca agent is working → only the focused one gets the words.
  (D5, gate)
- **OH2.** Voice 200 ms after a focus line moved the dial → the text reaches the newly focused agent's pane. (D5, gate)
  macOS only for now (PM, 2026-11-22): on Linux and Windows the dial never follows (decision 3's `frontAppId` gap), so
  the words reach the agent the dial still shows, a wrong-session send. Those two platforms are listed as a coverage gap
  beside the score, named for that cause, until the item "Orca in front on Linux and Windows (`frontAppId`)" merges;
  then OH2 runs on all three.
- **OH3.** A tap on an agent in a held pane → its pane is switched and Orca brought forward. (D3)
- **OH4.** Two Claude Code agents in the same worktree, one with no handle in its hook (elimination) → each is its own
  row, in tab order. (D1)

A bug reported from now on in Orca becomes a scenario in this catalog.

### Expected to fail at baseline (from the code; not graded, the baseline run is the truth)

- **O15's close, O14's removal:** the leave waits for the observed tick (30 s) and the 10 s end delay.
- **O12:** the watch restarts only at Orca's next settle, so a focus line right after the relaunch may be missed.
- **Linux and Windows:** every check that needs Orca in front (O2–O6, O12, OH2), since `frontAppId` has no Orca entry
  there (decision 3).
- **O11 on macOS, unscoped:** with the bundle id an agent under tmux is an Orca agent with no pane; it is out of the
  scope, but listed whenever no scope holds.

### Not graded

- The bounds themselves (64 worktrees, 256 handles, 50 front terminals, 20,000 characters): a scenario past a bound would
  push a bound out, which the tech limits forbid. O16 stays inside them.
- Orca account homes (`orca account list`): answered with the account homes the scenario's Codex agents run in, as a
  real Orca lists them, and nothing else; the reading of those homes is not graded on its own.
- Tab drags with no agent change (no signal reaches the daemon, as the editor spec's decision 2).

## Contract additions

On top of the editor spec's contract:
- **App and page:** `orca` in `App` and `APPS`; `PAGE.orca = 'orca'`; Orca's rows in the report after the others, as
  the editor spec adds its apps.
- **SessionDef:** `worktree` (its Orca worktree's key), `tab` and `split` (where its pane sits in the layout),
  `handle` (fixed made-up `term_<uuid>`; `none` for OH4), `held: true` (its terminal's maker is another program). O11
  uses the editor contract's `tmux`.
- **World:** `orca: { watchFocus?: false; plugin?: false }`.
- **Steps:**
  - `orca.layout`: Orca's worktrees, tabs and splits, with each pane's handle and title, as `terminal list` answers;
  - `orca.focus`: a watch-focus line for a session's pane;
  - `orca.front`: the worktree on screen; the plugin's `orcaFront` carries its open terminals. As Orca's
    `workspace.changed` does (`docs/plans/2026-11-18-dial-orca-tab-scope-design.md`), the world sends it again each
    time a terminal of the shown worktree opens, closes or is renamed, in both tiers;
  - `orca.plugin`: the plugin's `dial` stream opens or closes;
  - `quit` and `relaunch` with `app: 'orca'`: its agents end, the watch and the plugin stream close, then all come back.
  A typed prompt is the base spec's `turn-start` hook from the person.
- **Checks:**
  - `open` grades an Orca row by what the person sees: the last `worktree activate` before the switch (if any) names
    the session's worktree, `terminal switch` names its handle, then the platform's raise ran, in that order, timed from
    the tap frame to the raise; a rest grades the switch and that no raise ran.
  - `face` (pass/fail, the scenario's dimension): from its label on, the carousel model (`src/testing/dialCarousel.ts`)
    refused no tile, and never held tiles with none on the face. `Seen.faces` gains each face's refused count, so the
    first half can fail.
- **Front:** an Orca `front` step gives the platform's own front name (macOS the bundle id `com.stablyai.orca`; Linux
  the main process's executable name `orca-ide`, as `src/testing/recordedOrca.ts` records; Windows `orca.exe`), mapped through the real `frontAppId` in tier A and through
  `harness hardware watch` in tier B, so a platform the product cannot tell Orca on fails there.
- **Deliveries:** a typed delivery through `orca terminal send` gets the session whose handle it names as its target,
  so a send to another pane, or to a handle no session owns, is a wrong-session send (gate).

## Tier A

The base spec's tier A holds, with these additions. `orca.ts` stays real: the world answers through the `orca`
deps (`run`, `onPath`, `exists`, `platform`, `spawn`, `mtime`), not `orcaReads`, so the real parsing and ordering are
graded.
- The world answers `orca terminal --help` (with or without `watch-focus`), `terminal list` from the scenario's layout,
  `worktree activate`, `terminal switch` and `terminal send` (recorded, the send as a typed delivery), and `account
  list` (empty). `orca` joins the answered commands.
- `terminal watch-focus` is the injected `spawn`'s child; `orca.focus` writes its line.
- The maker check reads the scenario's machine model, as `ptyMaker` (`scannedApp.ts`) reads a real one: the agent and
  its shell share a tty, and their parent, on no tty, is named for the platform's Orca host (`Orca Agents` on macOS,
  `orca-agents` on Linux), or another name for a `held` one.
- The `orca` deps never reach the real machine: `onPath` answers from the model without `realpathSync`;
  `HARNESS_ORCA_APP_BIN` names a made-up path inside the spec's temp root for the spec's run (`vi.stubEnv`), and `exists`
  answers for it alone; `mtime` answers a fixed time, so the `watch-focus` probe is cached as in a real run.
- The plugin: `orca.plugin` opens or ends the devices' own `dial` stream handler, taken from `world.listener`;
  `orca.front` sends `orcaFront` on it.
- Hooks carry `ORCA_AGENT_SESSION_ID` and the session's `ORCA_TERMINAL_HANDLE` in their hints; `tmux` ones carry
  `TMUX`/`TMUX_PANE` too.
- **OS branches:** darwin, linux and win32, with the platform given to the `orca` deps, the open and raise deps and the
  mocked `learnApps`. A branch that reads `process.platform` and cannot be chosen (`orcaHomesDeps`, the plugin's own
  `inputs.platform`) is listed as a coverage gap for that scenario and platform, as the base spec says.

## Tier B

The base spec's tier B holds, with these additions, in `cli/e2e/harness/appEvalOrca.ts` (`orcaSteps`) and a new file
`cli/e2e/dialAppEvalOrca.e2e.ts`; the held-out file's map gains `orca`.
- The fake `orca` (`fakeOrca.ts`) answers the layout and the focus file; its run log, with a time for each run, becomes
  `Seen.commands`, and its `terminal send` runs become typed deliveries. It gains what the scenarios need (harness code
  only): `terminals` rows with each pane's worktree path and agent identity as Orca prints them, a title per pane (the
  catalog's "Eval " names), and an end to the `watch-focus` child for O12's quit.
- Every Orca agent and its hooks run inside the terminal-host stand-in (`orcaHost.ts`): Claude Code through `InOrca`,
  Codex through a Codex outside run in the stand-in too. `orcaHost.ts` gains a name option, so a `held` agent's host has
  another name. An agent ends when its stand-in's process ends.
- The plugin is the harness's existing `pluginDial.ts`, which runs the plugin's own loop, with the safety rules above;
  `orca.front` makes it send `orcaFront`, so O2, O3, O12 and O13 run end to end.
- The front: Orca's entry in the driver's `FRONT` table per platform, from the platform's own front name (Contract).
- A tap's raise on Linux is not recorded in tier B (the base driver's gap); the open checks' raise part is left out
  there and listed.
- Windows tier B: a gap, listed.
- One file under about 6 minutes on a CI runner, with a hint in `cli/ci-e2e-durations.json`. O3 (32 agents) and O16
  (40) use the lightest agent stand-in the stand-in host allows, and daemons are reused across scenarios as the base
  driver does; the plan's first tier B task measures O3 and, if the budget does not hold, makes O16 tier A only and
  says so in the report.

## Wiring

- `run.ts` `FILES.b` and `runner.ts` `SOURCES.b` gain the Orca file and source `orca`.
- `npm run eval:dial-apps` reports Orca beside the other apps; `--update-baseline` writes its tier A keys and its
  `b/darwin` keys (Linux stays gate-only, as for the other apps).
- **The ratchet:** the tier A spec fails on any change from the baseline; tier B files fail on a wrong-session send or a
  baseline-passing pass/fail check that now fails. The other apps' tier A results must not change in this branch;
  their tier B latency is written as measured, as the editor spec does.
- **PR CI:** `scripts/ci-plan.py`'s `LINUX_E2E_APP_EVAL_FILES` gains `dialAppEvalOrca.e2e.ts`;
  `LINUX_E2E_APP_EVAL_PATHS` gains the Orca harness files the driver uses (`fakeOrca.ts`, `inOrca.ts`, `orcaHost.ts`,
  `pluginDial.ts`) and `plugins/harness-device-orca/`; `scripts/tests/test_ci_plan.py` and the table row in
  `docs/validation-and-release.md` follow.

## Local gates

The CLI typecheck and the touched specs; `scripts/tests/test_ci_plan.py` for the planner change. No product file
changes, so `npm run test:core` is not required unless a task touches `services/devices.ts`.

## Privacy, safety, measures

- Fixtures hold made-up agents only: titles start with "Eval ", folders with `/work/eval-`, handles and ids are fixed
  made-up UUIDs. The report names scenario and check ids, never a real title, folder, handle or text.
- No real Orca, `orca` CLI, plugin, Claude Code, Codex, account, backend, `open` or `xdg-open`.
- The eval adds no measure to the product.

## Testing of the eval itself

- Each new step kind and the `face` check: a spec that a scenario whose check must fail does fail with its evidence
  (red then green), so the eval cannot pass by measuring nothing.
- The typed-delivery target: a send to another session's handle, and to an unknown handle, are each reported as a
  wrong-session send.
- The safety rules: specs that tier B's spawned environments carry none of the runner's `ORCA_*`, `TMUX*`,
  `TERM_PROGRAM` or `__CFBundleIdentifier`; that the driver refuses an `orca` or `orca-ide` resolved outside the root;
  that the plugin's `HOME`, `PATH` and `harness` are the throwaway home's; and that no Orca agent's hook runs outside a
  stand-in host.

## After merge

Run both tiers on `main` and report the baseline to the PM: Orca's score per dimension, the held-out score, the
wrong-session count, and the failing groups ranked by points lost with a one-line cause each, plus the coverage gaps
beside the score.

## Out of scope

- Fixing any failing scenario (each is its own hill-climb item).
- Tier C, and Windows tier B.
- The plugin's own install and approval flow (`orcaPluginSetup.ts`, its own specs).
