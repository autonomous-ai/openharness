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
| A1 | desktop 1.2.59, CLI release | A | yes (OpenCode free model) | ~80 s machine + forced picker | blocker: "OpenCode is unavailable. Choose an agent." | restored; Local Network prompt | 40 + 18 + 5 + 15 = **78** |

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

## Fixes

| Commit | Fix |
|--------|-----|
| 061d037a5 | OpenCode installs from npm when its GitHub download cannot be reached. |
| 8a932cb1a | Setup no longer promises a sign-in before the first harness. |
