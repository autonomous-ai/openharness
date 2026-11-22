# Dial eval for VS Code and Cursor

Branch: `feat/dial-eval-vscode-cursor`. Component: `cli/`, test code and the e2e harness only, plus `scripts/ci-plan.py`
and its test, which decide when tier B runs on a pull request.

Platforms:
- tier A: macOS, Linux and Windows, each OS branch the devices code has, chosen by an injected platform;
- tier B: macOS and Linux. Windows tier B is a gap, listed beside the score.

Nothing a person sees changes, and no product code changes: every stand-in is a `vi.mock` or an existing
`DevicesDeps` seam. If a task finds it needs a new seam, it stops and asks the PM.

Source: Diego (2026-11-22), "làm tiếp eval hill-climb cho Cursor và VS Code", under the rules of the Claude/ChatGPT
eval: `docs/plans/2026-11-21-dial-app-eval-design.md` (the **base spec**, merged in #4537). This spec adds two apps to
that eval. Wherever it says nothing, the base spec holds.

## Why

The dial's work in VS Code and Cursor is checked today by pass/fail tests of single paths: `dialVscode.e2e.ts`,
`dialVscodeFollow.e2e.ts`, and the hosts' specs. We want the same thing the Claude and ChatGPT apps now have:
- one 0–100 number per app, from a fixed scenario set and an automatic grader;
- a committed baseline that ratchets;
- the failing groups, ranked by points lost.

The PM turns those groups into hill-climb items.

## Decisions

Kept from the base spec:
- dimensions D1–D8, with weights D5 25, D3 15, D2 15, D1 15, D4 10, D7 10, D6 5, D8 5;
- the latency thresholds;
- the **hard gate**: a voice prompt delivered to a session other than the scenario's target fails the whole run;
- about 20% of scenarios held out;
- a target of ≥ 95/100 per app;
- tiers A and B only;
- the network guard on.

No real VS Code or Cursor ever runs. Nothing reads or writes the person's `~/.vscode`, `~/.cursor`, their extensions,
`~/.claude` or `~/.codex`. Every home, store, editor CLI and `open` is a throwaway inside the run's own root.

PM, 2026-11-22:

1. **Graded on what the person expects, even where no path exists yet.** These have no code today:
   - voice to Cursor's own agent;
   - voice to a Codex in an editor terminal whose `CODEX_HOME` is not the daemon's;
   - voice to cursor-agent in a terminal;
   - Cursor's agent's recap;
   - follow when the person focuses another terminal. The extension sends `active` and `focused` on `vscode-state`,
     and `vscodeTerminals.ts` checks both but uses neither.

   Each is graded as "must work" and fails at baseline. Those failures are the hill-climb items.
2. **No scenario for focusing a panel or Cursor's agent without a prompt.** Nothing reaches Harness when the person
   clicks into the Claude Code panel or Cursor's agent view. The extension reports terminals only, and neither the panel
   nor Cursor's agent sends anything until a prompt. A scenario would grade a signal that does not exist, so follow for
   the panel and for Cursor's agent is graded on a typed prompt (`followPrompt`, `services/devices.ts`).
3. **Two new check kinds**, for the `code .` field case and the other stroke checks:
   - `scroll` (D3): a stroke reaches the right terminal;
   - `logged` (D7): a stroke the devices did not act on leaves its own line, `[device] scroll · skipped · <reason>`.
     Today such a stroke logs nothing (`services/devices.ts` returns on `nowhere`), so this line is the contract a fix
     adds.

## What the dial does in these apps (from the code)

### Ring

- **Sources.** Rows come from the observed source: hooks, plus the open scan. Each agent is placed by the adapter order
  in `services/devices.ts`: `vscode`, `cursor`, then `cursor-folder`, the last resort for every agent whose app is
  Cursor.
- **The app.** `detectApp` (`cable/hosts/hostDetect.ts`) decides it by the bundle id first, then by `TERM_PROGRAM`.
  Cursor also says `TERM_PROGRAM=vscode`, so its bundle id `com.todesktop.230313mzl4w4u92` decides.
  - With no bundle id (Linux), the app is learned by walking the caller's parents (`observed.ts`, `scannedApp.ts`
    `learnApps`). The names `code` and `cursor` map in `frontApp.ts`.
  - On Windows the hook (`cli/hook/notify.mjs`) works out the editor itself and sends its bundle id.
- **Row kinds** (`cable/hosts/vscode.ts`, `cursorFolder.ts`):
  - a **terminal** row (`term:<pid>`): Claude Code, Codex, or cursor-agent (engine `cursor` with `TERM_PROGRAM` set),
    under a shell the extension reports. The adapter matches by the hook's caller pid.
  - a **panel** row: Claude Code with `CLAUDE_CODE_ENTRYPOINT=claude-vscode` and the editor's bundle id, or, on Linux,
    the walked app.
  - **Cursor's agent** (engine `cursor`, no `TERM_PROGRAM`): a `cursor-folder` row.
- **Order and names.** The ring holds 16 (`select.ts`): needs-you first, then latest activity. A row's name is the
  pane's, then the hook or record title, then the folder's name.
- **Leaving.** An ended entry stays listed until the observed tick removes it, 30 s apart, after its 10 s end delay
  (`observed.ts`).

### Follow

The dial follows only a person's prompt, typed while the agent's app is the settled front app (`followPrompt`). Terminal
focus is not followed (decision 1).

### Open

- **Terminal row.**
  - A tap writes `{"show":<shell>,"raise":true}` on the window's `vscode` stream, then brings the app forward:
    `open -b <bundle>` on macOS, `windowsRaise.app` on Windows, `raise` on Linux.
  - A rest while the editor is in front writes `{"show":<shell>}`.
  - With no stream for its shell, the tap falls to the next pane or to the app's bundle (`open.ts`). The
    `· fallback` line is logged only when a pane's focus fails.
- **Panel row.** A tap opens `vscode://` or `cursor://anthropic.claude-code/open?session=<id>` (`appLink.ts`).
- **Folder row.** A tap opens Cursor's window for the agent's folder: `open -b <cursor> <folder>` on macOS, Cursor's CLI
  on Linux, `windowsRaise.cursorFolder` on Windows. The folder must exist (`cursorFolder.ts` `isFolder`).

### State, voice and recap

- **State.** From hooks, for every row kind (`observed.ts`).
- **Voice.** Two paths reach these agents:
  - the Claude Code mod's inbox, for Claude Code anywhere, panel included;
  - the Codex queue, only for a session whose transcript is under the daemon's own `CODEX_HOME`.

  No editor adapter types text, and the extension writes only PageUp and PageDown.
- **Recap.** The last answer from the transcript, for `claude` and `codex` only.

### Strokes

`{"scroll":<lines>,"pid":<shell>}` goes on the window's stream while the editor is in front. The extension runs it only
while that terminal is the active one (`loop.ts`).

## Scenarios

They use the base spec's catalog, types, runner, grader, report and baseline (`cli/src/testing/dialAppEval/`). `App`
gains `vscode` and `cursor`, and their pages are the wire's app ids `vscode` and `cursor`. Every scenario has the base
spec's ghost probe, so a check that names a session never written must fail with its evidence. Every scenario runs on
every platform and in both tiers unless its entry says otherwise, and every tier B scenario carries the three D8 checks.

A session at **rest** in these apps is a live, idle one: its process runs and no turn is open. The editors have no
store, so a session with no process is never listed.

### Main set: VS Code

- **V1.** One window with three terminals: Claude Code, Codex, and a Claude Code in a split of the Codex terminal's
  group. Plus one Claude Code panel session. → The VS Code page has exactly those four rows, in the ring's order, by
  their names. No row is on another page. (D1)
- **V2.** 20 agents in terminals across two windows → the ring keeps 16. Then a terminal closes (step
  `editor.closeTerminal`): its shell drops out of the window's state, its agent's process ends and its end hook fires.
  → It leaves the ring, graded on the `ringChange` threshold. Tier A only. (D1, D7)
- **V3.** VS Code is in front and the person focuses another terminal: its `active` changes, with `focused` true. → The
  dial follows within 1 s. (D2)
- **V4.** A prompt typed in the panel session while VS Code is in front → the dial follows within 1 s. (D2)
- **V5.** Two windows on two workspaces. A tap on an agent in the second window → only that window's stream gets `show`
  with `raise` for its shell, and VS Code is brought forward by the platform's command. (D3, D7)
- **V6.** A tap on a panel session at rest → `vscode://anthropic.claude-code/open?session=<id>` runs. (D3)
- **V7.** A turn in a terminal Claude Code → working, then needs-you on a permission, then done. The recap is its last
  answer. (D4, D6)
- **V8.** Voice on a Claude Code in a terminal, at rest → the exact text reaches it, once. (D5)
- **V9.** Voice on a Codex in a terminal whose `CODEX_HOME` is a folder of its own, not the daemon's → the exact text
  reaches it, once. (D5)
- **V10.** The window reloads: its stream ends, then a new window id opens and reports the same shells. → The ring is
  unchanged, with no duplicate row, and a later tap shows the terminal on the new stream. (D7, D3)
- **V11.** The field case (2026-11-20; macOS only). VS Code was started with `code .` from Terminal.app, so it and its
  terminals inherit `__CFBundleIdentifier=com.apple.Terminal`, with `TERM_PROGRAM=vscode`. The process chain runs
  Terminal → shell → VS Code → shell → Claude Code. Expected:
  - its row is on the VS Code page, not Terminal's (D1);
  - a tap shows its terminal (D3);
  - a stroke while it is active scrolls it (`scroll`, D3);
  - a stroke with no terminal to take it leaves its `skipped` line (`logged`, D7).
- **V12.** Claude Code under tmux in a VS Code terminal → its row is on the VS Code page, and a tap shows the terminal
  that tmux's client runs in. Tier B only, since tier A has no tmux. (D7, D1, D3)
- **V13.** The extension is not installed, or is disabled, so no window stream exists. → The terminal agents are still
  on the ring, a tap brings VS Code forward by the platform's app command, and a stroke leaves its `skipped` line.
  (D7, D3)
- **V14.** VS Code quits (its agents' processes end and its streams close) and relaunches → the ring comes back right,
  with no duplicate rows. (D7, D1)
- **V15.** The dial is unplugged and plugged back in → the ring and the focused row come back, and a tap then shows the
  terminal. (D7, D3)

### Main set: Cursor

- **U1.** Cursor with four agents: a terminal Claude Code, cursor-agent in a terminal, Cursor's own agent, and a Claude
  Code panel session. → The Cursor page has exactly those four rows, by their names. None is on VS Code's page, though
  the terminal ones say `TERM_PROGRAM=vscode`. (D1)
- **U2.** VS Code and Cursor both run, each with a terminal Claude Code → each row is on its own app's page, read from the
  `apps` counts as the base spec's `apart` does. (D1)
- **U3.** Cursor is in front and the person focuses another terminal → the dial follows within 1 s. (D2)
- **U4.** A prompt typed in Cursor's own agent while Cursor is in front → the dial follows within 1 s. (D2)
- **U5.** A tap on a Cursor terminal agent → `show` with `raise` on its window's stream, and Cursor is brought forward
  by the platform's app command. (D3)
- **U6.** A tap on Cursor's own agent → Cursor's window for its folder opens, by the platform's command. (D3)
- **U7.** A tap on a panel session at rest in Cursor → `cursor://anthropic.claude-code/open?session=<id>` runs. (D3)
- **U8.** A turn in Cursor's own agent → working, then done. The recap is its last answer, from its transcript. (D4, D6)
- **U9.** Voice on a Claude Code in a Cursor terminal → the exact text reaches it, once. (D5)
- **U10.** Voice on Cursor's own agent → the exact text reaches it, once. (D5)
- **U11.** Voice on cursor-agent in a Cursor terminal → the exact text reaches it, once. (D5)
- **U12.** A terminal Claude Code runs and its Cursor window closes, ending its stream → a tap on it opens Cursor's
  window for its folder. (D7, D3)
- **U13.** Cursor quits and relaunches → the ring comes back right, with no duplicate rows. (D7, D1)
- **U14.** Cursor's own agent and a terminal Claude Code run in the same folder → two rows, never one. (D1)

### Held-out set (7 of 36, 19%; VS Code 4 of 19, Cursor 3 of 17)

They live in `heldOut.ts` beside the base spec's held-out scenarios. They are scored and reported apart, and whoever
fixes a group never reads them.

- **VH1.** Voice on the focused terminal agent while another terminal's agent is working → only the focused one gets
  it. (D5, gate)
- **VH2.** Two windows report the same shell, as when a terminal moves between windows → a tap goes to the window that
  reported it last. (D3, D7)
- **VH3.** The person focuses the second pane of a split terminal → the dial follows to its agent. (D2)
- **VH4.** Voice on a panel session at rest → the exact text reaches it, once. (D5)
- **UH1.** `cursor .` from Terminal.app, the field case's cause in the other app (macOS only) → the row is on the Cursor
  page, and a tap shows its terminal. (D1, D3)
- **UH2.** Cursor's agent in a multi-root workspace → a tap opens its first folder. (D3)
- **UH3.** Voice 200 ms after a prompt typed in another Cursor terminal moved the dial there → the text reaches the newly
  focused agent. (D5, gate)

A bug reported from now on in either editor becomes a scenario in this catalog.

### Expected to fail at baseline (from the code)

These predictions are not graded; the baseline run is the truth.

- **Decision 1:** V3, U3, VH3 (terminal focus); V9, U10, U11 (voice); U8's recap.
- **V2:** the leave takes the 30 s tick plus the 10 s end delay.
- **V11 and UH1:** the inherited Terminal bundle files the row under Terminal.
- **V11's and V13's `logged` parts:** no such line exists yet.
- **Likely V12:** the adapter matches by the caller's pid, and the tmux server's chain never reaches the window's
  shell.

### Catalog additions

- **Names** (PM, 2026-11-22). A Claude Code row's name is its session's title, which its hook carries. The hooks of Codex,
  cursor-agent and Cursor's agent carry none, so those rows are graded on their folder's name (`eval-<key>`).

- **SessionDef.**
  - `place`: `terminal`, `panel` or `agent`, defaulting to `terminal` for the editors and unused for the base apps.
  - `engine`: `claude`, `codex` or `cursor`. It defaults to `claude`, except a Cursor `agent`, which is `cursor`.
  - `window`: the editor window that holds its terminal.
  - `codexHome: 'own'`: a Codex whose `CODEX_HOME` is a folder of its own.
  - `folders`: Cursor's agent's workspace folders, under `/work/eval-`.
  - `agentIdOf` follows the session's engine.
- **World.** `launchedFrom: 'terminal-app'` (the `code .` and `cursor .` cases), and `extension: false` (V13).
- **Steps.**
  - `editor.window`: a window opens its stream and reports its shells;
  - `editor.focus`: a terminal becomes the active one, and the window is focused;
  - `editor.closeTerminal`, `editor.reload` and `editor.close`;
  - `stroke`: the person strokes the dial on the face's row;
  - `quit` and `relaunch` with an editor app: its agents end and its streams close, then both come back.

  A typed prompt is the base spec's `turn-start` hook, from the person.
- **Checks.**
  - `open` grades an editor row by its kind:
    - a terminal row: a `show` with `raise` on the stream of the window that holds its shell, and the app brought
      forward;
    - a panel row: its link;
    - a folder row: its folder command;
    - with no stream (V13): the app brought forward.
  - `scroll`: after the label, the window that holds the session's shell ran `scroll` lines for that shell while it was
    active.
  - `logged`: after the label, the devices logged `[device] scroll · skipped · ` followed by a reason. It is pass/fail.
    Its evidence is the matched lines, with no path or pid.
- **Seen** gains two fields:
  - `streams: {at, window, line}[]`: each message on an editor window's stream, both ways;
  - `logs: {at, line}[]`: each devices log line, which only `logged` reads.

## Tier A

The base spec's tier A holds, with these additions.

### The fake extension

- For each `editor.window`, the driver opens the devices' own `vscode` stream handler, taken from `world.listener` as
  the real listener hands it, with a fake `ListenerStream`. Its contract: `write` records the line and returns true;
  `onWritable` is kept; `ended` is an `AbortSignal` the driver aborts with a reason when the window goes.
- It sends `vscode-state` as the extension's loop does (`plugins/harness-device-vscode/src/loop.ts`): the window's
  shells, the active one, and whether the window is focused.
- As `loop.ts` does, it runs a `scroll` only for the active shell and drops the rest.
- Calling the handlers directly skips the listener's own limits (8 windows, rates, `replaced`). Those have their own
  specs and are not graded here.
- `extension: false` opens no stream.

### The machine

- Each editor is an app process: its bundle path, with its bundle id in `bundleIds`.
- Each terminal is a shell process whose parent is the editor.
- Each agent is a process under its shell. The panel's agent and Cursor's own agent run under the editor.
- With `launchedFrom: 'terminal-app'`, the editor's parent is Terminal.app's process.
- `processParents` answers from these parents. The `learnApps` mock answers what the real walk would: the nearest
  editor in the session's chain.
- The session steps (`tierA/steps/sessions.ts`) choose the hook's engine, its hints and the mod's loop by the session's
  engine and place, not by its app.

### Hints, per platform

They are what the hook would send:
- **macOS:** `TERM_PROGRAM=vscode` (terminal rows only), and the editor's bundle id, or Terminal's under `launchedFrom`.
- **Windows:** `TERM_PROGRAM=vscode` (terminal rows only) and the editor's bundle id, as `notify.mjs` works it out. That lookup has its own spec and is not graded.
- **Linux:** `TERM_PROGRAM` only, with the app walked.
- **The panel** adds `CLAUDE_CODE_ENTRYPOINT=claude-vscode`.

### Transcripts

- **Claude Code, and a Codex under the daemon's home:** in Harness's own engine homes, as today.
- **A `codexHome: 'own'` Codex:** in its own folder of the world's temp root. That folder is neither the daemon's
  `CODEX_HOME` nor the ChatGPT app fixture's home.
- **Cursor's agent:** at `env.CURSOR_HOME/projects/<slug>/agent-transcripts/<id>.jsonl`, the suite's throwaway Cursor
  home (`vitest.setup.ts`). Its hooks carry that path, and its lines follow `engines/cursor/normalizer.ts`.

### Cursor's folder rows

- `cursorFolder.js` is mocked so that `isFolder` is true for the session's `/work/eval-` folders, and nothing else
  changes.
- Tier A's `cursorExtension` deps find Cursor's CLI at a made-up path and see the extension installed, so the extension
  setup runs nothing. Any run of the setup is a gap.
- The CLI's program joins the commands the world answers.

### The fake editors react to links

As the base spec's fake apps do, for a panel link they record the link and show the session. A session that is not
running is never resumed, since it was never listed.

### Deliveries

- Every path the base spec records counts.
- So does each message on an editor stream that carries words, as `typed` to the session in the shell it names. None do
  today.
- A fix that adds a delivery path records it, with its target, in both tiers in that fix's pull request, so the gate
  sees it.

### Logs and limits

- **Logs.** `deps.log` is recorded with its virtual time, for `logged`.
- **Not in tier A:**
  - V12: tier A has no tmux.
  - Installing the extension: tier A's editor setup is not graded.
  - A `process.platform` read that decides a check is a coverage gap, as in the base spec.
- **Budget.** The whole of tier A stays under the base spec's 60 s target. The plan's first task measures one editor
  scenario on one platform. If the budget does not hold, the editors' win32 and linux runs are kept only for scenarios
  whose path has an OS branch.

## Tier B

Tier B uses the same driver and rules as the base spec (`cli/e2e/harness/appEvalDriver.ts`), with one editor steps
module for both editors: `cli/e2e/harness/appEvalEditor.ts`.

### The editors

- The fake app bundles of `outsideAgent.ts` carry each editor's bundle id on macOS. On Linux they are processes named
  `code` and `cursor`.
- Each window is one `vscodeWindow.ts` process: the real extension loop over a fake window. It reports its shells on the
  real devices' socket and prints each show, raise and scroll. A printed scroll's shell is the window's active one, as
  the loop runs it.
- Agents run under real shells under the fake editor, so the parent chain `ps` reads is the machine's own, as in
  `dialVscode.e2e.ts`.

### Agents

- **Claude Code:** with the harness's mod inbox poll. Panel sessions add the panel's entrypoint.
- **Codex:** `codexOutside.ts` gains a home option and a start under a shell of the fake editor. A `codexHome: 'own'`
  Codex gets a home in the root that is not the daemon's `CODEX_HOME`.
- **cursor-agent and Cursor's own agent:** a new fake, `cli/e2e/harness/cursorOutside.ts`, sends Cursor-engine hooks
  through `notify.mjs`, with `TERM_PROGRAM` for cursor-agent and without it for Cursor's agent. Each writes its
  transcript where tier A does.

### Isolation

- The daemon's `HARNESS_VSCODE_BIN` and `HARNESS_CURSOR_BIN` are its own recording fakes inside its root
  (`harness/daemon.ts` sets them already).
- Before the daemon starts, they are checked to be inside its root, beside the base spec's checks of its open and its
  homes.
- The extension setup sees only the throwaway home.

### Files

- `cli/e2e/dialAppEvalVscode.e2e.ts` and `cli/e2e/dialAppEvalCursor.e2e.ts`.
- The editors' held-out tier B scenarios join `cli/e2e/dialAppEvalHeldOut.e2e.ts`.
- Each file stays under about 6 minutes on a CI runner, with hints in `cli/ci-e2e-durations.json`.

### Platforms

- macOS, run locally by the tester.
- Linux, on PR CI's `linux-e2e`.
- Windows tier B is a gap, as in the base spec.

### PR CI

In `scripts/ci-plan.py`:
- `LINUX_E2E_APP_EVAL_FILES` gains the two files.
- `LINUX_E2E_APP_EVAL_PATHS` gains what they cover outside `cable/hosts/`:
  - `cli/src/services/devices.ts`;
  - `cli/hook/notify.mjs`;
  - `plugins/harness-device-vscode/src/`;
  - `cli/src/devices/vscodeExtension.ts`;
  - `cli/src/cable/vscodeExtensionSetup.ts`;
  - `cli/src/engines/cursor/`;
  - `cli/src/core/engines/cursorDiscovery.ts`;
  - `cli/e2e/harness/vscodeWindow.ts`, `outsideAgent.ts`, `codexOutside.ts` and `cursorOutside.ts`.

`scripts/tests/test_ci_plan.py` and the row in `docs/validation-and-release.md` follow.

## Grader, report, baseline

- **Grader.** Unchanged except its app list, which now has four apps.
- **Report.** The tables gain two rows, and each app's coverage gaps are printed beside its score.
- **Baseline.**
  - It gains the new apps' checks and scores.
  - The Claude and ChatGPT entries are measured again (PM, 2026-11-22). Every tier A check and every tier B pass/fail
    check of theirs must equal `main`'s. Their tier B latency and cost entries, and the app scores those move, are
    written as measured, and the pull request shows their delta.
  - As in the base spec, tier B's baseline holds macOS, and Linux is gate-only.
- **CI rules**, as in the base spec:
  - tier A matches its baseline exactly;
  - tier B fails on a wrong-session send, or on a pass/fail check its baseline passes;
  - a score below 95 never fails CI.
- **A wrong send at baseline.** If the baseline run shows a wrong-session send, the pull request stops and asks the PM
  before merging.

## Privacy and safety

- Sessions are made up: titles start with "Eval ", folders with `/work/eval-`.
- No result holds a path, pid or folder name. The base spec's test that no result carries an absolute path covers the
  new scenarios and the `logged` evidence.
- No real VS Code, Cursor, editor CLI, extension store, `open` or `xdg-open` runs.

## Testing of the eval itself

- Each new step kind and check kind gets a spec in which a scenario that must fail does fail, with its evidence: red,
  then green.
- The grader's spec covers four apps.
- The probes prove each new scenario can fail.
- The baseline run on this branch is the PR's evidence:
  - the score table for the four apps;
  - the held-out scores;
  - the wrong-session count;
  - the ranked groups.

## Local gates

- The CLI typecheck and the touched specs.
- `scripts/tests/test_ci_plan.py`.
- Tier B on macOS, run by the tester.

## After merge

Run both tiers on `main` and report to the PM:
- the score per app × dimension;
- the held-out score;
- the wrong-session count;
- the coverage gaps;
- the failing groups ranked by points lost, each with a one-line cause.

## Out of scope

- Fixing any failing scenario, or building any path decision 1 names.
- Tier C, the real editors.
- Windows tier B.
- Focusing a panel or Cursor's agent without a prompt (decision 2).
- Installing and updating the extension: `vscodeExtensionSetup.ts` has its own specs.
