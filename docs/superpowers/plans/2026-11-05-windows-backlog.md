# Windows Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task, in this session. The owner has said not to use subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything still open on Windows, measured against what the Mac does on `main` today, is fixed, or is named with the reason it stays open.

**Architecture:** Two kinds of task. A **walk** runs a Mac flow on the real PC and turns each failure into a root-cause fix with a test that failed first. A **gap** is a difference already read in the code, fixed the same way. Windows-only branches stay behind the platform checks that exist; Mac and Linux behavior does not change unless a task says so.

**Tech Stack:** TypeScript CLI (vitest), Flutter Desktop, Rust `pty/` and `tui/`, PowerShell on the PC.

**Spec:** `docs/superpowers/specs/2026-11-04-windows-parity-design.md`, and the audit below, which replaces its "Where Windows stands today".

## Audit against `main` at d99e24ca6 (2026-11-05)

Mac-only checks read and found **correct, no work**: menu-bar notices (Windows keeps the sidebar row and has toasts), keychain usage read, Spotlight marker, folder read by descriptor (Windows reads by path), responsibility probe, Mac fonts. Services run in the core's process on Windows, by design.

| # | Open item | Evidence | Task |
|---|---|---|---|
| 1 | CLI 0.5.40 with production's terminal host 0.4.31 never run; `hn` in a real console never run | manifests; last session's PC ran 9.9.9 | 1 |
| 2 | Not walked on Windows: Git project and worktree, commit and push through the GitHub App, Import, Share, plain terminal, rename, `harness remote`, `team model`, device flows | PR #3032 | 2 |
| 3 | Agents stuck at their engine's own hidden screen | #3063 handles Codex's trust screen; "Hooks need review" is not in it | 3 |
| 4 | Cursor, Devin, Grok, Antigravity have no hooks on Windows; Hermes's are unconfirmed | `win32Runner` absent; `hooksNotOnWindows` | 4 |
| 5 | Seven PowerShell installers never run end to end; `programs` paths read, not measured | `ENGINE_WINDOWS_INSTALL` | 4 |
| 6 | Windows panes lack the grid `PATH` and `GRID_NO_UPDATE_CHECK`, and Harness's Node at the end of `PATH` | `gridPanePrelude` runs in the POSIX script only; `engineStart.ts` "Not done" | 5 |
| 7 | Pane blank for 15-50 s during an engine's first start | Copilot and Kilo on the PC | 6 |
| 8 | Stopping panes dropped tabs from 5 to 3; New Harness defaulted to another machine | seen on the PC, not investigated | 6 |
| 9 | Desktop release fails on one connection reset | `scripts/verify-desktop-release.py`, 1.3.65 | 7 |
| 10 | `feat/windows-app-menu` and `-dropdowns` unmerged (7 commits), overlapping #2947 | `git rev-list`; the owner's dirty checkout holds related files | 8 |
| 11 | New Swarm hidden from Search commands | memory, 10-29; `keymap_commands.dart:773` suggests fixed | 8 |
| 12 | Arm not rerun since the serial spec fix | PR #3032 | 9 |
| 13 | Native `hn` gate failures never compared with `main` | PR #3032 | 9 |
| 14 | `hn` shell integration is Unix only | `shell_picker.rs` | 10 |
| 15 | Add machine to a Team is heavy | owner, unanswered | 11 |
| 16 | Guests on Windows are design only | guests spec | 12 |
| 17 | Teammate routing to `<host> · Team` needs a second person | memory | named as open |

## Global Constraints

- Root cause, no stopgaps; every bug fix has a test that failed first.
- Windows checks run on the signed build on DESKTOP-0TFH0OJ, in the Personal Swarm only. Send nothing into shared Swarms.
- Ask before every commit and push. Edit code with the Edit tool. Run long suites once, saved to a file.
- Never print secrets. The PC's `.codex\config.toml` holds a plain key: read its keys by name, never the file.
- Do not run a vendor's installer from a script of ours: only through the product. Never approve another program's hooks on the person's behalf.
- Do not touch the owner's dirty main checkout. Copy follows `docs/naming-system.md`.
- Mac and Linux keep their tests green; a change to shared code says so in its PR.

## Review Focus

1. A profile folder with a space in its name: every hook line and installer path must still work.
2. A computer with another program's hooks already in the engine's file (Orca's blocks moved Harness's to index 1).
3. A daemon restart mid-install or mid-start: nothing left running as nobody's, nothing installed twice at once.
4. A person who is watching the pane answers the screen first: an automatic answer must not type into whatever comes next.
5. An older daemon with a newer Desktop, and CLI 0.5.40 with host 0.4.31: refuse in words, never hang.

---

### Task 1: The production combination

**Files:** whatever the walk finds; likely `cli/src/tui/index.ts`, `cli/src/lib/windows/`.

- [ ] **Step 1:** On the PC, run CLI 0.5.40 with host 0.4.31 (download it from the production manifest, check its sha256). Create a pane, stop it, reopen it, run `hn`.
  Expected: panes work; `hn` says `TUI_NOT_IN_PAYLOAD`, no crash.
- [ ] **Step 2:** Point `current-pty` at the staged 0.5.40, check signatures, run `hn` in a real console: list, attach, type, detach, a pane's exit.
  Expected: Authenticode valid under Smart App Control; each step works.
- [ ] **Step 3:** Fix each failure at its cause, test first. Commit.

### Task 2: Walk the Mac flows on Windows

**Files:** whatever the walk finds.

Each row is a Mac flow run as a person would, on the signed build:

- [ ] **Step 1: Git project.** Open a real repository in New Harness, with and without a worktree. Expected: branch shown, worktree created under `harnesses\worktrees`, deleted with the harness.
- [ ] **Step 2: Swarm with the GitHub App.** In a throwaway repository the owner names, a Personal Swarm task commits, pushes and opens a pull request, which appears in Pull requests. Expected: authored as the App or the owner as on a Mac; `gh` missing gives its banner.
- [ ] **Step 3: The rest.** Import an agent; Share a harness and open the link; plain terminal; rename a harness and see its Swarm agent renamed (#2912); `harness remote`; `team model`; Threads, Mentions and Decisions in the sidebar (#3057); themes when #3059 lands.
- [ ] **Step 4: Devices.** Add device with no device attached says so in words; with hardware only if the owner plugs it in, else named as unverified.
- [ ] **Step 5:** Fix each failure at its cause, test first. Commit per fix.

### Task 3: A hidden engine screen does not end a Swarm start

Blocked on #3063 merging; build on its `startScreen.ts` and `openRestrictedKeys` pattern, not beside them.

**Files:**
- Modify: `cli/src/engines/codex/screen.ts`, `cli/src/superTabs/startScreen.ts`
- Test: `cli/src/engines/codex/hooksReview.spec.ts`; fixture `cli/src/superTabs/fixtures/screens/codex-0163-hooks-review.txt`, captured from the PC

**Interfaces:**
- Produces: `hooksReviewSkipKeys(capture: string): string[] | null`

- [ ] **Step 1: Failing test.** The exact screen gives the keys for "Continue without trusting"; a capture with any line changed, a selection on another row, or text typed in it gives `null`; "Trust all" is never returned.
- [ ] **Step 2:** Run it, watch it fail.
- [ ] **Step 3:** Implement. Only for a Swarm start's own pane, before it has a session, never a pane a person opened. Read the screen again before sending.
- [ ] **Step 4:** Any other screen still blocking at the start's deadline fails it at once with the screen's first line, through #3063's path, so the Lead tells the person what it asks.
- [ ] **Step 5:** On the PC, with Orca's hooks present, a Lead starts a Codex engineer. Expected: it joins in seconds; `harness show` proves Harness's hooks fired; Orca's did not run; `config.toml` gained no trust for Orca.
- [ ] **Step 6:** Commit.

### Task 4: Every engine installs and reports on Windows

**Files:**
- Modify: `cli/src/lib/engineInstall.ts` (`programs`), `cli/src/engines/{cursor,devin,grok,agy}/contract.ts` (`win32Runner`), `cli/src/engines/kit/windowsHooks.spec.ts`

- [ ] **Step 1:** Through the app, one at a time, install Cursor, Amp, Grok, Devin, Muse, Antigravity, Oh My Pi. For each record: installer log, where the program landed, whether the pane opened. Fix `programs` from what is measured.
- [ ] **Step 2:** For each hooked engine, read how it runs a hook on Windows from its own source or docs; measure one on the PC. Record it beside its `win32Runner`, as the existing rows do. An engine whose runner cannot be proven keeps `hooksNotOnWindows`, named in the PR.
- [ ] **Step 3: Failing tests.** In `windowsHooks.spec.ts`, each new engine's line is quoted for its runner, with a space in the profile path; replace the "no runner" assertion on lines 26-30 of the block with the new values.
- [ ] **Step 4:** Implement, run, then on the PC confirm a session binds and turns close for each engine that can sign in; Hermes past its first-run question. One that needs a paid login is named as unverified.
- [ ] **Step 5:** Commit.

### Task 5: Windows panes get what the launch script gives a Mac pane

**Files:**
- Modify: `cli/src/lib/windows/engineStart.ts`, `cli/src/lib/engineLaunch.ts`
- Test: `cli/src/lib/windows/engineStart.spec.ts`

**Interfaces:**
- Produces: `windowsPaneEnvironment(gridBinary: string | null, nodeDir: string, path: string): Record<string, string>`

- [ ] **Step 1: Failing tests.** With a grid binary: its folder first on `PATH`, `GRID_NO_UPDATE_CHECK=1`. Harness's Node folder last on `PATH`. One `PATH` key whatever its case. No grid binary: only the Node folder.
- [ ] **Step 2:** Run, watch fail. Implement. Use `path.win32`.
- [ ] **Step 3:** On the PC, a grid-model harness runs `grid --version` from its pane, and its `grid update` is not offered. Commit.

### Task 6: First start and stop on Windows read as they do on a Mac

**Files:** `cli/src/core/agents/heldLaunches.ts`, `desktop/lib/state/` as the cause shows.

- [ ] **Step 1:** Measure on the PC and read on the Mac what shows between pressing New Harness and the engine's first paint, for an engine already installed and for one installing.
- [ ] **Step 2:** Failing test, then show the held line ("Installing Copilot…", "Starting Copilot…") until the engine draws. Same words as the Mac's.
- [ ] **Step 3:** Reproduce 5 tabs dropping to 3 after stopping panes. Find the cause in the desktop's tab sync; compare with the Mac before calling it a bug. Fix with a failing test if it is one.
- [ ] **Step 4:** New Harness's default machine: read the rule on the Mac and match it; a Windows app with this computer available opens on it only if the Mac does. Commit.

### Task 7: One connection reset does not fail a Desktop release

**Files:** Modify `scripts/verify-desktop-release.py`; test beside its existing tests.

- [ ] **Step 1: Failing test.** A download reset twice then served passes; served with a wrong sha256 fails at once with no retry; reset on every try fails naming the file.
- [ ] **Step 2:** Implement three tries with backoff, for connection errors and 5xx only. Run. Commit.

### Task 8: The Windows menu branch and Search commands

- [ ] **Step 1:** Compare `origin/feat/windows-app-menu-dropdowns` with `main`, commit by commit. List what #2947 already carries and what is left.
- [ ] **Step 2:** Move only what is left to this branch, keeping its author. Triage against `desktop/test/windows_app_menu_test.dart` on `main`. Ask the owner before dropping anything of theirs.
- [ ] **Step 3:** Confirm New Swarm in Search commands on the PC. If absent, failing test in the keymap tests, then fix. Commit.

### Task 9: Runs nobody has compared

- [ ] **Step 1:** Read the Windows workflow's latest run on `main` for the Arm job. If it has not run since the serial fix, start it once, by hand.
- [ ] **Step 2:** Build `hn` from `main` before #3032 and from `main` now; run `scripts/validate-tui-native.py` once on each, sequentially, output saved to files. Only fixtures failing now and passing before are this work's: fix those. Update the memory note on the rest.

### Task 10: `hn` shell integration in PowerShell (lowest priority, owner's words)

**Files:** `tui/src/shell_picker.rs`, `tui/src/shell_context.rs`, new `tui/src/shell_powershell.rs`

- [ ] **Step 1:** Spike: a PowerShell profile fragment that carries the cwd and command marks to `hn` over the owner-only pipe in `tui/src/sock.rs`, in place of FIFOs. Write what it can and cannot do in the plan's ledger before more code.
- [ ] **Step 2:** Failing tests for the fragment's text and for the marks parsed; implement; run on the PC. Commit, or name it as dropped with the reason.

### Task 11: Adding a machine to a Team (design first)

- [ ] **Step 1:** Draw the current steps and a one-click flow with one status per machine, as a local HTML file in `~/Downloads`. The owner chooses before any code.
- [ ] **Step 2:** Plan the chosen flow as its own document.

### Task 12: Guests on Windows (security review first)

- [ ] **Step 1:** Spike on a signed build per `docs/superpowers/specs/2026-11-04-windows-guests-design.md`, on a disposable local account, removed afterwards.
- [ ] **Step 2:** The owner names a security reviewer. No product code before that review.
