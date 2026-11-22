# Dial eval for iTerm2

Branch: `feat/dial-eval-iterm2`. Component: `cli/`, test code and the e2e harness only. Platforms:
- tier A: macOS only, as iTerm2 exists only there;
- tier B: macOS only, run locally by the tester.

Nothing a person sees changes, and no product code changes. Every stand-in is a `vi.mock` or an existing
`DevicesDeps` seam. If a task finds it needs a new seam, it stops and asks the PM.

Source: the PM's item "Dial + iTerm2", Part 2 (2026-11-22). The rules are the Claude/ChatGPT eval's,
`docs/plans/2026-11-21-dial-app-eval-design.md` (the **base spec**, #4537), and the VS Code/Cursor addition,
`docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md` (the **editors spec**, #4543). This spec adds one app. Wherever
it says nothing, those two hold.

Part 1 (#4544) fixed the live bug, Diego's iTerm2 with a plain tab, a tmux tab and a herdr tab with two panes. Its exact
case becomes scenarios I2 and I3 here.

Sequencing (PM, 2026-11-22): the Orca eval edits the same files. This branch writes its spec and plan now. Its code
starts only after Orca has merged, on a rebase onto `main`. Orca merged as #4551 (`135c5e99fa`, 2026-11-23), and the
plan is reconciled with it ("Reconciled with Orca's merge").

## Why

The dial's work in iTerm2 is checked today by pass/fail tests of single paths:
- `dialTmuxTerminal.e2e.ts`, `dialHerdrTerminal.e2e.ts` and `dialTerminalFollow.e2e.ts`;
- the hosts' specs.

#4544 showed what that misses: four agents in one app, three hosts nested in it, and a restart. We want what the other
apps now have:
- one 0–100 number for iTerm2;
- a committed baseline that ratchets;
- the failing groups, ranked by points lost.

## Decisions

Kept from the base spec:
- dimensions D1–D8, with weights D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5;
- the latency thresholds;
- the **hard gate**: a voice prompt delivered to a session other than the scenario's target fails the whole run;
- about 20% of scenarios held out;
- a target of ≥ 95/100;
- tiers A and B only;
- the network guard on.

No real iTerm2, tmux server or herdr of the person's ever runs or is read. Every home, tmux socket, herdr config, app
bundle and `open` is a throwaway inside the run's own root.

PM, 2026-11-22 (confirmed):
1. **Graded on what the person expects, even where no path exists yet** (as the editors spec's decision 1). Today
   nothing reaches Harness when the person moves focus to another tmux pane or herdr pane inside the tab that is already
   selected: the tab's tty does not change. Scenarios I10 and I11 grade the dial following that pane, and fail at
   baseline. Those failures are hill-climb items.
2. **macOS only, in both tiers.** iTerm2 runs on macOS alone. The tmux and herdr paths shared with Linux are graded
   through iTerm2 on macOS; a Linux app (Ghostty, WezTerm) is its own eval item later.
3. **Tier B is graded on the tester's local macOS run.** No GitHub workflow runs macOS e2e (#4500 and #4544 proposed
   one), so PR CI guards iTerm2 through tier A alone. The baseline's tier B entries come from the tester's run, and the
   final report repeats the macOS e2e workflow proposal.

## What the dial does in iTerm2 (from the code)

### Ring

- **Sources.** Rows come from the observed source: hooks, plus the open scan. herdr's own source (`herdrSource.ts`) lists
  herdr's agents; a row that carries a session id folds into the observed copy (`registry.ts`).
- **The app.**
  - A plain tab's hook names iTerm2 by `TERM_PROGRAM=iTerm.app` or its bundle id (`hostDetect.ts`).
  - An agent in tmux or herdr is placed on the app holding the multiplexer's client (`tmux.ts createTmuxOuter`,
    `herdrOuter.ts`, `outer.ts firstOuter`).
  - A session the scan found is placed the same way by process (`createTmuxNested`, `createHerdrNested`, #4544).
  - The client's app comes from its parent processes. iTerm2's shells hang under `iTermServer-<version>`, which counts as
    iTerm2 even when its parent is launchd (`scannedApp.ts`).
- **Order, names, limit.** As the base spec: 16 a ring (`select.ts`). A name is the pane's, then the hook's title, then
  the folder's.

### Follow

- **Tab.** `harness hardware watch` reports the selected tab of the tab app in front, a `tab` message
  `{"type":"tab","app":"iterm","tty":…}` (`devicesListener.ts tabHandler`, wired in `devices.ts`). Once iTerm2 has settled
  in front, the dial moves to the live agent in that tab (`observed.ts byTab`; of two, the one heard from last).
- **Echo.** Two rules skip a report (`devices.ts followTab`): the dial moved while the report waited for the settle, or
  the dial itself selected that tty within the last 2 s.
- **Prompt.** A prompt typed while iTerm2 is the settled front app follows the agent (`followPrompt`).
- **Pane inside a tab:** not followed (decision 1).
- **A nested agent's tab** is looked up at its session's start, at each turn's start, and when its caller or hints
  change (`observed.ts askOuter`), and once by the scan (#4544). It is not looked up again when tmux detaches or
  attaches, or iTerm2 relaunches.

### Open

- **The tabs stream** carries the devices' lines one way: `{"app":"iterm","tty":…}`, with `"raise":true` for a tap
  (`devicesListener.ts`). The watch prints it as `{"select":{"app":…,"tty":…,"raise":true}}` (`devices/client.ts`).
- **Tab row.** The tabs adapter comes after its app (`tabs.ts`, `tap: 'after'`). A tap runs
  `open -b com.googlecode.iterm2` first, then writes the select with `raise` (`observed.ts raiseAfter`). A rest while
  iTerm2 is in front writes the select without `raise`.
- **tmux row.** Its pane comes before its app (`tmux.ts`, `tap: 'before'`).
  - A tap checks the pane (`display-message` and the process table), selects it in one run
    (`select-window ; select-pane`), brings iTerm2 forward, then selects the client's tab.
  - With no app holding a client, it runs `switch-client` for the client used last.
  - A rest selects the tab first, then the pane (`observed.ts shown`).
- **herdr row.** As tmux's: a tap runs `herdr agent focus <pane>`, then `open -b`, then the tab; a rest the tab, then
  the pane (`herdr.ts`). A scan-found herdr agent has its pane only when herdr's own row gives the session
  (`herdr integration install claude`).
- The `open` check grades what ran and the tab each select names, not the order between the pane and the tab on a tap.

### State, voice and recap

- **State** from hooks (`observed.ts`), and for herdr's own rows from herdr's status.
- **Voice.**
  - Claude Code anywhere: the Claude Code mod's inbox, first whenever its mod polls (`observed.ts`).
  - Codex: its queue, only for a transcript under the daemon's `CODEX_HOME`.
  - herdr's adapter types into the agent's own herdr pane (`herdr.ts type`), only where herdr made the agent's terminal
    and its socket answers. A Claude Code whose mod polls never reaches it.
  - The tabs adapter and tmux's have no `type`: nothing types into a tab or a tmux pane.
- **Recap.** The last answer from the transcript, for `claude` and `codex`.

## Scenarios

They use the base spec's catalog, types, runner, grader, report and baseline (`cli/src/testing/dialAppEval/`):
- `App` gains `iterm`, and its page is the wire's app id `iterm`.
- Every scenario has the base spec's ghost probe.
- Every scenario runs in both tiers unless its entry says otherwise.
- Every tier B scenario carries the three D8 checks.

Sessions are Claude Code unless a scenario says Codex. A session at **rest** is a live, idle one; iTerm2 has no store, so
a session with no process is never listed.

### Main set (21)

herdr's row gives the session in every herdr scenario but IH4.

- **I1.** One window, one tab running Claude Code → one row on iTerm2's page, its title as its name. (D1)
- **I2.** The #4544 case, hooked: a plain tab, a tab running tmux with Claude Code, a tab running herdr with two Claude
  Code panes → four rows on iTerm2's page, none on tmux's, herdr's or Other's. (D1)
- **I3.** The #4544 case, scan-found: the same four, idle, then the devices start again → the same four rows, before any
  hook. (D1, D7)
- **I4.** A tab split into two panes, Claude Code in each → two rows. A tap on each selects its own pane's tty. (D1, D3)
- **I5.** Tap the plain tab's row → iTerm2 brought forward, and the select with `raise` for its tty. (D3)
- **I6.** Rest on the tmux row while iTerm2 is in front → its client's tab is selected, then its pane. (D3)
- **I7.** Tap each herdr row → `herdr agent focus` on its own pane, iTerm2 brought forward, and its client's tab. (D3)
- **I8.** The person selects another tab in iTerm2 → the dial follows to that tab's agent within 1 s of the settle.
  (D2)
- **I9.** The dial selects a tab, and iTerm2 reports that tab back → the dial does not move again (the echo rules). (D2,
  D7)
- **I10.** The person moves to another tmux pane in the selected tab (`select-pane`) → the dial follows to that pane's
  agent. Fails at baseline (decision 1). (D2)
- **I11.** The person moves to the other herdr pane in the selected tab → the dial follows to it. Fails at baseline
  (decision 1). (D2)
- **I12.** A tab is closed (its agent ends) → its row leaves; a new tab with a new agent → a new row. (D1, D7)
- **I13.** tmux detached, then attached from another tab, with no turn after → the row stays on iTerm2's page, and a tap
  goes to the new client's tab. Fails at baseline: the tab is looked up again only at a turn. (D7, D3)
- **I14.** herdr restarted (server and agents end, then start again) → the rows come back, one each, no leftovers. (D7,
  D1)
- **I15.** iTerm2 relaunched keeping its sessions (`iTermServer` now under launchd), then the devices start again → the
  tmux and herdr agents are on iTerm2's page with their tabs. (D7, D1)
- **I16.** A long turn in the plain tab → working, then done; the last answer is the recap. (D4, D6)
- **I17.** Claude Code in tmux asks for a permission → needs-you. (D4)
- **I18.** Voice on the focused plain tab's agent → the exact text reaches it, once. (D5)
- **I19.** Voice on the tmux agent → the exact text reaches it, once. (D5)
- **I20.** Voice on one herdr pane's agent while the other pane's agent is idle → only the target gets it. (D5, gate)
- **I21.** Unplug and replug the dial → the ring and the focused row come back. (D7)

### Held-out set (5 of 26, 19%)

In `heldOut.ts` beside the others' held-out scenarios (the tier B ones in `dialAppEvalHeldOut.e2e.ts`), scored and
reported apart, never read by whoever fixes a group.

- **IH1.** Voice 200 ms after a tab selection moved the dial → the text reaches the newly followed agent. (D5, gate)
- **IH2.** One tmux session with clients in two tabs; the person types into the second tab's client, then the agent's
  turn starts → a tap goes to the second tab. (D3)
- **IH3.** 20 tabs with agents → the ring keeps 16. Tier A only. (D1)
- **IH4.** A scan-found herdr agent whose herdr row has no session → one row on iTerm2's page, and a tap reaches its
  tab. Fails at baseline: two rows until its first hook (#4544's non-goal). (D1, D3)
- **IH5.** Codex in a tmux pane, under the daemon's `CODEX_HOME` → working, then done, with its recap. (D4, D6)

A bug reported from now on in iTerm2 becomes a scenario in this catalog.

### Expected to fail at baseline (from the code)

Not graded; the baseline run is the truth.
- I10 and I11 (decision 1).
- I13: a nested agent's tab is looked up again only at a turn.
- IH4 (#4544's non-goal).

### Catalog additions

- **SessionDef.** Reuse the fields the other branches define, never a second one of another meaning: the editors'
  `window`, and Orca's `tab` and `split` (`types.ts`, #4551). Add only:
  - `place`: `tab`, `tmux` or `herdr` for `iterm`;
  - `herdrSession: false`: herdr's row gives no session id (IH4).
- **World.**
  - `iterm`: its windows, tabs and splits, each with a tty in macOS's form;
  - `itermServer: 'app' | 'launchd'`: the server's parent;
  - a tmux server with its sessions and clients: Orca's tmux model (its decision 5, inline in `tierA/steps/sessions.ts`
    `orcaPane` on `main`), not a second one: the plan moves it into one module both apps run on;
  - a herdr server with its panes and clients.
- **Steps.**
  - `iterm.tab` and `iterm.closeTab`, `iterm.split`, `iterm.select` (the watch reports a tab as selected), and
    `iterm.relaunch` (the server goes to launchd, the sessions stay);
  - `tmux.detach`, `tmux.attach`, and `tmux.selectPane` (the person's own pane move);
  - `herdr.focus` (the person's own pane move) and `herdr.restart`;
  - `devices.restart`: the devices process starts again while every session stays.
- **Checks.**
  - `open` grades an iTerm2 row by its place, by what ran and the tab each select names:
    - a tab: iTerm2 brought forward, and the select for its tty with `raise` on a tap;
    - tmux: also its pane's select on its own session;
    - herdr: also `herdr agent focus` for its pane.
  - `follow` gains the tab report as its trigger.
- **Seen** gains the tabs stream's lines (the devices' selects) and the tmux and herdr commands the devices ran, each
  with its time.
- **Shared types** (`types.ts`): `App` gains `iterm`; `FRONT_NAMES` gains iTerm2's front name; `LinkedApp` leaves
  `iterm` out, as it does the editors.

## Tier A

The base and editors specs' tier A holds, with these additions.

### The machine

- iTerm2 is an app process with its bundle id. Each split's shell is a child of the `iTermServer-<version>` process,
  whose parent is iTerm2 or, after `iterm.relaunch`, launchd.
- tmux: the server is launchd's child. Each pane's shell is the server's child, on a tty of its own. Each client runs
  under a tab's shell, on that tab's tty.
- herdr: the server is its first client's child. Each pane's shell is the server's child. Each client runs under a tab's
  shell.
- `readProcessNames`, `readTtyName` and the process table answer from this model, the learnt walk through the real
  `scannedApps` rows.
- **Tty forms.** `DevicesDeps.tty` answers `/dev/ttysNNN` (`tabs.ts readTty`), and `readTtyName` the bare `ttysNNN`
  (`scannedApp.ts`). The world keeps one form and gives each reader its own.

### tmux and herdr

- **tmux.** For an iTerm2 scenario only, the `ensureTmuxOnPath` mock answers `adopted` at a made-up path, so the devices'
  tmux runs go through `DevicesDeps.orca.run` to the world. Every other scenario keeps today's answer, so no other app's
  baseline moves. The world answers `display-message`, `list-clients`, `list-panes`, `select-window ; select-pane` and
  `switch-client` from the model, and records each with its time.
- **herdr.** A fake client through `DevicesDeps.herdr`, not a socket server: real socket I/O would escape the driver's
  quiet check, and a path in the temp root can pass the unix socket length limit. It gives herdr's source its list,
  statuses and pane events, and records `agent focus` and typed prompts. The world drives the `watchSocket` mock for
  `herdr.restart`, so the source reconnects at once rather than through its retries.
- **herdrOuter.** `lsof` and `/bin/ps` go through `run` and are answered from the model. `ttyAtime` is `vi.mock`ed to
  answer from the model: unmocked it would `stat` the host's own `/dev/ttysNNN`.
- **Answered commands.** The world's list of commands it answers gains `tmux`, `lsof`, `ps` and `herdr`; any other run
  is a gap, as today.

### devices.restart

The world stops the devices (`ports.devices.stop()`) and starts them again on the same root, the same sessions and the
same dial, as a test-only step of the driver. No product seam.

### Hints

What the hook would send:
- a plain tab: `TERM_PROGRAM=iTerm.app` and iTerm2's bundle id;
- tmux: `TERM_PROGRAM=tmux`, `TMUX_PANE`, and the bundle id the server started with;
- herdr: `HERDR_PANE_ID`, and the `TERM_PROGRAM` and bundle id the server started with.

### The watch

- The driver opens the devices' own tabs stream from `world.listener`, as `steps/editor.ts` opens the `vscode` one, and
  records each line the devices write there.
- `iterm.select` sends the `tab` message through the listener, as `steps/window.ts` sends a window's lines.
- The front app is the base spec's `{front}` step.

### Deliveries

Every path the base and editors specs record counts. So do herdr's typed prompts, as `typed` to the pane they name. The
gate sees all of them.

### Platform and budget

- darwin only (decision 2). A branch that reads `process.platform` and cannot be chosen is a coverage gap, as in the
  base spec.
- The whole of tier A stays under the base spec's 60 s target. The plan's first task measures one iTerm2 scenario.

## Tier B

The base spec's driver (`cli/e2e/harness/appEvalDriver.ts`), with one steps module, `cli/e2e/harness/appEvalIterm.ts`.

- **iTerm2.** Two harness additions in `outsideAgent.ts`:
  - an `iterm` fake app, a bundle with iTerm2's bundle id;
  - its server: today's `iterm-server` stand-in (#4544, at `$HOME/Library/Application Support/iTerm2/iTermServer-<version>`
    in the daemon's throwaway home) runs only under launchd, one per tab; it gains a form whose parent is the fake app.
  - `iterm.relaunch` ends the fake app, and its server passes to launchd.
  - Splits are tabs on ptys of their own.
- **The watch.** The real `harness hardware watch --json`. Tab reports are written into it as
  `dialTerminalFollow.e2e.ts` and `dialHerdrTerminal.e2e.ts` do, and its `select` lines are read from its output.
- **tmux.** The daemon's own private tmux server (`ownTmux.ts`, `isolatedTmux.ts`: its own socket and `TMUX_TMPDIR`).
  Detach and attach use its `tabClient`. A Codex in tmux (IH5) is an addition: `InOwnTmux` runs Claude Code only.
- **herdr.** `PrivateHerdr` (`e2e/harness/herdrServer.ts`, `ownHerdrsOnly`), restarted with its `stop` and `start`, with
  herdr's own Claude Code report for the session where a scenario wants it.
- **Commands the devices ran.** Recording wrappers for `tmux` and `herdr` on the daemon's PATH, as `herdrServer.ts`
  places its own, or the check grades by state (the active pane, herdr's focused pane).
- **devices.restart.** Kill the devices process (`servicePids('devices')`, `desk.ts`) and wait for its new pid.
- **Agents.** The harness's fake Claude Code with the mod's inbox poll (checked to poll inside tmux, for I19), and
  `codexOutside.ts` for IH5.
- **Isolation.**
  - Never the default tmux server, the person's herdr, iTerm2, daemon or dial.
  - No `osascript`, and no reading of another process's environment or argv.
  - A harness step that would read every process's command line (`hcCore.ts`'s `ps -axo command=`) is not used.
- **Files.** `cli/e2e/dialAppEvalIterm.e2e.ts`; its held-out scenarios join `cli/e2e/dialAppEvalHeldOut.e2e.ts`, skipped
  off macOS. Under about 6 minutes locally, with a hint in `cli/ci-e2e-durations.json`.
- **PR CI.** None runs this file (decision 3): it skips off macOS. Editing `outsideAgent.ts` or `herdrServer.ts` already
  selects `dial-hosts` and `linux-e2e` (`scripts/ci-plan.py`), which must stay green with the additions. Whether
  `ci-plan.py` lists the new file is for the plan; it must not be selected where it only skips.

## Coordination with the Orca eval

The Orca eval merged first (#4551, `135c5e99fa`); this branch rebased onto it before any code (PM, 2026-11-22). Both
edit:
- `types.ts` (`App`, `FRONT_NAMES`, `LinkedApp`, `SessionDef`), `tierA/world.ts` (`APPS`, the answered commands, the tmux
  model), `dialAppEval.spec.ts`'s mocks, `tierA/driver.ts`, `steps/window.ts`, `checks.ts`'s `open`, `heldOut.ts`,
  `report.ts` and `baseline.json`;
- `appEvalDriver.ts`, `dialAppEvalHeldOut.e2e.ts`, `ci-e2e-durations.json`, `scripts/ci-plan.py` and its test.

On `main`, Orca's tmux model is inline in `tierA/steps/sessions.ts` (`orcaPane`), its scenarios are in
`orcaScenarios.ts`, and its run log is the fake Orca's (`fakeOrca.ts`). The plan names each of these as merged; its
section "Reconciled with Orca's merge" lists where the merged code differed from Orca's plan.

## Grader, report, baseline

- **Grader.** Unchanged except its app list, which gains `iterm`.
- **Report.** The tables gain a row, with the coverage gaps beside the score.
- **Baseline.**
  - It gains iTerm2's checks and score.
  - The other apps' entries must equal `main`'s for every tier A check and every tier B pass/fail check. Their tier B
    latency and cost entries are written as measured, and the pull request shows the delta (as the editors spec).
  - iTerm2's tier B entries are macOS, from the tester's run.
- **CI rules**, as in the base spec:
  - tier A matches its baseline exactly;
  - tier B fails on a wrong-session send, or on a pass/fail check its baseline passes;
  - a score below 95 never fails CI.
- **A wrong send at baseline.** If the baseline run shows a wrong-session send, the pull request stops and asks the PM
  before merging.

## Privacy and safety

- Sessions are made up: titles start with "Eval ", folders with `/work/eval-`.
- No result holds a path, pid, tty, pane id or session name. The base spec's test that no result carries an absolute
  path covers the new scenarios, and the evidence names ttys and panes by the scenario's own labels.
- No real iTerm2, `osascript`, tmux server, herdr, `open` or `xdg-open` of the person's runs.

## Testing of the eval itself

- Each new step kind and check kind gets a spec in which a scenario that must fail does fail, with its evidence: red,
  then green.
- The grader's spec covers the new app.
- The probes prove each new scenario can fail.
- The baseline run on this branch is the PR's evidence: the score table, the held-out score, the wrong-session count and
  the ranked groups.

## Local gates

- The CLI typecheck and the touched specs.
- `scripts/tests/test_ci_plan.py`, if `scripts/ci-plan.py` changes.
- `python3 scripts/local-checks.py --run`.
- Tier B on macOS, run by the tester.

## After merge

Run both tiers on `main` and report iTerm2's **baseline** to the PM:
- the score per dimension;
- the held-out score;
- the wrong-session count;
- the coverage gaps;
- the failing groups ranked by points lost, each with a one-line cause.

The PM opens the hill-climb items.

## Out of scope

- Fixing any failing scenario, or building the follows decision 1 names.
- Tier C, the real iTerm2.
- Linux and Windows for iTerm2 (decision 2); Terminal, Ghostty and WezTerm as eval apps.
- Zellij.
- iTerm2's own AppleScript (Harness Device's handlers): the select line is graded at the stream, not in iTerm2.
