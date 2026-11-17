# The dial with tmux and VS Code, app closed (wave 1 checks): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. This plan was updated on 2026-11-15 for the
> port onto #4341's host adapters. Tasks 1, 2, 4, 5 and 8 of the first plan are done and carried over as commits;
> Tasks 3, 6 and 7 are replaced by Tasks 9 to 16 below. Task 9 is git surgery and runs alone. Tasks 10 to 14 and 16
> are test-first: a red commit (the tests alone), then the code commit. Task 15 is one carried commit. Steps use
> checkbox (`- [ ]`) syntax for tracking. At most 2 implementers run at once.

**Goal:** With Harness Desktop closed, an agent in the person's own tmux is listed on the dial and a tap shows its
pane (F1), a tap on a Harness agent opens Desktop on it (F2), and a tap on a Claude Code session in the VS Code
extension's tab shows that tab (F3).

**Architecture:** The engines' hook (`cli/hook/notify.mjs`) and the devices process only (`cli/src/cable/`,
`cli/src/services/devices.ts`). The hook sends a session in a tmux pane the person opened down the path a paneless
session takes (`/api/hook/observed`). In the devices, each app an outside agent runs in is one adapter file
(`cli/src/cable/hosts/adapter.ts`, #4341): this work adds `hosts/tmux.ts` and `hosts/vscode.ts`, and puts the
multiplexer rule into the Orca and tabs adapters. `observed.ts` and `open.ts` hold no rule about any app; `open.ts`
gains only Harness Desktop's launch and what a tap does with a pane its adapter refuses. Everything is in memory.
The firmware changes by one host-table line, Desktop not at all, the core by one comment line.

**Tech Stack:** TypeScript (Node 22 here, CI pins 24), the hook in plain Node built-ins (`.mjs`), Vitest, tmux. No new
dependency.

**Spec:** [docs/specs/2026-11-15-device-wave1-checks.md](../specs/2026-11-15-device-wave1-checks.md): its Decided
section's first bullet is the port. Read it with #4341's spec,
[docs/specs/2026-11-15-device-host-adapter.md](../specs/2026-11-15-device-host-adapter.md), the root `AGENTS.md`,
`cli/AGENTS.md`, `cli/src/services/AGENTS.md` and `cli/src/core/AGENTS.md` (rule 7). The spec is the authority.

## Where the branch is

- `fix/device-wave1-checks`, head `a1271e88fb`, 34 commits on `1c37a340a8` (#4333 and #4337), the commit just
  before #4341. Each task's red commit comes before its code commit.
- #4341 is `5fa7b95762` on `main`. It moved each app's open, focus, words and rest out of `open.ts` and
  `observed.ts` into adapter files. A trial merge conflicts in `observed.ts`, `open.ts`, `open.spec.ts`,
  `devices.ts` and `devices.spec.ts`.
- `origin/fix/device-wave1-checks` holds an older history: the next push of this branch is a force push
  (`--force-with-lease`), the main session's when diegodev pushes. No task pushes.

## The port: every commit of the branch

Checked on a scratch clone at `5fa7b95762` (2026-11-15): the 18 kept commits cherry-pick in this order with no
conflict, `git range-diff` reads each as unchanged, `npm run typecheck` is clean, and
`src/hookNotify.spec.ts`, `src/cable`, `src/services/devices.spec.ts` and `src/services/devicesListener.spec.ts`
pass (2010 tests). `63467b24a8` cherry-picks on top with no conflict too.

| Commit(s), oldest first | What | In the port |
| --- | --- | --- |
| `7f8b6fc35d`, `5ffad15299` | the spec, the first plan | **kept** |
| `e5ae461578`, `8b53000b20` | the hook: a session in the person's own tmux pane (old Task 1) | **kept** |
| `e10826094c`, `70336f946c` | F2's cable side: the waiting open (old Task 5) | **kept** |
| `43d649cf6d`, `e258f87e91` | the tmux tap in `open.ts` (old Task 3) | **dropped**, replaced by Tasks 10, 12, 13 (its Orca handle rule by Task 11) |
| `c0ab186639` | `services/AGENTS.md`'s tmux rule (old Task 4) | **kept**; Task 12 moves its file pointer |
| `88ec509c6c`, `6026ae7183` | host and app `tmux` (old Task 2) | **kept** |
| `746b4ba2b6`, `3166f17cad` | F2's devices side, `HARNESS_BUNDLE` (old Task 6) | **dropped**, replaced by Task 14 |
| `910c17679e`, `f284be53c7` | F3 in `open.ts` (old Task 7) | **dropped**, replaced by Task 16 |
| `63467b24a8` | the end-to-end cases (old Task 8) | **dropped in Task 9, carried back unchanged by Task 15**, after the code it runs |
| `82114fe8ac`, `383fb6d9a1` | tmux inside a tab app has no tab | **dropped**, replaced by Task 11 |
| `1f168019f7`, `45730afcdf` | F2: a tap a window took is not told Desktop failed | **kept** |
| `e6245ff7c5` | one walk up a process's parents | **dropped**, replaced by Task 12 (`parentChain`) |
| `6c5612754e`, `8e14588ddc` | Zellij or herdr inside a tab app has no tab | **dropped**, replaced by Task 11 |
| `ea65c9c4e7` | spec: the tap's order | **kept** |
| `6059d5ed95`, `88bff51abb` | a tap reads tmux's pane before WezTerm's and Orca's | **dropped**, replaced by Task 13 (the adapters' order) |
| `c66f6ad3f8` | spec: Codex's voice in tmux | **kept** |
| `149270fd6c`, `a510955e27` | no Orca handle in any multiplexer | **dropped**, replaced by Task 11 |
| `662c6f2464`, `0fb12e70f5` | the firmware's host table line, and the spec for it | **kept** |
| `363898d9bd`, `eab6b4526c` | the hook on Linux: `observedCallerPid` | **kept** |
| `a1271e88fb` | spec: the port | **kept** |

Kept: 18. Dropped: 16, each replaced. The old commits stay readable by SHA through the local branch
`wave1-checks-before-port` (Task 9), which later tasks read their tests from.

## Decided

By the PM, 2026-11-15, all in the spec:

- F1, F2 and F3 in one pull request, each test first.
- Q1 = A: the devices process may run only `tmux switch-client` (or a select) to a person's own pane that a hook named
  and whose process it checked. It never types, creates or closes there, and never writes to a pane or session
  Harness made. The rule is in `cli/src/services/AGENTS.md` (`c0ab186639`).
- Q2 = A: F3 lands here. The pull request keeps `hold` until the spec's check 3 passes on Diego's Mac; if it fails,
  F3's two commits come out. So F3 is one task, in commits of its own, and no task depends on it (Task 16).
- The tap names the tmux client it moves (`switch-client -c`): the one used last among those not on a session Harness
  made. With no such client nothing is switched.
- No Orca handle for an agent in a multiplexer; `TERM_PROGRAM=tmux` with an unlisted bundle id is on the `tmux` page;
  one comment line in the core; the pull request's body gives the measured cost of the hook's new tmux calls.

**The port (PM, 2026-11-15, after #4341 merged):**

- This branch's work moves onto the per-app adapter structure of #4341 (`5fa7b95762`).
- **F1's tap is a tmux adapter, `hosts/tmux.ts`.** It runs the pane's pid check (`parentChain`), chooses the person's
  client (`-c`, never one on a Harness session), runs `switch-client`, answers "refused" with the `not its pane` log
  line, and keeps F1's tap order: herdr, tmux, WezTerm, Orca.
- **F3 is a VS Code adapter, `hosts/vscode.ts`,** in two commits of its own (red, then code) that revert alone and
  that nothing else depends on.
- **F2's Desktop launch (`open -b ai.autonomous.harness`) stays in `open.ts`.**
- **The multiplexer rule covers herdr, Rex, Zellij and tmux:** no Orca handle, so no words or rest through Orca; no
  tab select unless the tab app is the agent's nearest host. Two of #4341's tests flip, and their comment says why:
  herdr inherits the Orca terminal handle and tty of the terminal it started in, so words typed through Orca land in
  whichever herdr pane is focused, which may be another agent or a shell.
- **Unchanged, carried over as they are:** the hook (`notify.mjs`: the own-tmux observed path, the hint cap,
  `TMUX_PANE`, Linux `observedCallerPid`); `hostDetect.ts` (host and app `tmux`, `HARNESS_BUNDLE`); the firmware's
  host table line; `services/AGENTS.md`'s tmux rule; F2's cable side (`harness.ts`, `cableHost.ts`); the end-to-end
  cases (`e2e/harness/ownTmux.ts`, `deviceWithoutApp.e2e.ts`).
- The git surgery is run by one `diegodev-implementer` in the branch's main checkout, with no other task running.
- At most 2 implementers run at once.

While planning, from #4341's code (say so if one is wrong):

1. **Task 9 rebuilds onto `5fa7b95762` itself, not onto a moving `origin/main`.** The kept list is checked there and
   nowhere else. A later `main` is integrated apart ("When `main` moves").
2. **The multiplexer rule lives in the two adapters' `paneOf`.** `services/AGENTS.md` (#4341) says "`observed.ts` and
   `open.ts` hold no rule about any app", so the rule cannot stay in `observed.ts`, where the branch has it. The Orca
   adapter gives no pane when the place's host is herdr, Rex, Zellij or tmux. The tabs adapter gives a pane only when
   the place's host is the tab app itself, or no host is known yet (a session the open scan found): the branch's
   own rule, word for word. Tried on `5fa7b95762`: three of #4341's tests change, the two herdr tests the PM named
   and `tabs.spec.ts`'s `paneOf` case, whose helper gives every app the host `claude`. Open question 1 comes from
   this.
3. **`HostAdapter.focus` answers `boolean | 'refused'`.** Refused: the pane is not the agent's, and the adapter said so
   in a line of its own. The opener then brings the app forward and writes no `· fallback` line. On `main` a
   `'refused'` would read as shown (it is truthy), so the opener's change and the interface's are one task (12).
4. **`Place` gains two optional members, and `Pane` stays as it is.** `pid`: the agent's process, its latest event's
   caller. `sessionId`: the engine's own id of the session, in F3's commits only. Both optional, as `tty` is: the
   other adapters' contract tests build a place without them. tmux's pane id holds the pane and the process,
   `%3:100`, as the tabs adapter's holds its app and tty (`ghostty:/dev/ttys023`), and is checked again at the tap.
5. **The order is the devices' list:** herdr, tmux, WezTerm, Orca, the Claude app, VS Code, tabs
   (`services/devices.ts`). Its test is in `devices.spec.ts`; `observed.spec.ts`'s `fakeActions` mirrors it.
6. **The tmux and VS Code tests are in `tmux.spec.ts` and `vscode.spec.ts`,** each with an opener that holds its
   adapter alone, as #4341 gave each adapter its contract test. `open.spec.ts` gains only the refused pane and
   Desktop's launch.
7. **One runner still (`OrcaDeps.run`), answering `{ code, stdout }`,** as the first plan decided. Every fake `run`
   then answers `stdout: ''`: tried on `5fa7b95762`, the typecheck names fakes in seven spec files (`claudeApp`,
   `herdr`, `wezterm`, `observed`, `open`, `orca`, and about fourteen in `devices`). It is a task of its own (10),
   first, so the others stay apart. The same trial: `focus`'s wider answer and `Place.pid` break no type.
8. **`63467b24a8` is carried by cherry-pick after the tmux adapter is wired** (Task 15), so no commit of the branch
   holds an end-to-end case before the code it runs.
9. **`services/AGENTS.md`'s tmux rule keeps every word but its file pointer:** `cable/hosts/open.ts` becomes
   `cable/hosts/tmux.ts` (Task 12).
10. **`tabs.ts` imports `UNKNOWN_APP` from `hostDetect.ts`.** The CLI's watch loads `tabs.ts`; `hostDetect.ts` is
    constants and imports nothing. `src/leanEntry.spec.ts` is in Task 11's run.
11. **F3's commits come last on the files they share** (`devices.ts`, `devices.spec.ts`, `observed.ts`,
    `observed.spec.ts`, `adapter.ts`), so they revert with no conflict. That is why Task 16 names Tasks 11 and 14.

## Open questions

1. **A tap on a Zellij or Rex agent inside an Orca terminal.** In #4341's structure one Orca pane serves words, a
   rest and a tap. With no Orca pane in a multiplexer (decision 2 above), such a tap no longer runs
   `orca terminal switch`: on macOS Orca only comes forward, and on Linux the agent loses `f`. Today's branch still
   runs that switch (its `open.ts` read the handle apart from the words). herdr and tmux are not touched by this:
   they tap their own pane. Keeping the switch needs a new adapter member (a per-pane "can type"), or a rule in
   `observed.ts`. **The plan takes "no Orca handle" whole** (Task 11, its test's last three lines). Is that right?
   **Answered (2026-11-15): yes.** The spec's Decided says so.

## When `main` moves

`main` will move (#4340 is about to merge). No task waits for it, and no task rebases.

- Tasks build on the branch, which sits on `5fa7b95762` after Task 9.
- Integrating a newer `main` is the main session's call, by the repo's rule (`docs/validation-and-release.md`:
  "integrate `main`, review the combined change, rerun only the affected checks"). One `diegodev-implementer` does
  it in the branch's main checkout, with no other task running, by `git merge origin/main`: a merge, so each
  red-then-code pair and F3's two commits stay as they are.
- After an integration, every task not yet started does its **If `main` moved** list first, and stops and reports
  if a named function is gone or does something else. Every task already done has its **Run** commands run again on
  the merged head.
- Where #4340 meets this work: `cableHost.ts` (`setSwarms`, `openAgent`: F2's waiting open, `70336f946c` and
  `45730afcdf`), `cableHost.spec.ts`, `devices.ts` (the cable host's wiring), `devices.spec.ts`, and
  `e2e/dialAppFilter.e2e.ts` (the two cases `6026ae7183` changed). A conflict where F2's waiting open meets #4340's
  `setSwarms` is not resolved by guess: stop and report.

## Global Constraints

- No code under `cli/src/core/` changes: one comment line, on `MAX_HINTS` in `core/observedHook.ts` (`8b53000b20`).
  `src/architecture.coreFiles.txt` gains no line. Nothing under `desktop/` or `device-app/` changes; under `devices/`
  only the firmware's host table line (`662c6f2464`).
- **`observed.ts` and `open.ts` hold no rule about any app** (`services/AGENTS.md`). A rule about tmux, VS Code, Orca
  or a tab app is in that app's adapter file. `open.ts` holds Harness Desktop's launch (PM) and the opener's own
  order.
- Every adapter keeps `adapter.ts`'s four rules: `paneOf` checks each value against its own form and each verb checks
  the pane's id again; a plain object, no `this`; a verb that cannot run answers `false`, `'failed'` or `'refused'`
  and never throws; `paneOf` answers from its own app's values.
- Every value from a hook is checked against its own form before use: pane id `/^%[0-9]{1,9}$/`, session id a
  lower-case UUID, entrypoint the word `claude-vscode`, bundle id VS Code's own (`com.microsoft.VSCode`). Each command
  runs with no shell, every value one argument, under `RUN_TIMEOUT_MS` (10 s).
- No hint carries a secret. `TMUX` (the socket path) and VS Code's IPC paths are never read or sent.
- tmux is the daemon's: the name `tmux` on its `PATH` and its own environment. Never `-L` or `-S`.
- The devices run three tmux commands and no other: `display-message -p` and `list-clients -F` (both only read), and
  `switch-client -c <client> -t <pane>`. Never a bare `switch-client`, and never a client on a session Harness made.
- Log lines name the app only, never a pane, a pid, a session or a path. The lines, verbatim:
  `[device] open · tmux · not its pane`, `[device] open · harness · no window`, and the existing
  `[device] open · <app> · fallback`.
- Copy, verbatim: `Harness did not open it.`
- Values, verbatim: `MAX_HINTS` 10, `WALK_PARENTS` 16, `HARNESS_OPEN_WAIT_MS` 30 000, the bundle id
  `ai.autonomous.harness`, the link `vscode://anthropic.claude-code/open?session=<uuid>`.
- Nothing is typed into a tmux pane the person owns: no `send-keys`.
- A fake `run` written or touched by this plan answers `stdout: ''` beside its code.
- Platforms: macOS all three; Linux F1 only (listing, voice, the switch, no app forward); Windows none.
- **No test moves anything on the developer's Mac** (`cli/AGENTS.md` rule 6). Unit specs record commands and run
  none. No end-to-end test sends `agent.open` to a Harness agent with no window: on macOS that would run the real
  `/usr/bin/open -b ai.autonomous.harness`.

## Found while reading #4341

- `Entry.pid` in `observed.ts` is the first event's process (it is what the liveness scan reads). The latest
  event's caller is kept nowhere but as `learnTty`'s argument, so the place's `pid` needs a field of its own
  (Task 13).
- `observed.spec.ts`, "an app the source never heard of costs one adapter…", holds the exact place an adapter is
  asked with: `{ host, app, hints }`. It gains `pid: 100` in Task 13 and `sessionId: 's1'` in Task 16.
- `devices.spec.ts` mocks `cable/hosts/scannedApp.js` with `learnApps` alone. `tmux.ts` imports `parentChain` from
  that file, so the mock spreads the real module (Task 13).
- `devices.spec.ts`'s `orca` fake answers one path for every binary (`onPath: () => '/opt/orca/bin/orca'`): its tests
  tell commands apart by their arguments.
- `open.spec.ts`'s `recorder` and `tapped` lists are fixtures of their own, not the devices' list. They stay as
  #4341 left them.
- Every terminal Harness has open is a control-mode client on the daemon's tmux server, and a bare
  `switch-client` moves the client used last, one of those included (seen on tmux 3.6b; the first plan,
  `5ffad15299`, has the whole check). `list-clients -F` lists clients in the order they attached;
  `#{client_activity}` is in whole seconds.
- **Not covered by the client rule, and left as it is.** A Harness terminal on a window the person moved into a
  session of their own, while that session shows another window, reads as the person's client. The rule is the
  PM's, per session (Left out).

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/cable/hosts/orca.ts`, `orca.spec.ts` | `run` answers stdout (10); no pane in a multiplexer (11) | 10, 11 |
| `cli/src/cable/hosts/herdr.spec.ts`, `wezterm.spec.ts`, `claudeApp.spec.ts` | their fakes answer `stdout: ''` | 10 |
| `cli/src/cable/hosts/tabs.ts`, `tabs.spec.ts` | a pane only for the nearest host | 11 |
| `cli/src/cable/hosts/tmux.ts`, `tmux.spec.ts` | new: the tmux adapter | 12 |
| `cli/src/cable/hosts/scannedApp.ts` | `walk` becomes the exported `parentChain` | 12 |
| `cli/src/cable/hosts/adapter.ts` | `Place.pid`, `focus` answers `'refused'` (12); `Place.sessionId` (16) | 12, 16 |
| `cli/src/cable/hosts/open.ts` | a refused pane (12); `desktop` (14) | 12, 14 |
| `cli/src/cable/hosts/open.spec.ts` | fakes (10); a refused pane (12); `desktop` (14) | 10, 12, 14 |
| `cli/src/services/AGENTS.md` | the tmux rule's file pointer | 12 |
| `cli/src/cable/hosts/observed.ts` | the place's `pid` (13); its `sessionId` (16) | 13, 16 |
| `cli/src/cable/hosts/observed.spec.ts` | fake (10); the rule's tests (11); tmux (13); VS Code (16) | 10, 11, 13, 16 |
| `cli/src/services/devices.ts` | tmux in the list (13); Desktop's wiring (14); VS Code in the list (16) | 13, 14, 16 |
| `cli/src/services/devices.spec.ts` | fakes (10); tmux (13); Desktop (14); VS Code (16) | 10, 13, 14, 16 |
| `cli/src/cable/hosts/hostDetect.ts` | `HARNESS_BUNDLE` | 14 |
| `cli/e2e/deviceWithoutApp.e2e.ts` | a Harness agent's caps on macOS (14); the tmux cases, carried (15) | 14, 15 |
| `cli/e2e/harness/ownTmux.ts` | carried | 15 |
| `cli/src/cable/hosts/vscode.ts`, `vscode.spec.ts` | new: the VS Code adapter | 16 |
| `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts` | the `CLAUDE_CODE_ENTRYPOINT` hint | 16 |

## The tasks at a glance

| Task | Depends on | Effort | May run beside |
| --- | --- | --- | --- |
| 9. Rebuild the branch on #4341 | nothing | xhigh | nothing: alone |
| 10. The runner answers what a command printed | 9 | medium | nothing: it touches the specs the others touch |
| 11. The multiplexer rule in the Orca and tabs adapters | 9 | high | 12, 14 |
| 12. The tmux adapter | 10 | xhigh | 11 |
| 13. The tmux adapter in the source and the devices | 12 | high | nothing: it shares files with 11, 14 and 16 |
| 14. The devices start Harness Desktop | 9 | high | 11 (not 12: `open.ts`) |
| 15. End to end: the carried commit | 13 | high | 16 |
| 16. The VS Code adapter (F3) | 13, and 11 and 14 for its place in the history | xhigh | 15 |

Longest chain: 9, 10, 12, 13, 16. diegodev starts a task once the tasks it depends on are done and no running task
shares its files; each task's **Files** list is complete.

## Review Focus

Each line is pinned by a test in the task that owns the code.

- **A terminal Harness has open (Desktop, a phone, `hn`) is the tmux client used last.** The tap never moves it.
  Task 12, `tmux.spec.ts` "the client switched is the one used last among those not on a session Harness made" and
  "with no client of the person's nothing is switched"; Task 15's second case, on a real tmux.
- **A multiplexer started inside an Orca terminal, any of the four.** The dial's words are never typed into that
  terminal, and a rest switches nothing there. Task 11, `observed.spec.ts` "%s inside an Orca terminal takes no words
  and no rest through Orca".
- **A pane of the same id on the person's second tmux server, or an agent whose process is gone.** Nothing is
  switched, one line says so, no fallback line follows, and the app still comes forward. Task 12, `tmux.spec.ts`
  "a pane of that id that holds another process…" and "an agent whose process is gone…", `open.spec.ts` "a pane its
  adapter refuses…".
- **An agent whose hook carries several hosts' values** (tmux started in WezTerm or Orca, herdr inside tmux). The tap
  takes the nearest. Task 13, `devices.spec.ts` "a tap takes herdr's pane before tmux's, and tmux's before WezTerm's
  and Orca's".
- **The session moved to another pane by the tap.** The pane and the process checked are its latest event's.
  Task 13, `observed.spec.ts` "the pane a tap opens is its latest event's, with that event's process".

Carried, pinned by kept commits: a Notification from a Harness pane while tmux is too slow (`hookNotify.spec.ts`);
the window that says its tabs while `open -b` still runs (`cableHost.spec.ts`).

No test can pin this one: Desktop may say its tabs before it can open a tile, and then drop the `dial_open` it is
handed. The spec's check 5 is the proof, and a miss there is a Desktop change, which this work does not make.

---

## Carried over, done

Their steps are in the first plan (`git show 5ffad15299:docs/plans/2026-11-15-device-wave1-checks-plan.md`).

| Old task | Commits | Pinned by |
| --- | --- | --- |
| 1. The hook tells the devices of a session in the person's own tmux pane | `e5ae461578`, `8b53000b20`; on Linux `363898d9bd`, `eab6b4526c` | `hookNotify.spec.ts` |
| 2. The host and the app `tmux` | `88ec509c6c`, `6026ae7183`; the firmware's line `662c6f2464` | `hostDetect.spec.ts`, `devicesListener.spec.ts`, `test_touch_ui.py` |
| 4. The tmux rule in the services' rules | `c0ab186639` | none: no behavior |
| 5. A tap on a Harness agent waits for Desktop's window | `e10826094c`, `70336f946c`, `1f168019f7`, `45730afcdf` | `cableHost.spec.ts`, `harness.spec.ts` |
| 8. End to end | `63467b24a8` | carried by Task 15 |

What they give the tasks below: `hostHints.TMUX_PANE` on an own-pane session's events; `detectHost` and `detectApp`
answer `'tmux'`; `CableHostWiring.launchDesktop?: () => Promise<boolean>`, `desktopTimedOut?: () => void`,
`HARNESS_OPEN_WAIT_MS`; `new HarnessSource(now, opens)`.

---

### Task 9: Rebuild the branch on #4341

**Who:** one `diegodev-implementer`, in the branch's main checkout
(`/Users/duynguyen/orca/workspaces/autonomous-harness/wave1-checks`, where `fix/device-wave1-checks` is checked out;
no task worktree can hold the branch), **with no other task running**.

**Depends on:** nothing. **Effort:** xhigh.

**Files:** none edited. The branch's history only. If this plan is not committed yet, it is committed first
(`docs/plans/2026-11-15-device-wave1-checks-plan.md`).

**The test that fails before the change:** none: no behavior.

**If `main` moved:** nothing changes here: the base is `5fa7b95762`, whatever `origin/main` is.

- [ ] **Step 1: A clean tree, and the plan committed.** `git status --short` shows nothing, or this plan alone. If
  the plan is uncommitted, commit it by itself: `docs: plan for the port onto #4341's host adapters`. Then
  `git diff --stat a1271e88fb HEAD` names files under `docs/` only. Anything else: stop and report.

- [ ] **Step 2: Keep the old history, and move the branch.**

```bash
git branch wave1-checks-before-port HEAD      # local only, never pushed: the way back, and where later tasks read old tests
git cat-file -e '5fa7b95762^{commit}' || git fetch origin main
git reset --hard 5fa7b95762
```

- [ ] **Step 3: The 18 kept commits, in this order, then the plan's own.**

```bash
git cherry-pick 7f8b6fc35d 5ffad15299 e5ae461578 8b53000b20 e10826094c 70336f946c c0ab186639 88ec509c6c 6026ae7183 \
  1f168019f7 45730afcdf ea65c9c4e7 c66f6ad3f8 662c6f2464 0fb12e70f5 363898d9bd eab6b4526c a1271e88fb
git cherry-pick a1271e88fb..wave1-checks-before-port
```

  The second command carries the plan's commit of step 1 (if the main session folded the plan into another commit
  and that range is empty, skip it). Expected: no conflict (checked on a scratch clone). On a conflict nothing is
  resolved by hand:
  `git cherry-pick --abort`, `git reset --hard wave1-checks-before-port`, and report the commit and the file.

- [ ] **Step 4: Prove what was kept and what was dropped.**

```bash
git range-diff 1c37a340a8..wave1-checks-before-port 5fa7b95762..HEAD
```

  Expected: every kept commit and each plan commit on a line with `=`; these 16 on a line with `<` and no other:
  `43d649cf6d e258f87e91 746b4ba2b6 3166f17cad 910c17679e f284be53c7 63467b24a8 82114fe8ac 383fb6d9a1 e6245ff7c5
  6c5612754e 8e14588ddc 6059d5ed95 88bff51abb 149270fd6c a510955e27`. No line with `!` or `>`.

- [ ] **Step 5: Run**

```bash
cd cli && npm run typecheck
npx vitest run src/hookNotify.spec.ts src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts
cd .. && python3 devices/harness-device/firmware/test/test_touch_ui.py
```

  Expected: no type error; every spec passed (2010 tests in the trial; `leanEntry.spec.ts` could not run in the
  trial's sparse clone, so it is first seen here); the firmware's contract exits 0: its host table still equals the
  daemon's names, with #4341's firmware change beside this branch's line.

- [ ] **Step 6: Report** the new SHA of each kept commit beside its old one, and the head. No push: the branch on
  GitHub holds an older history, and the force push is the main session's.

### Task 10: The runner answers what a command printed

**Depends on:** Task 9. **Effort:** medium.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts` (`OrcaDeps.run`, `orcaDeps`)
- Test: `cli/src/cable/hosts/orca.spec.ts`
- Modify, fakes only: `cli/src/cable/hosts/herdr.spec.ts`, `cli/src/cable/hosts/wezterm.spec.ts`,
  `cli/src/cable/hosts/claudeApp.spec.ts`, `cli/src/cable/hosts/open.spec.ts`,
  `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`

**The test that fails before the change:** `cli/src/cable/hosts/orca.spec.ts`, "run answers what the command
printed".

**Interfaces:**
- Produces: `OrcaDeps.run(file, args, timeoutMs): Promise<{ code: number | null; stdout: string }>`.

**If `main` moved:** `OrcaDeps.run` is still the one runner the adapters share (`herdr.ts`, `wezterm.ts` and
`claudeApp.ts` take `OrcaDeps` or a `Pick` of it). After step 3, `npm run typecheck` names every fake that still
answers a code alone, `main`'s new ones included: each gains `stdout: ''`.

- [ ] **Step 1: The red tests.** In `orca.spec.ts`, as `43d649cf6d` wrote them
  (`git show 43d649cf6d -- cli/src/cable/hosts/orca.spec.ts`): "a non-zero exit is false" expects
  `{ code: 3, stdout: '' }` and `{ code: null, stdout: '' }`; "run answers what the command printed": a script that
  prints `4242` answers `{ code: 0, stdout: '4242\n' }`. In the same commit every fake `run` in the six spec files
  answers `stdout: ''` beside its code: they compile before the change too.

  Run: `cd cli && npx vitest run src/cable/hosts/orca.spec.ts -t 'non-zero exit|what the command printed'`
  Expected: FAIL, `{ code: 3 }` where `{ code: 3, stdout: '' }` is expected.

- [ ] **Step 2: Commit the red tests**: `test(devices): a command's runner answers what it printed (red)`

- [ ] **Step 3: `orca.ts`**: `run` answers `{ code, stdout }`; `orcaDeps().run` passes on what `execFile` read, and
  `''` at its deadline. Its comment: tmux's answer is its stdout (`tmux.ts`).

- [ ] **Step 4: Run** `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`.
  Expected: PASS, no type error.

- [ ] **Step 5: Commit**: `devices: a command's runner answers what it printed`

### Task 11: The multiplexer rule in the Orca and tabs adapters

**Depends on:** Task 9. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts` (`createOrcaAdapter().paneOf`, new `MULTIPLEXERS`), test
  `cli/src/cable/hosts/orca.spec.ts`
- Modify: `cli/src/cable/hosts/tabs.ts` (`createTabsAdapter().paneOf`), test `cli/src/cable/hosts/tabs.spec.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

**The test that fails before the change:** `cli/src/cable/hosts/observed.spec.ts`, "herdr inside an Orca terminal
takes no words and no rest through Orca".

**Interfaces:**
- Produces: for a place whose `host` is `herdr`, `rex`, `zellij` or `tmux`, the Orca adapter's `paneOf` is
  `undefined`. The tabs adapter's `paneOf` is `undefined` unless `place.host === place.app` or
  `place.host === UNKNOWN_APP`.

**If `main` moved:**
`grep -n "HERDR_PANE_ID\|REX_BLOCK\|ZELLIJ\|TMUX_PANE" cli/src/cable/hosts/observed.spec.ts cli/src/services/devices.spec.ts cli/e2e/*.e2e.ts`:
a test that expects words, a rest or a tab select for such an agent is read against the rule and reported (on
`5fa7b95762`: only the two herdr tests below). `createTabsAdapter().paneOf` still reads `place.app` and
`place.tty`; `createOrcaAdapter().paneOf` still reads `ORCA_TERMINAL_HANDLE` alone.

- [ ] **Step 1: The red tests**

  `orca.spec.ts`, in `describe('Orca adapter')`, with that block's adapter:

```ts
it('in a multiplexer it has no pane: the handle names the terminal the multiplexer started in', () => {
  const hints = { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }
  for (const host of ['herdr', 'rex', 'zellij', 'tmux']) expect(adapter.paneOf({ host, app: 'orca', hints }), host).toBeUndefined()
  for (const host of ['orca', 'wezterm', 'kitty', 'terminal']) expect(adapter.paneOf({ host, app: 'orca', hints }), host).toEqual({ adapter: 'orca', id: HANDLE })
})
```

  `tabs.spec.ts`, in `describe('the tabs adapter')`: the `place` helper takes the host, the app by default
  (`(app, tty?, host = app)`; it was `'claude'` for every app). The existing cases keep what they expect. Add:

```ts
it('paneOf: only while the tab app is the agent\'s nearest host', () => {
  const { adapter } = recorder()
  for (const host of ['herdr', 'rex', 'zellij', 'tmux', 'wezterm', 'kitty', 'orca']) {
    expect(adapter.paneOf(place('ghostty', '/dev/ttys023', host)), host).toBeUndefined()
  }
  // A session the open scan found: no hook has named its host yet, and its parents named the app.
  expect(adapter.paneOf(place('ghostty', '/dev/ttys023', 'terminal'))).toStrictEqual(pane('ghostty:/dev/ttys023'))
})
```

  `observed.spec.ts`, three changes:

  1. `describe('ObservedSource panes')`: the `it.each` "%s inside an Orca terminal still takes the dial's words and a
     rest through Orca" keeps its WezTerm row alone, and its comment names WezTerm, not "a multiplexer". Beside it:

```ts
// A multiplexer started in an Orca terminal passes that terminal's handle, and its tty, to every pane: typed through
// Orca, the dial's words land in whichever pane it shows, another agent's or a shell's (PM, 2026-11-15).
it.each([
  ['herdr', { HERDR_PANE_ID: 'w1:p2' }],
  ['Rex', { REX_BLOCK: 'x' }],
  ['Zellij', { ZELLIJ: '0' }],
  ['tmux', { TMUX_PANE: '%3' }],
])('%s inside an Orca terminal takes no words and no rest through Orca', async (_name, hints) => {
  const { actions, ready } = fakeActions()
  const { src, ev } = setup({ actions })
  src.ingest(ev('turn-stop', { hostHints: { ...hints, ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE, __CFBundleIdentifier: 'com.stablyai.orca' } }))
  const agent = src.list()[0]
  expect(src.capabilities(agent)).toMatchObject({ voice: false, focus: true })
  expect(src.hasPane(agent)).toBe(false)
  expect(await src.showPane(agent)).toBe('failed')
  expect(await src.send(agent, 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
  // Its voice is its mod's.
  ready.add('s1')
  expect(src.capabilities(agent)).toMatchObject({ voice: true })
  expect(await src.send(agent, 'next')).toEqual({ ok: true })
  expect(actions.orcaSend).not.toHaveBeenCalled()
  expect(actions.orcaSwitch).not.toHaveBeenCalled()
  // A tap: Orca comes forward, and never by its terminal's handle (open question 1).
  expect(await src.focus(agent)).toBe(true)
  expect(actions.open.mock.calls[0][1].bundle).toBe('com.stablyai.orca')
  expect(actions.open.mock.calls[0][1].pane?.adapter).not.toBe('orca')
})
```

  2. `describe('ObservedSource and codex queue')`: the case of `149270fd6c`
     (`git show 149270fd6c -- cli/src/cable/hosts/observed.spec.ts`), "in Zellij, herdr or Rex inside Orca, an idle
     agent with no mod and a Codex whose queue failed are not typed into", with tmux's row (`{ TMUX_PANE: '%3' }`)
     added and its title naming the four.

  3. `describe('ObservedSource tabs')`: "herdr inside Ghostty with a watch open still writes its tab select, on a rest
     and after a tap" is replaced by:

```ts
// Its tty is the multiplexer pane's, which no tab holds: a select would find nothing, and a rest would count as shown.
it.each([
  ['herdr', { HERDR_PANE_ID: 'w1:p2' }],
  ['Rex', { REX_BLOCK: 'x' }],
  ['Zellij', { ZELLIJ: '0' }],
  ['tmux', { TMUX_PANE: '%3' }],
])('an agent in %s inside Ghostty has no tab: a rest shows nothing, and a tap selects none', async (_name, hints) => {
  const t = tabs()
  t.src.ingest(t.ev('session-start', { hostHints: { ...hints, __CFBundleIdentifier: 'com.mitchellh.ghostty' } }))
  await t.reads[0].answer(TTY)
  expect(t.src.hasPane(t.agent())).toBe(false)
  expect(await t.src.showPane(t.agent())).toBe('failed')
  expect(await t.src.focus(t.agent())).toBe(true)
  expect(t.actions.open).toHaveBeenCalledTimes(1)
  expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.mitchellh.ghostty')
  expect(t.actions.tabSelect).not.toHaveBeenCalled()
  expect(t.actions.orcaSwitch).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/cable/hosts/orca.spec.ts src/cable/hosts/tabs.spec.ts src/cable/hosts/observed.spec.ts -t 'multiplexer|nearest host|no words and no rest|not typed into|has no tab'`
  Expected: FAIL: Orca's pane is given, words are typed through Orca, the tab select is written.

- [ ] **Step 3: Commit the red tests**: `test(devices): in herdr, Rex, Zellij or tmux an agent has no Orca pane and no tab (red)`

- [ ] **Step 4: Implement**
  - `orca.ts`: `const MULTIPLEXERS: ReadonlySet<string> = new Set(['herdr', 'rex', 'zellij', 'tmux'])`
    (`detectHost`'s ids), and `paneOf` answers `undefined` for a place whose host is one. The comment is the PM's
    reason: these keep the environment of the terminal they were started in, so the handle names that terminal, not
    where the agent is, and words typed there land in whichever pane it shows, another agent's or a shell's. So
    the agent has no Orca pane: no words, no rest, no tap through Orca (the spec, Decided).
  - `tabs.ts`: `paneOf` answers `undefined` unless `place.host === place.app || place.host === UNKNOWN_APP`
    (`UNKNOWN_APP` from `./hostDetect.js`). Comment: in a multiplexer inside the tab app the agent's tty is that
    pane's, which no tab holds; a session the open scan found has no host named yet, and its parents named the app.
    The file's "Types only" comment says what the new import is: constants, and a file that imports nothing.
  - Nothing in `observed.ts`: `byTab` and `learnTty` stay as they are.

- [ ] **Step 5: Run**

  Run: `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts`
  Expected: PASS. Of #4341's tests, only these changed in what they expect: the herdr row, the herdr-in-Ghostty
  case, and `tabs.spec.ts`'s helper. Any other: stop and report.

- [ ] **Step 6: Commit**: `devices: in herdr, Rex, Zellij or tmux an agent has no Orca pane and no tab of its own`

### Task 12: The tmux adapter

**Depends on:** Task 10 (`run`'s stdout). **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/hosts/tmux.ts`, test `cli/src/cable/hosts/tmux.spec.ts`
- Modify: `cli/src/cable/hosts/scannedApp.ts` (`walk` becomes the exported `parentChain`)
- Modify: `cli/src/cable/hosts/adapter.ts` (`Place.pid`, `HostAdapter.focus`'s answer, rule 3's sentence)
- Modify: `cli/src/cable/hosts/open.ts` (`open`), test `cli/src/cable/hosts/open.spec.ts`
- Modify: `cli/src/services/AGENTS.md` (in the tmux rule, `cable/hosts/open.ts` becomes `cable/hosts/tmux.ts`; no
  other word)

**The test that fails before the change:** `cli/src/cable/hosts/tmux.spec.ts`, "the pane holds the agent: the
person's client is switched to it, then its app comes forward".

**Interfaces:**
- Consumes: Task 10's `run`.
- Produces, for Tasks 13 and 16:

```ts
// adapter.ts
export interface Place { /* host, app, hints, tty? as now */ pid?: number }   // its process: that event's caller
focus(pane: Pane): Promise<boolean | 'refused'>
// scannedApp.ts
export function parentChain<P extends Pick<ProcessName, 'pid' | 'ppid'>>(pid: number, table: ReadonlyMap<number, P>): P[]
// tmux.ts
export interface TmuxDeps {
  run: OrcaDeps['run']
  /** The machine's processes, as the open scan reads them; it rejects when the table cannot be read. */
  processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>
  log(line: string): void
}
export function createTmuxAdapter(deps: TmuxDeps): HostAdapter
// id 'tmux', tap 'before', canFocus on every platform, no show, no type.
// Its pane: { adapter: 'tmux', id: `${hints.TMUX_PANE}:${place.pid}` }, as '%3:100'.
```

**If `main` moved:** `adapter.ts` still has `Place` and `focus(pane): Promise<boolean>` as #4341 left them;
`open.ts` `open()` still tests `own && await own.adapter.focus(own.pane)` and then writes the fallback line;
`scannedApp.ts` still has a local `walk` under `WALK_PARENTS`; `lib/harnessSessionLabel.ts` still exports
`HARNESS_OWNER_OPTION` and `isHarnessSession`, and the devices process already loads it (`observed.ts` reaches it
through `lib/sessionSearch/externals/support.ts`), so `src/architecture.spec.ts` passes.

- [ ] **Step 1: The red tests**

  `tmux.spec.ts`. The tests and their fixtures are the branch's own, moved:
  `git show a1271e88fb:cli/src/cable/hosts/open.spec.ts`, lines 12 to 58 (`TABLE`, `PANE`, `IN_GHOSTTY`, `TAG`,
  `client`, `OWN`, `asked`, `listed`, `switched`, `ghostty`, `fallback`) and the
  `describe('a tap on an agent in the person's own tmux pane…')`, lines 281 to 397. What changes:

```ts
/** A recording runner that runs nothing, so no spec moves a tmux client or brings the developer's own apps forward: each
 *  call answers the next of [codes], then exit 0, and tmux prints what [said] gives it. The opener holds this adapter alone. */
function recorder(over: Partial<TmuxDeps & { platform: NodeJS.Platform }> = {}, codes: Array<number | null> = [], said: { pane?: string; clients?: string } = {}) {
  // calls, logs; deps = { run (as the old recorder's), processes: async () => TABLE, log, platform: 'darwin', ...over }
  const adapter = createTmuxAdapter(deps)
  return { calls, logs, adapter, opener: createOpenActions({ run: deps.run, platform: deps.platform, adapters: [adapter], log: deps.log }) }
}
/** What the agent's hook hints let a tap open, as the observed source reads them, its process the hook's caller. */
const target = (hints: Record<string, string>, pid = 100): OpenTarget => {
  const place = { host: detectHost(hints), app: detectApp(hints), hints, pid }
  return { bundle: bundleOf(place.host, hints), pane: recorder().adapter.paneOf(place) }
}
```

  - The pane reads `{ adapter: 'tmux', id: '%3:100' }` where the old tests say `{ app: 'tmux', id: PANE, pid: 100 }`.
  - Every expectation of commands and log lines is unchanged.
  - "herdr's pane wins over tmux's" and "tmux's pane wins over WezTerm's and Orca's" do not move here: the order is
    the devices' list (Task 13).
  - The first case is named "the pane holds the agent: the person's client is switched to it, then its app comes
    forward".

  New, as `herdr.spec.ts` has them:

```ts
it('its id is tmux, it taps before its app, it can focus on every platform, and it has no show and no type', () => { /* id, tap, canFocus, show, canShow, type */ })

it('paneOf takes a pane id and the agent\'s process, and refuses any other', () => {
  const { adapter } = recorder()
  const place = (hints: Record<string, string>, pid?: number) => ({ host: 'tmux', app: 'tmux', hints, pid })
  expect(adapter.paneOf(place({ TMUX_PANE: '%3' }, 100))).toEqual({ adapter: 'tmux', id: '%3:100' })
  // From its own values alone: another host's beside it changes nothing (adapter.ts, rule 4).
  expect(adapter.paneOf(place({ TMUX_PANE: '%3', HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }, 100))).toEqual({ adapter: 'tmux', id: '%3:100' })
  expect(adapter.paneOf(place({}, 100))).toBeUndefined()
  for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) expect(adapter.paneOf(place({ TMUX_PANE: '%3' }, pid)), String(pid)).toBeUndefined()
  for (const id of ['3', '%', '%3; rm -rf /', '%1234567890', '-t', '%3 ']) expect(adapter.paneOf(place({ TMUX_PANE: id }, 100)), id).toBeUndefined()
})

it('focus answers what happened: true once switched, refused when the pane holds another process, false when not reached', async () => {
  const pane = { adapter: 'tmux', id: '%3:100' }
  expect(await recorder({}, [], OWN).adapter.focus(pane)).toBe(true)
  const other = recorder({}, [], { ...OWN, pane: '4242\n' })
  expect(await other.adapter.focus(pane)).toBe('refused')
  expect(other.logs).toEqual(['[device] open · tmux · not its pane'])
  const silent = recorder({}, [1], OWN)
  expect(await silent.adapter.focus(pane)).toBe(false)
  expect(silent.logs).toEqual([])
})

it('a pane id not in its form runs nothing', async () => {
  const { calls, adapter } = recorder({}, [], OWN)
  for (const id of ['%3', '%3:', ':100', '%3:0', '%3:100; rm -rf /', '%3:100:1', '-t:100', '%3 :100']) {
    expect(await adapter.focus({ adapter: 'tmux', id }), id).toBe(false)
  }
  expect(calls).toEqual([])
})

it('its lines name the app only', async () => {
  const refused = recorder({}, [], { ...OWN, pane: '4242\n' })
  await refused.opener.open('a1', target(IN_GHOSTTY))
  const failed = recorder({}, [1], OWN)
  await failed.opener.open('a1', target(IN_GHOSTTY))
  for (const line of [...refused.logs, ...failed.logs]) for (const id of [PANE, '90', '100', '4242', 'ttys004', '/']) expect(line).not.toContain(id)
})
```

  `open.spec.ts`, in `describe('a tap in the order its pane's adapter keeps')`: `withMadeUp`'s second argument is
  `focused: boolean | 'refused' = true`, and the recorder it builds takes `codes`. Add:

```ts
// The adapter said why in a line of its own (tmux: "not its pane"): the opener adds none, and the app still comes.
it('a pane its adapter refuses: open -b alone and no fallback line; false with no app, or when the app does not come', async () => {
  const refused = withMadeUp('before', 'refused')
  expect(await refused.opener.open('a1', both)).toBe(true)
  expect(refused.adapter.focus.mock.calls).toEqual([[PANE]])
  expect(refused.calls).toEqual([forward(TERMINAL)])
  expect(refused.logs).toEqual([])
  const bare = withMadeUp('before', 'refused')
  expect(await bare.opener.open('a1', { pane: PANE })).toBe(false)
  expect(bare.calls).toEqual([])
  const instead = withMadeUp('instead', 'refused')
  expect(await instead.opener.open('a1', both)).toBe(true)
  expect(instead.calls).toEqual([forward(TERMINAL)])
  expect(instead.logs).toEqual([])
  const stuck = withMadeUp('before', 'refused', [1])
  expect(await stuck.opener.open('a1', both)).toBe(false)
})
```

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/cable/hosts/tmux.spec.ts src/cable/hosts/open.spec.ts -t 'tmux|refuses|the pane|client|process|its lines|pane id'`
  Expected: FAIL: `tmux.spec.ts` cannot load `./tmux.js`; in `open.spec.ts` a refused pane with no app answers true.
  The typecheck fails too until step 5: a `focus` that answers `'refused'` is no `HostAdapter`'s yet.

- [ ] **Step 3: Commit the red tests**: `test(devices): a tmux adapter switches the person's client to the agent's pane, and refuses a pane that is not its own (red)`

- [ ] **Step 4: `scannedApp.ts`**: `parentChain`, as `e6245ff7c5` made it
  (`git show e6245ff7c5 -- cli/src/cable/hosts/scannedApp.ts` applies as it is: #4341 did not touch the file). Its
  comment names `tmux.ts`, not `open.ts`.

- [ ] **Step 5: `adapter.ts`**: `Place.pid` and `focus`'s answer, as in Interfaces. `focus`'s comment says what
  refused is: the pane is not the agent's, the adapter said so in a line of its own, and the opener brings the app
  forward with no fallback line. Rule 3 in the header gains `'refused'`.

- [ ] **Step 6: `open.ts` `open()`** reads `focus`'s answer once. `true`: today's path. `'refused'`: the app comes
  forward by its bundle, with no `· fallback` line; false with no bundle. `false`: today's fallback line and
  `open -b`. Nothing else in the file moves.

- [ ] **Step 7: `tmux.ts`.** Move, do not rewrite: `tmuxFocus`, `chainOf`, `personsClient`, `TMUX_CLIENTS`,
  `TMUX_CLIENT`, `PID` and their comments from `git show a1271e88fb:cli/src/cable/hosts/open.ts`. What changes:
  - `paneOf(place)`: `place.hints.TMUX_PANE` passes `/^%[0-9]{1,9}$/` and `place.pid` is a positive integer; else
    none.
  - `focus(pane)`: the id passes `/^(%[0-9]{1,9}):([1-9][0-9]{0,9})$/`, or nothing runs and it answers false. Then
    the four steps in their order: `display-message` for the pane's process; the agent's chain from
    `deps.processes()` (a rejection is "not reached"); `· not its pane` and `'refused'` when the chain does not hold
    it; `list-clients`, the person's client, `switch-client -c`.
  - The header says what the file is, Q1's rule in one sentence, and the spec's path.

- [ ] **Step 8: `services/AGENTS.md`**: the pointer, one path.

- [ ] **Step 9: Run**

  Run: `cd cli && npm run typecheck && npx vitest run src/cable/hosts src/architecture.spec.ts src/leanEntry.spec.ts`
  Expected: PASS.

- [ ] **Step 10: Commit**: `devices: a tmux adapter switches the person's client to the agent's pane, once the pane's process is checked`

### Task 13: The tmux adapter in the source and the devices

**Depends on:** Task 12. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`Entry`, `ingest`, `locate`), test `cli/src/cable/hosts/observed.spec.ts`
- Modify: `cli/src/services/devices.ts` (the adapters' list, two imports), test `cli/src/services/devices.spec.ts`

**The test that fails before the change:** `cli/src/services/devices.spec.ts`, "an agent in the person's own tmux
lists f, and its tap checks the pane's process, then switches the person's client".

**Interfaces:**
- Consumes: Task 12's `createTmuxAdapter`, `TmuxDeps`, `Place.pid`.
- Produces, for Task 16: the place `locate` builds, `{ host, app, hints, tty, pid }`; the devices' list
  `[herdr, tmux, wezterm, orca, claude, tabs]`; `fakeActions`' list in the same order.

**If `main` moved:** in `devices.ts` the list is still `[createHerdrAdapter(apps), createWeztermAdapter(apps),
createOrcaAdapter(apps), {...claude…}, createTabsAdapter(…)].map(noting)`, `noting` still passes `focus`'s answer
on, and the opener is still `createOpenActions({ run: apps.run, platform: apps.platform, adapters, log })` (#4340
changes this file: read its diff round the list first). In `observed.ts`, `ingest` still sets `entry.hints` and then
calls `this.locate(entry)`, and `locate` still builds the place in one object. `devices.spec.ts` still mocks
`../cable/hosts/scannedApp.js` by name.

- [ ] **Step 1: The red tests**

  `observed.spec.ts`:
  - `fakeActions`: the list gains `createTmuxAdapter({ run: ran, processes: async () => [], log: () => {} })` after
    herdr's.
  - "an app the source never heard of costs one adapter…": the place expected gains `pid: 100`.
  - From `43d649cf6d` (`git show 43d649cf6d -- cli/src/cable/hosts/observed.spec.ts`), with the pane in its new form:
    "the pane a tap opens is its latest event's, with that event's process" expects
    `{ pane: { adapter: 'tmux', id: '%9:200' } }`; "an agent in tmux inside Terminal: a tap opens through its tmux
    pane" expects `{ bundle: 'com.apple.Terminal', pane: { adapter: 'tmux', id: '%3:100' } }`. That no tab is
    selected after it is Task 11's case, not this one's: the two tasks stay apart.

  `devices.spec.ts`:
  - The `scannedApp.js` mock spreads the real module and adds `readProcessNames: readers.processes`
    (`vi.fn(async () => [] as Array<{ pid: number; ppid: number; executable: string }>)`, hoisted with the other
    readers and reset in `beforeEach`), as `43d649cf6d` has it.
  - "an agent in the person's own tmux lists f, and its tap checks the pane's process, then switches the person's
    client": as at `a1271e88fb` (`git show a1271e88fb:cli/src/services/devices.spec.ts`), unchanged.
  - New, beside it:

```ts
// The order the panes are asked in: a tmux server keeps the environment it started in, so in its pane WezTerm's and
// Orca's values name the terminal the server began in.
it('a tap takes herdr\'s pane before tmux\'s, and tmux\'s before WezTerm\'s and Orca\'s', async () => {
  readers.processes.mockResolvedValue([{ pid: 4242, ppid: 4000, executable: 'claude' }, { pid: 4000, ppid: 1, executable: 'zsh' }])
  const { port } = startHere({ orca: { ...mac, run: async (file, args, timeoutMs) => {
    orcaRuns.push([file, args, timeoutMs])
    return { code: 0, stdout: args[0] === 'display-message' ? '4000\n' : args[0] === 'list-clients' ? '1794700050|/dev/ttys004||work\n' : '' }
  } } })
  const around = { WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: HANDLE, __CFBundleIdentifier: 'dev.warp.Warp-Stable' }
  port.observed(hook('session-start', { hostHints: { TMUX_PANE: '%3', ...around } }))
  attach(port)
  expect(await host().openAgent(ID)).toBeUndefined()
  expect(orcaRuns.map(([, args]) => args[0])).toEqual(['display-message', 'list-clients', 'switch-client', '-b'])
  orcaRuns.length = 0
  port.observed(hook('session-start', { hostHints: { HERDR_PANE_ID: 'w1:p2', TMUX_PANE: '%3', ...around } }))
  expect(await host().openAgent(ID)).toBeUndefined()
  expect(orcaRuns.map(([, args]) => args.slice(0, 2))).toEqual([['agent', 'focus'], ['-b', 'dev.warp.Warp-Stable']])
})
```

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts -t 'tmux|never heard of|latest event'`
  Expected: FAIL: the tap runs `wezterm cli activate-pane`, and no tmux command.

- [ ] **Step 3: Commit the red tests**: `test(devices): a tap on an agent in the person's own tmux goes through the tmux adapter, before WezTerm's and Orca's (red)`

- [ ] **Step 4: `observed.ts`**
  - `Entry.caller?: number`: the process its latest event came from; none for a session the scan found, until its
    first.
  - `ingest`: `entry.caller = e.callerPid`, beside `entry.hints = e.hostHints` and before `this.locate(entry)`.
  - `locate`: the place gains `pid: entry.caller`.
  - No other line: the source holds no rule about tmux.

- [ ] **Step 5: `devices.ts`**: `createTmuxAdapter({ run: apps.run, processes: readProcessNames, log })` after
  `createHerdrAdapter(apps)`, with `readProcessNames` imported beside `learnApps`. The list's comment says why tmux
  is before WezTerm and Orca.

- [ ] **Step 6: Run**

  Run: `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts`
  Expected: PASS.
  Run: `cd cli && npm run test:core`
  Expected: 100% per file, `services/devices.ts` among them.

- [ ] **Step 7: Commit**: `devices: a tap on an agent in the person's own tmux goes through the tmux adapter`

### Task 14: The devices start Harness Desktop (F2's devices side)

**Depends on:** Task 9 (the cable side's wiring, kept). **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts` (`HARNESS_BUNDLE`, `BUNDLE_APPS`' comment)
- Modify: `cli/src/cable/hosts/open.ts` (`createOpenActions`' answer), test `cli/src/cable/hosts/open.spec.ts`
- Modify: `cli/src/services/devices.ts` (the cable host's wiring), test `cli/src/services/devices.spec.ts`
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (one expectation)

**The test that fails before the change:** `cli/src/services/devices.spec.ts`, "on macOS a Harness agent with no
window lists f, and its tap starts Harness Desktop".

**Interfaces:**
- Consumes: `CableHostWiring.launchDesktop`, `desktopTimedOut`, `HARNESS_OPEN_WAIT_MS` (kept, `70336f946c`).
- Produces: `export const HARNESS_BUNDLE = 'ai.autonomous.harness'` (`hostDetect.ts`);
  `createOpenActions(deps).desktop?: () => Promise<boolean>`, there on macOS only.

**If `main` moved** (#4340 changes `cableHost.ts`, `devices.ts` and `devices.spec.ts`): `CableHostWiring` still has
`launchDesktop?` and `desktopTimedOut?`, and `cableHost.spec.ts`'s `describe('a tap on a Harness agent with no
window')` passes on the merged head; in `devices.ts` the object given to `new DaemonCableHost(` still holds
`appPicked` and `appTimer: timerIn('dial')`; in `devices.spec.ts` "no window" is still `port.swarms(null)`; a
Harness agent's row with a window open gains no `f`.

- [ ] **Step 1: The red tests**, the ones `746b4ba2b6` wrote, on #4341's files:
  - `open.spec.ts`: "Harness Desktop comes forward by its bundle id, on macOS only"
    (`git show 746b4ba2b6 -- cli/src/cable/hosts/open.spec.ts`): `recorder({}, [0, 1])`, `opener.desktop!()` true
    then false, both calls `forward('ai.autonomous.harness')`; on Linux `opener.desktop` is undefined.
  - `devices.spec.ts`: `harnessAgent()` moves up to the file's helpers, and the three cases as at `a1271e88fb`
    (`git show a1271e88fb:cli/src/services/devices.spec.ts`): "on macOS a Harness agent with no window lists f, and
    its tap starts Harness Desktop", "Harness Desktop that is not installed answers the dial", "off macOS a Harness
    agent lists no f, and a tap starts nothing", with their `caps` helper.

  Run: `cd cli && npx vitest run src/cable/hosts/open.spec.ts src/services/devices.spec.ts -t 'Harness Desktop|lists no f'`
  Expected: FAIL (`desktop` is undefined; `sva`).

- [ ] **Step 2: Commit the red tests**: `test(devices): on macOS a tap on a Harness agent with no window starts Harness Desktop (red)`

- [ ] **Step 3: Implement**
  - `hostDetect.ts`: the hunk of `3166f17cad` as it is
    (`git show 3166f17cad -- cli/src/cable/hosts/hostDetect.ts`).
  - `open.ts`: `desktop: mac ? () => forward(HARNESS_BUNDLE) : undefined` in what `createOpenActions` returns, and in
    its return type with its comment (brings Harness Desktop forward, starting it when it is not running; there on
    macOS only). `HARNESS_BUNDLE` does not join `BUNDLES`: no hint's bundle id ever opens Harness.
  - `devices.ts`, the `DaemonCableHost` wiring: `launchDesktop: opener.desktop` and
    `desktopTimedOut: () => log('[device] open · harness · no window')`, with their two comments from `3166f17cad`.
  - `deviceWithoutApp.e2e.ts`: the hunk of `3166f17cad` as it is: the Harness row's caps are
    `process.platform === 'darwin' ? 'svfa' : 'sva'`, and no test taps it.

- [ ] **Step 4: Run**

  Run: `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts && npm run test:core`
  Expected: PASS; 100% per file.
  Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts -t 'with no window the dial lists'`
  Expected: 1 passed.

- [ ] **Step 5: Commit**: `devices: on macOS a tap on a Harness agent with no window starts Harness Desktop`

### Task 15: End to end: the carried commit, on the adapters

**Depends on:** Task 13 (the tap). **Effort:** high.

**Files:**
- Create, by the cherry-pick: `cli/e2e/harness/ownTmux.ts`
- Modify, by the cherry-pick: `cli/e2e/deviceWithoutApp.e2e.ts`

**The test that fails before the change:** none: no behavior. `63467b24a8` is carried unchanged; each case is seen
to fail once against the ported code (step 3).

**If `main` moved:** the names the commit uses are still in `deviceWithoutApp.e2e.ts` and its harness: `fresh`,
`showing`, `heard`, `until`, `create`, `row`, `ids`, `outside` and the `afterEach`, `LocalClient`,
`IsolatedDaemon`'s `tmux.run`, `hookLog()` and `log()`.

- [ ] **Step 1: `git cherry-pick 63467b24a8`.** Expected: no conflict (checked on the kept commits; Task 14's line
  in the same file is a hundred lines away). Its message and author stay. On a conflict: `git cherry-pick --abort`
  and report.

- [ ] **Step 2: Run**

  Run: `cd cli && caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts`
  Expected: every case passed, the two tmux cases among them, none skipped. No window or app on this Mac moves.

- [ ] **Step 3: See each fail once**, with a local change that is never committed, and report what each run said:
  - `notify.mjs` `ownPane` returning `false`: the first case fails waiting for "the agent listed".
  - `tmux.ts` `focus` answering `false` before its first command: the second case fails waiting for "the person's
    client on the agent's pane".
  - `tmux.ts` taking every client for the person's: the second case fails the same wait, since the client moved is
    the one on the Harness agent's session. Say where that client was (`terminal.where()`).

  Then `git checkout -- cli/hook/notify.mjs cli/src/cable/hosts/tmux.ts` and run step 2 again.

- [ ] **Step 4: Report** the commit's new SHA and the three failures seen.

### Task 16: The VS Code adapter (F3)

**Depends on:** Task 13 (the place it adds to, and both lists). Tasks 11 and 14 for its place in the history only:
F3's two commits are the last on `observed.spec.ts`, `devices.ts` and `devices.spec.ts`, so they come out with no
conflict (Q2). **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/hosts/vscode.ts`, test `cli/src/cable/hosts/vscode.spec.ts`
- Modify: `cli/src/cable/hosts/adapter.ts` (`Place.sessionId`)
- Modify: `cli/src/cable/hosts/observed.ts` (`locate`, one member), test `cli/src/cable/hosts/observed.spec.ts`
- Modify: `cli/src/services/devices.ts` (the list, one import), test `cli/src/services/devices.spec.ts`
- Modify: `cli/hook/notify.mjs` (`HOST_HINTS`), test `cli/src/hookNotify.spec.ts`

**The test that fails before the change:** `cli/src/cable/hosts/vscode.spec.ts`, "the VS Code extension's tab: its
session's link, then VS Code comes forward".

**Interfaces:**
- Consumes: Task 13's place and lists; `HOST_HINTS` and `MAX_HINTS` (kept).
- Produces: nothing another task uses. **Only these two commits hold F3**: no other change rides in them.

```ts
// adapter.ts
export interface Place { /* … */ sessionId?: string }   // the engine's own id of the session: the VS Code extension's link names it
// vscode.ts
export function createVscodeAdapter(deps: Pick<OrcaDeps, 'run' | 'platform'>): HostAdapter
// id 'vscode', tap 'before', canFocus on macOS only, no show, no type. Its pane: { adapter: 'vscode', id: <session uuid> }.
```

**If `main` moved:** Task 13's list for `devices.ts` and `observed.ts`; `HOST_HINTS` in `notify.mjs` still has
`TMUX_PANE` after `ZELLIJ` and `MAX_HINTS` is 10; `APP_BUNDLES.vscode` is still `com.microsoft.VSCode`; `OPEN` is
still exported by `open.ts` (the Claude app's adapter imports it).

- [ ] **Step 1: The red tests**

  `vscode.spec.ts`: the branch's `describe('a tap on a session in the VS Code extension's tab…')`, moved
  (`git show a1271e88fb:cli/src/cable/hosts/open.spec.ts`, lines 399 to 444, with `UUID` from line 40). What changes:
  a local `recorder(over, codes)` builds `createVscodeAdapter(deps)` and an opener that holds it alone, as
  `tmux.spec.ts` does; `target(hints, sessionId = UUID)` builds the place with `sessionId`; the pane reads
  `{ adapter: 'vscode', id: UUID }`. Every command, line and case is unchanged, Cursor's among them. New, as
  `claudeApp.spec.ts` has them:

```ts
it('its id is vscode, it taps before its app, and only macOS can focus', () => { /* id, tap, type, show; canFocus by platform */ })

it('a pane id not in its form runs nothing', async () => {
  const { calls, adapter } = recorder()
  for (const id of ['sess-1', UUID.toUpperCase(), `${UUID}&x=y`, `${UUID}/..`, `local_${UUID}`, '', '--args']) {
    expect(await adapter.focus({ adapter: 'vscode', id }), id).toBe(false)
  }
  expect(calls).toEqual([])
})
```

  `observed.spec.ts`: `fakeActions`' list gains `createVscodeAdapter(deps)` after the Claude app's; "an app the
  source never heard of…" expects `sessionId: 's1'` in the place; from `910c17679e`, "a session in the VS Code
  extension's tab opens by its own session id" expects
  `{ bundle: 'com.microsoft.VSCode', pane: { adapter: 'vscode', id: sessionId } }`.

  `devices.spec.ts`, beside the Claude app's case:

```ts
it('a session in the VS Code extension\'s tab opens by its link, then VS Code comes forward', async () => {
  const SESSION = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const { port } = startHere({ orca: mac })
  port.observed(hook('session-start', { sessionId: SESSION, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
  attach(port)
  expect(await host().openAgent(observedAgentId('claude', SESSION))).toBeUndefined()
  expect(orcaRuns).toEqual([
    ['/usr/bin/open', [`vscode://anthropic.claude-code/open?session=${SESSION}`], 10_000],
    ['/usr/bin/open', ['-b', 'com.microsoft.VSCode'], 10_000],
  ])
})
```

  `hookNotify.spec.ts`: `HINTS` gains `'CLAUDE_CODE_ENTRYPOINT'`, last, and "says how Claude Code was started, beside
  the app it runs in", as `910c17679e` wrote it (`git show 910c17679e -- cli/src/hookNotify.spec.ts`).

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts src/hookNotify.spec.ts -t 'VS Code|vscode|how Claude Code was started|in this order|without all three|never heard of|pane id'`
  Expected: FAIL: no `./vscode.js`, no link, the hint is not sent.

- [ ] **Step 3: Commit the red tests**: `test(devices): a tap opens the VS Code extension's tab on its session (red)`

- [ ] **Step 4: Implement**
  - `notify.mjs`: `'CLAUDE_CODE_ENTRYPOINT'` last in `HOST_HINTS`, with its comment, as `f284be53c7` has it
    (`git show f284be53c7 -- cli/hook/notify.mjs`).
  - `adapter.ts`: `Place.sessionId`.
  - `vscode.ts`: `paneOf` gives the pane only with all three: `hints.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode'`,
    `hints.__CFBundleIdentifier === APP_BUNDLES.vscode` (never Cursor's, never an app known by `TERM_PROGRAM` alone),
    and `place.sessionId` passing `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`. `focus` checks
    the id again and runs `OPEN` with `vscode://anthropic.claude-code/open?session=<id>` under `RUN_TIMEOUT_MS`. The
    header says the link was read in the extension's code and may change with any release, so VS Code still comes
    forward after it.
  - `observed.ts` `locate`: the place gains `sessionId: entry.agent.sessionId`.
  - `devices.ts`: `createVscodeAdapter(apps)` after the Claude app's entry.

- [ ] **Step 5: Run** `cd cli && npm run typecheck && npx vitest run src/hookNotify.spec.ts src/cable src/services/devices.spec.ts && npm run test:core`.
  Expected: PASS; 100% per file.

- [ ] **Step 6: Commit**: `devices: a tap opens the VS Code extension's tab on its session`

- [ ] **Step 7: Prove it comes out.** On a throwaway branch at the task's head:
  `git revert --no-edit <code commit> <red commit>`, then
  `cd cli && npm run typecheck && npx vitest run src/hookNotify.spec.ts src/cable src/services/devices.spec.ts`.
  Expected: no conflict, PASS. Delete the branch. Report both SHAs: they are what comes out if the spec's check 3
  fails.

---

## Left out

- A rest of the dial on a tmux agent switches nothing: the spec gives the tap alone. The tmux adapter has no `show`.
- A multiplexer agent's tty is still read where its app is a tab app, and `byTab` still knows it: no tab report can
  carry a multiplexer pane's tty, so nothing follows from it.
- A per-pane "can type" on the adapter, which would keep a tap's `orca terminal switch` for Zellij and Rex inside
  Orca (open question 1).
- The spec's F1 "The tap" and F3 "Design" still name `open.ts`'s `paneOf` and `openTarget`. Its Decided section's
  first bullet overrides them; the wording is the PM's to align.
- Selecting the terminal tab that holds the tmux client, typing into a person's tmux pane (`send-keys`), VS Code's
  integrated terminal, Cursor's tab, F2 off macOS, the face tap that opens: the spec's "Out of scope".
- The open scan does not learn the app `tmux` from a parent named `tmux`.
- `cli/AGENTS.md`'s row for the devices process is not edited: the spec names `services/AGENTS.md` only.
- A rule per client instead of per session: Harness marking its own tmux clients. It would change
  `lib/tmuxStream.ts`, which the core runs.
- No end-to-end test for F2: it would start the developer's own Harness Desktop. Its proof is the unit specs and the
  spec's check 5.

## Verification

On the final head, after Tasks 9 to 16. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every
end-to-end file boots its own daemon under a throwaway root, with a private tmux server, fake engines and a fake dial
on a pseudo-terminal, signed out. Never Diego's daemon (port 18473), his tmux server, his dial or his apps; nothing
here reaches production. Checks 1 to 5 need nobody but a reviewer or a tester; check 6 is Diego's.

1. **The port review, find-only, against #4341.** One `diegodev-reviewer` reads the combined change
   (`git diff 5fa7b95762...HEAD`, or from the `main` last integrated) against #4341's spec
   (`docs/specs/2026-11-15-device-host-adapter.md`), `adapter.ts`'s four rules and `services/AGENTS.md`'s adapter
   sentence. It fixes nothing: findings go to the main session. What it looks for:
   - a rule about an app left in `observed.ts` or `open.ts` (Desktop's launch is the PM's exception);
   - an adapter that breaks one of the four rules (`this`, a throw, a value not checked again at the verb, a
     `paneOf` that reads another app's values);
   - a test of #4341 changed in what it expects, beyond these: the herdr row of "…still takes the dial's words and a
     rest through Orca", "herdr inside Ghostty… still writes its tab select", `tabs.spec.ts`'s `place` helper, the
     place in "an app the source never heard of…" (`pid`, `sessionId`), and each fake `run`'s `stdout: ''`;
   - a command line, timeout, log line or refusal sentence of #4341 that is not byte for byte as it was;
   - the tap order herdr, tmux, WezTerm, Orca in `devices.ts`, and the same order in `fakeActions`;
   - anything of the dropped commits still there: `openTarget`, a `Pane` with `app`, `claudeShow` in `open.ts`,
     `MULTIPLEXERS` in `observed.ts`.

Local, on this Mac (macOS arm64, Node 22, tmux), in `cli/`, one command at a time:

2. **The specs, the typecheck and the gates PR CI does not run.**

   ```bash
   npm run typecheck
   npx vitest run src/hookNotify.spec.ts src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts
   cd .. && python3 devices/harness-device/firmware/test/test_touch_ui.py
   python3 scripts/local-checks.py --run     # from a clean tree: npm run test:core, with its receipt
   ```

   To see: no type error; every spec passed; the firmware's host table equal to the daemon's names; `test:core` at
   100% per file with `services/devices.ts` in it; the core's file list unchanged, and
   `git diff origin/main --stat -- cli/src/core` naming `observedHook.ts` alone, one line. The receipt goes into the
   pull request's body before the push.

3. **The end-to-end file, and the two whose path this work changes, on this Mac.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts \
     e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/hookclient.e2e.ts
   ```

   To see: three files passed, none skipped. In `deviceWithoutApp`: the two tmux cases (in the second, the person's
   client is on the agent's pane and the client on the Harness agent's session has not moved), and the Harness row
   with `svfa`. In `dialAppFilter`: "Other" still holds the unknown terminal. In `hookclient`: an engine in a tmux
   session opened by hand is still no agent, daemon down or up. No window or app on this Mac moves during the run.
   About a quarter of an hour.

4. **F3 comes out cleanly** (Q2). On a throwaway branch at the final head: `git revert --no-edit` of Task 16's two
   commits, then check 2's first two commands. To see: no conflict, all passed. Delete the branch.

On GitHub, by hand, once, after the branch is pushed. **The PM schedules this run**: it is a heavy workflow, and
never beside another (`docs/validation-and-release.md`).

5. **The whole CLI suite**: the hook changes for every engine in every pane, the Orca and tabs adapters change for
   every agent outside Harness, and Linux is one of F1's platforms.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/device-wave1-checks
   ```

   To see: `e2e (1)` to `e2e (8)`, the macOS full-disk job and `e2e-summary` green, with these among the verified
   files: `deviceWithoutApp`, `dialAppFilter`, `hookclient`, and #4341's own guard, `deviceClaudeOrca`,
   `dialPaneFollow`, `dialClaudeAppFollow`, `dialTerminalFollow`. A red test is reported with its link and whether
   main's last nightly run has it too. Report the run's link.

With Diego, in one session after the pull request is up (PM, 2026-11-15). **Not a tester's.** On his Mac and dial:
the CLI from this branch (`make install-cli`; `harness --version` names the branch's build, since a dev daemon does
not update itself), Harness Desktop installed, the harness-device plugin on, the dial's firmware as it is.

6. **The five checks of the spec**, in its order:
   1. Claude Code in a VS Code extension tab: it is on VS Code's page (not Other, not Ghostty); words said at the
      dial start a turn in that tab; a notice tap shows that tab.
   2. Claude Code in VS Code's terminal: the same three, where the tap only brings VS Code forward; and with VS Code
      started by `code .` from Ghostty, which page it is on.
   3. Two VS Code windows, the session's tab in the other one: the tap shows the tab that is there, and opens no
      second tab. **This one decides F3:** the pull request keeps `hold` until it passes, and if it fails Task 16's
      two commits are reverted before the merge.
   4. Ghostty with tmux, Claude Code in a pane, Desktop quit: it is listed; its voice works; a notice tap shows its
      pane and Ghostty. With a second terminal attached to another session of the person's, the tap moves the one
      used last.
   5. A Harness agent's notice tap with Desktop quit: Desktop starts and opens that agent.
      Then, with that agent's terminal just opened in Desktop and nothing typed in Ghostty since (Desktop's is now
      the tmux client used last), tap the tmux agent's notice of check 4 again: Ghostty's tmux shows the agent's
      pane, and Desktop's terminal still shows its own agent.

   Each is written into the pull request as seen, or as not seen.

**Temporary workflow:** none. The long check has a workflow already (`.github/workflows/cli-e2e.yml`, by hand from a
branch and every night), and the new cases are in a file it already runs, so they keep running without a new check.

**For the pull request's body:**
- Platforms: macOS all three; Linux F1; Windows none.
- The red and the green commit of each task, kept and new.
- **The two tests of #4341 that flip, and why** (the spec asks for it): herdr inherits the Orca terminal handle and
  the tty of the terminal it started in, so words typed through Orca land in whichever herdr pane is focused. And
  what else of #4341 changed: `focus` may answer `'refused'`, `Place` gains `pid` and `sessionId`, the runner
  answers stdout, `tabs.spec.ts`'s helper.
- **Numbers: the cost of the new tmux calls for a `Notification` in a Harness pane**, copied from `8b53000b20`'s
  message: `tmux -V` and `display-message`, the median of twenty each, the tmux version and the machine; before, no
  tmux call.
- The core: one comment line in `core/observedHook.ts`, no code (PM, 2026-11-15).
- The receipt of check 2; the link of check 5; `hold` until the spec's check 3.
- After the merge, the local branch `wave1-checks-before-port` is deleted.
