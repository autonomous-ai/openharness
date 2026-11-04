# Harness Team setup on Windows and Linux: a bounded engine install and its steps, as on a Mac: plan

> Way of working: this project's Engineer role (project instructions): test-driven development, each failing spec
> committed before the code that passes it, one pull request, one independent review.

**Goal:** a new member on Windows or Linux never waits on the Harness Team setup screen with no sign of progress. The
Claude Code and Codex install has the Mac's limit (one run, 8 minutes, missing engines said plainly, the account still
finished), and the setup screen shows each step (task #2686, follow-up to #2667/#2921).

**Architecture:** #2921 added the step file (`progress` in the setup's private staging folder, read by
cli/src/team/admin.ts while the script runs), the `password`/`report` steps in cli/src/team/command.ts, and the Desktop
words for each step. This adds the writers on the two other systems: the Linux setup script (cli/src/team/script.ts
`buildLinuxSetupScript`) and the Windows one (cli/src/team/windowsScript.ts `buildWindowsSetupScript`; on Windows the
sign-in and the daemon's start happen after the script, in command.ts `windowsHandOver`, which says those two steps).
Linux already runs the bounded `TEAM_ENGINES_INSTALL`; Windows gets a PowerShell twin.

**Tech Stack:** TypeScript + vitest; the built scripts are checked as text (and parsed where `pwsh` exists). Nothing
runs UAC, pkexec, sudo, an elevated PowerShell script or a real setup.

**Spec:** task #2686's brief.

## Global constraints

- Everything system-touching goes through AdminDeps and TeamCommandDeps fakes.
- Swarm code stays out of cli/src/core. Desktop does not change: its step words already cover every step named here.

## Review focus

- Windows: the install stops its whole process tree (`taskkill /T`) at the limit, and a late engines run no longer
  fails setup (As-Team gives up on it and says so, instead of `die`).
- The step file is written without following a link: as the owner on Linux (`runuser`, write-then-rename), and on
  Windows by write-then-rename with a fresh name, where `Move-Item -Force` replaces a link rather than writing through it.

## Task 1: Linux says its steps

**Files:** cli/src/team/script.ts, cli/src/team/script.spec.ts

- [ ] Failing spec: the Linux setup script has the `step` helper (as the owner, into `$STAGE/progress`) and says
      account, home, privacy, runtime, engines, sign-in, daemon in order, before each runs; it runs the bounded install.
- [ ] The helper and the markers.

## Task 2: Windows bounds its engine install and says its steps

**Files:** cli/src/team/windowsScript.ts, cli/src/team/windowsScript.spec.ts, cli/src/team/command.ts,
cli/src/team/command.spec.ts

- [ ] Failing specs: the engines script installs both packages in one npm run, then each alone, within 480 seconds in
      all, stops the tree at the limit and says the engines are missing and how to add them; As-Team gives the engines
      10 minutes and goes on when they are late; the setup script says account, home, privacy, runtime, engines in
      order; setup on Windows says sign-in and daemon around the handover, then report.
- [ ] The code that passes them.
