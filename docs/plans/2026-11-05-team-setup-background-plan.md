# Team account setup runs in the background, shows progress, and takes less time — Plan

**Goal:** After the password, Harness Team setup no longer holds the app: the Mac's row in Machines shows the step and
the time left, a notice says when it is ready or failed (failure with a plain reason and Retry), and the setup itself
takes seconds instead of minutes on a Mac that already has Claude Code and Codex.
**Architecture:** The CLI's Mac setup script copies the owner's own installed Claude Code and Codex into the team
account (the owner's `tar` piped into the team account's `tar`, root reading and writing nothing of either), and runs
npm only for an engine it could not copy. Desktop gets one watcher per app (`TeamSetupWatch`, in
`super_tabs/team_account_setup.dart`) that follows the daemon's `teamSetupStatus` while setup runs; the lock steps
aside once the password is accepted, the machine row draws the watcher's line, and the watcher's end raises the notice.
**Tech Stack:** TypeScript CLI (vitest specs on the generated shell), Flutter Desktop (widget tests with a memory store
and fake daemon answers).
**Spec:** Task #3169 (Scholes, 2026-11-05; mockup posted to him at 16:00).

## Measured before (this Mac, real setup of 2026-11-04, from file birth times and the team daemon's log)

| Step (daemon step names) | Time |
|---|---|
| account, home, privacy | ≈ 8 s |
| runtime (copy Node, CLI, tmux) | 3 s |
| engines (`npm install` Claude Code + Codex, ≈ 650 MB) | 4 min 18 s |
| sign-in, daemon, report (privacy check) | ≈ 5 s |

The engine download is ≈ 94 % of the wait. Copying the two installed packages on the same Mac took 2.3 s (tar pipe).

## Global Constraints
- The team account's isolation rules in `cli/src/team/script.ts` stand: root never writes inside the team home and
  never reads the owner's files on their behalf; every value is checked and single-quoted.
- npm stays the fallback for an engine the Mac does not have (or whose copy does not check out); nothing new fails setup.
- Desktop tests use a memory store and fake daemon answers; no real CLI sign-in, no real macOS account.
- Follow the Harness design language; words follow docs/naming-system.md ("Harness Team", "this Mac").
- Linux and Windows scripts keep npm (out of this task's measurement); their behaviour is unchanged.
- Swarm code stays out of `cli/src/core`.

## Design
- growth: nothing new is stored; the watcher holds one status in memory while setup runs.
- concurrency: one setup at a time, as today (`TeamAutoSetup.running`); one watcher per app.
- read cost: one `teamSetupStatus` read every 2 s, only while setup runs, local daemon only.
- scale: N/A because it is one Mac's own setup.
- compatibility: an older daemon says `engines` for its npm step, which the estimate times as a download; a new daemon
  says `copy-engines` for the copy. An older Desktop shows the new step as an unknown one (its waiting words).
- migration + rollback: N/A because nothing is stored; rolling back restores the npm-only step.
- audience: only this Mac's own Desktop asks its own daemon (`teamSetupStatus` is local-owner only, unchanged).
- identity: the copy runs as the owner (read) and as the team account (write), never as root, never the owner's login.
- failure: a failed copy is said in the script's output and falls back to npm; a failed setup ends in a notice with its
  reason and Retry, and the lock returns where it holds.
- platforms: macOS for the copy; the Desktop watcher, row line and notice on every platform that offers Team setup.

## Review Focus
- The copy's shell: values checked and quoted, the two-phase unpack/commit, a failed owner `tar` detected, links
  inside the package that point into the owner's home (discarded, npm instead).
- The lock stepping aside only after the password, and coming back on failure.
- The estimate never says "0 min left"; it rises once when an npm download starts (a Mac without the engines).

## Tasks

### 1. CLI: copy the owner's installed engines (cli/src/team/script.ts, deps.ts, command.ts)
**Files:** `cli/src/team/script.ts`, `cli/src/team/script.spec.ts`, `cli/src/team/deps.ts`, `cli/src/team/command.ts`
**Interfaces:** `SetupScriptInput.engineSources?: { packageName, dir, binName, binPath }[]`;
`TEAM_ENGINE_COPY` (team-side unpack/commit/discard script); `ownerEngineSources(home, nodeRuntimeDir)` in deps.
- [ ] Failing spec: the Mac setup script says `step copy-engines`, pipes `as_owner tar` into `as_team` for each source,
      and passes npm only the packages not copied; with no sources it installs both from npm as before.
- [ ] Failing spec: `TEAM_ENGINE_COPY` run against a temp home unpacks into `.next`, refuses a copy whose bin is
      missing or a package.json of another name, commits by rename and links `~/.local/bin/<bin>` as npm does.
- [ ] Failing spec: `ownerEngineSources` takes `~/.local/lib/node_modules/<pkg>` first, then the Harness Node's, then
      Homebrew's; skips a folder whose package.json names another package or whose bin path is not a plain relative path.
- [ ] Code until green; time the new step on this Mac (after number).

### 2. Desktop: the watcher (super_tabs/team_account_setup.dart)
**Files:** `desktop/lib/super_tabs/team_account_setup.dart`, `desktop/test/team_setup_watch_test.dart`
**Interfaces:** `TeamSetupWatch.of(AppNotifier)`, `follow()`, `running`, `line` ("Harness Team: setting up · step 2 of 4 ·
about 4 min left"), `ended` stream of `TeamSetupEnd(ready | failed(reason))`.
- [ ] Failing tests: four steps from the daemon's eight; time left from the measured step times, at least "less than a
      minute" while running; `exists` ends ready, `failed`/`declined`/`incomplete`/`none` end failed
      with a plain reason; polling stops at the end.

### 3. Desktop: the lock steps aside, the row shows progress, the notice (team_account_setup.dart, machines.dart)
**Files:** `desktop/lib/super_tabs/team_account_setup.dart`, `desktop/lib/super_tabs/machines.dart`,
`desktop/test/team_account_lock_test.dart`, `desktop/test/team_setup_background_test.dart`
- [ ] Failing test: once setup reports a step after the password, the lock's barrier is gone and a button under it
      takes a tap (app usable), while `teamSetupLocked` still holds.
- [ ] Failing test: the Mac's row shows "Harness Team: setting up · step N of 4 · about M min left" and "Keep working.
      We'll tell you when it's ready."
- [ ] Failing test: setup ending ready shows a notice and the lock ends; ending failed shows a notice with the reason
      and Retry (Retry starts setup again), and where the lock holds it comes back with the reason and Try again.
- [ ] Code until green.
