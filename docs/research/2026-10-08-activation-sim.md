# Activation: simulated new users on a fresh Mac (2026-10-08)

Goal: a brand-new user reaches a **first successful session** (an agent finishes a real piece of
work) as fast as possible, keeps working, and comes back for a **second session** that picks up
where they left off. Every run below is a fresh macOS VM driven like a new user would drive it:
download from the website, drag to Applications, open, type a task.

## Why

New-user D1 dropped from 64% (16/25, 2026-09-28/29 cohorts) to 28% (17/60, 09-30 → 10-06),
Fisher p ≈ 0.003, while retention after D1 stays flat. Users who ran a turn on day 0 came back on
day 1. The gate is the first turn.

## Rig

- VM: Tart (built from source, guest-agent removed; the Homebrew tap is broken on this brew),
  `ghcr.io/cirruslabs/macos-tahoe-vanilla` (macOS 26.6.2, user `admin`, SSH + auto-login). A bare
  Mac: no Homebrew, no Node, no Xcode Command Line Tools (`/usr/bin/git` is the install shim), no
  Claude Code, no Codex.
- Driven over VNC (`vncdo`) with screenshots after every step, and SSH for read-only checks.
- Each run starts from a fresh APFS clone of the image.
- Network: Vietnam (Cloudflare DAD/HKG). GitHub's release CDN was unreachable from here for about
  an hour this morning, then came back.

## Personas

| Id | Has | Signed in to the engine |
|----|-----|------------------------|
| A | nothing (no Claude Code, no Codex) | — |
| B | Claude Code | yes / no |
| C | Codex | yes / no |
| D | Claude Code and Codex | yes / no |

"Signed in" engines are simulated with Harness's fake engines (`cli/e2e/harness/fakeEngine.mjs`),
since a real account cannot be signed in overnight. "Installed, not signed in" uses the real
vendor binaries, so their real login screens appear.

## Activation score (per run, 0–100)

| Part | Points | How |
|------|--------|-----|
| First result | 40 | The agent finished the first task in the first session. 0 if not. |
| Time to first result | 20 | From first app open to the first result, counting only machine time and required user steps. 20 at ≤ 90 s, falling linearly to 0 at 10 min. |
| Friction before the first result | 20 | −15 per blocker (an error or dead end the user must work out), −5 per needless decision or prompt. |
| Second session | 20 | 10 if reopening shows the previous work and a new task starts in one step; 10 minus 5 per unexpected prompt or error on reopen. |

## Runs

| Run | Build | Persona | First result | Time | Friction | 2nd session | Score |
|-----|-------|---------|-------------|------|----------|-------------|-------|
| A1 | desktop 1.2.59, CLI release | A | yes (OpenCode free model) | ~80 s machine + forced picker | blocker: "OpenCode is unavailable. Choose an agent." | restored; Local Network prompt | **~69** |
| A2 | branch (fa64b0e15), CLI release | A | yes | box ready ≤ 45 s, result 39 s after Enter (~85 s) | none | restored, no prompt; "Untitled Pane" (fixed in f8ca37071) | **~92** |
| A3 | branch (916f244d7 + Git fixes), branch CLI | A | yes | box ≤ 45 s on first open; OpenCode installed in the background 8.6 s after the daemon; result 29 s after Enter, 54 s after opening (incl. ~20 s typing) | none | restored, no prompt; second harness in the same project ran in 14 s after the Git fixes | **~97** |
| B2 | branch, CLI 9.0.2 preinstalled | B, signed in (fake) | yes | box opens on Claude Code; first message answered at once (fake) | none | second harness "Untitled Pane" (fixed e71fb2644) | — |
| B3 | branch, CLI 9.0.2 preinstalled | B, not signed in, Anthropic blocked | no (network) | — | error now stays in the pane; recovery via the header's Change agent | — | — |
| D1 | branch, CLI 9.0.2 preinstalled | D, both signed in (fake), Codex last | yes | box opens on Codex; answered within 12 s of Enter | none | — | — |
| A5 | branch-2 (setup-time task, f8112ccd0), CLI release | A | yes | task typed and sent during setup at 21 s; first file at 70 s after opening, no further action (released CLI: grid still downloaded, OpenCode installed in the pane) | none | — | — |
| A6 | branch-2 (af410791d), CLI release | A | yes | task sent during setup at 14 s; first file at 72 s; the person was in Finder meanwhile | none | back in Harness: "An agent finished while you were away. Get a notification next time? Turn on" | — |
| C1 | branch-2, CLI release | C, Codex from npm, not signed in | no | — | blocker: "could not verify Codex startup options" (first `codex --help` past the 5 s check) | — | — |
| C2 | branch-2 + CLI 9.0.3 (e1aa14ed7) | C, same | sign-in screen | box keeps OpenCode, picker says Codex Needs sign-in; picking Codex opens its own sign-in screen with the task held | none from Harness (sign-in is the person's step) | — | — |
| A7 | everything combined (PR #1047 + follow-up), the app installing CLI 9.0.4 itself | A | yes | task typed and sent during setup at 15 s; first file at 69 s after opening, no other step; background install then added Claude Code (9.9 s), Codex, Pi | none | — | **~97** |
| I1 | #1054 (background install, third-review fixes) + CLI 9.0.5 installed by the app | A | yes | background install started 42 s after open (OpenCode 7.4 s, Claude Code 8.4 s, Codex 11.7 s, Pi 11.5 s); first harness answered 23 s after Enter, nothing installed in its pane; a second launch (CLI present) started no install | none | — | — |
| I2 | #1054 redesign (one Node lock), CLI 9.0.6 installed by the app | A, harness started as the box appeared | yes | the pane said "OpenCode is already installing in the background — waiting for it"; OpenCode was in place 1 s after the pane opened, but the pane waited behind Claude Code, Codex and Pi: first result 46 s after Enter | one lock serialized unrelated agents | — | — |
| I3 | #1054 + waiting fix (8d0093761), CLI 9.0.7 | same | yes | the pane went ahead as soon as OpenCode was in place: first result 14 s after Enter, 62 s after first open | none | — | — |
| B1 | branch, CLI release | B, Claude Code 2.1.294 installed, not signed in | no | — | default still OpenCode; picker shows no install state; Claude Code exited at start ("Unable to connect to Anthropic services", transient network) and its pane vanished: user back on an empty box with a stray "Terminal harness" | — | **~20** |

## Findings

### A1 — bare Mac, official desktop 1.2.59

1. **Blocker: the default agent is "unavailable" on the first New Harness box.** On a bare Mac
   the box opens with OpenCode (the product default) and a red "OpenCode is unavailable. Choose an
   agent." Pressing Enter with a task opens the agent picker instead of starting. Re-picking the
   same OpenCode clears it and the harness starts and installs OpenCode in the pane.
   Cause: `NewHarnessController` treats the product default as a *remembered* agent
   (`_rememberedAgent = !explicitSelection`), and a remembered agent that the engine probe reports
   `installed == false` requires an explicit replacement — even though Harness installs it on
   Create. Same trap before 10-01, when the default was the first engine (Claude Code).
2. The agent picker gives no hint which agents are installed or will install.
3. Setup footer still says "Next: sign in and start a harness."; the setup screen promised a
   sign-in step that does not exist (fixed in 8a932cb1a, the footer still to do).
4. Once started, the first turn worked: OpenCode installed in the pane (~14 s) and the free model
   wrote `index.html` (~8 s). The result says "Open it in a browser to view." with no way to open it.
5. Closing the window quits the app (`applicationShouldTerminateAfterLastWindowClosed`). The daemon
   and the agent keep running.
6. **Reopening asks "Allow Harness to find devices on local networks? … Autonomous robots".** The
   app restarts a daemon it did not launch (09d915773, shipped 09-30 in 1.2.28) and probes the LAN,
   which raises the macOS Local Network prompt for someone with no robot. Don't Allow leaves the
   session working.
7. The DMG window has no "drag to Applications" hint.

### B1 — Claude Code installed, not signed in

8. Default is OpenCode even with Claude Code installed; the picker shows no "installed" marks.
9. **An engine that exits at start leaves no trace.** The daemon (`retainExitedSession`) archives the
   conversation, keeps the shell under a new Terminal identity and sends `agent_deleted`; the desktop
   closes the pane. The error ("Unable to connect to Anthropic services … not available in your
   country") is only in the hidden shell. Next fix, half designed: send `successor: <terminal id>` on
   `agent_deleted` (cli/src/lib/retainExitedSession.ts, compute `releaseEngine` before sending) and
   have the desktop move the panes onto it instead of closing (reuse the agent-switch repoint in
   app_state.dart; the attach must wait for the successor's `agent_synced`).

### A3 — bare Mac, background install, second session

10. **Second session blocked on a Mac without the Command Line Tools.** A new harness in the first
    project (the box's default) failed with "Could not check Git on <Mac>. Check the connection and
    Harness CLI, then retry." `/usr/bin/git` is Apple's installer stub and exits 1, which both the
    desktop's own reader and the daemon's took for "git unavailable". Fixed: a folder with no `.git`
    in it or above it is not a Git project, decided without running git (daemon 4th fix below, desktop
    after it). The misleading "main" branch chip went with it.
11. Background install works: OpenCode 8.6 s, Claude Code 13.3 s, Codex 20.3 s, Pi 11.3 s, one at a
    time, all done about a minute after opening; the first harness never installed in its pane.

### B2 — Claude Code installed and signed in (fake engine; CLI preinstalled)

12. The box now opens on Claude Code (b989c2760); the picker marks Claude Code Installed, Codex
    Needs sign-in (the background install added it), OpenCode Installed, the rest Installs on start
    (69c98f770, 8002fcbd5 — the composer's dropdown is a different widget from the form's list).
13. A second harness in the existing project read "Untitled Pane": only generated projects named
    their agent. A first message now names it wherever it starts (e71fb2644).

### B3 — Claude Code installed, not signed in, Anthropic unreachable

14. The box keeps OpenCode (Claude Code is not signed in) and marks Claude Code Needs sign-in.
15. Picking Claude Code anyway: it exits with "Unable to connect to Anthropic services". The pane now
    stays, with that message and "claude exited (1). This pane is a shell now" (fc88462b5). The
    pane header's agent name opens Change agent; OpenCode there starts in the same folder. The
    first task is not carried to it (Claude Code never took it) — still to do.

### D1 — Claude Code and Codex, both signed in, Codex used last (fake engines)

16. The box opens on Codex; the first task reached it and the pane is named after it.

### A5 — first task typed during setup

17. The setup screen takes the first task ("While this finishes: what would you like to work on?").
    Return queues it ("Starts as soon as this computer is ready.") and the first box starts it once
    the machine has answered the engine probe; typing alone pre-fills the box (f8112ccd0).
18. A run before it (A4) hung on a black window: the VM's `fseventsd` never answered, and the app
    blocks its main thread in a Dart `Directory.watch` at launch (FSEventStreamStart). A fresh clone
    was fine. On a real Mac with a stalled `fseventsd` the same black window would appear; worth
    moving that watch off the first frame.

### A6 — away while the first agent works

19. Returning to Harness after the first agent finished shows the one-time notification offer
    (af410791d). `index.html` in OpenCode's answer is underlined as a link on hover (c4b4df780);
    links open with ⌘-click, which this VNC server cannot send (⌘T arrived as "t"), so the open itself
    is covered by `terminal_link_opener_test.dart` rather than the VM.

### C1/C2 — Codex installed from npm, not signed in

20. The first run of a freshly installed Codex is slow (2.9 s idle, the second 0.05 s); at first
    launch it passed the 5 s `--no-daemon` startup check and the harness failed with "could not
    verify Codex startup options". The check now allows 30 s (e1aa14ed7); C2 opens Codex's own
    sign-in screen (ChatGPT, device code or API key) and holds the task.

## Next

- Finish finding 9 (above), then rerun B1.
- Background agent install (owner asked 2026-10-08): moved out of PR #1047 into its own PR (branch
  `user-activation-install`) after three review rounds found concurrency problems in its cross-process
  install locks; #1047 keeps the pane's own install and the simple OpenCode npm fallback.
- Default to the agent the person already uses (installed and signed in, most recent), else OpenCode.
- Mark installed / installs-on-start in the agent picker.
- Runs C (Codex), D (both), and signed-in variants via `cli/e2e/harness/fakeEngine.mjs`.
- Open a PR for `user-activation`; nothing is pushed yet.

## Fixes

PR #1047 (branch `user-activation`):

| Fix |
|-----|
| The first New Harness box starts the default agent instead of "OpenCode is unavailable". |
| Agents install in the background as the app opens (`harness engines install-missing --background`); panes wait on the same lock. |
| OpenCode falls back to `npm install -g opencode-ai` when its GitHub download does not finish. |
| The box opens on the Claude Code or Codex the person already uses (installed, signed in, most recent). |
| The agent picker says Installed / Needs sign-in / Installs on start. |
| An agent that exits soon after it started keeps its pane and its error (`successor`). |
| Harnesses are named after their first task (composer, existing folders). |
| A folder with no `.git` above it is not a Git project, without running Apple's git stub (desktop and daemon). |
| No Local Network prompt on reopen without a paired robot. |
| Desktop first run no longer downloads grid. |
| Setup copy no longer promises a sign-in. |
| Review of #1047: successor only for a failed start; truer sign-in and last use; handover respects Close/Change; non-installable default still unavailable; symlinked folders; debounced folder check; install lock hardening (in progress). |

Follow-up branch `user-activation-2`:

| Fix |
|-----|
| Type the first task during setup; Return starts it once the computer is ready. |
| Change agent after a failed start carries the first task to the new agent. |
| Web pages and PDFs an agent names open with a click, relative names from its project folder. |
