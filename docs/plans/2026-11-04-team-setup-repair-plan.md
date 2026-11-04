# Team setup repairs a half-finished setup Implementation Plan

> **For agentic workers:** Written by the writing-plans skill as the project's instructions adapt it (Engineer role).
> The Engineer implements it task by task, test first, in this session; the pull request's two security reviews are the
> independent reviews. No execution handoff.

**Goal:** On a Mac with the Harness Team account but no team daemon (or no passed privacy check), Set up repairs it
instead of answering "already set up"; the macOS root script no longer trusts the owner's PATH; the machine row and the
Set up dialog name the missing part and offer Repair.

**Architecture:** `TeamAutoSetup` (cli/src/team/autoSetup.ts) counts setup complete only when the account exists and
nothing is `missing` (a new dep: the daemon's service file and launchd job, and the team daemon's privacy report, read
as `harness team status` reads them). With the account but a part missing, `manual` (Set up) runs the setup script
again, which is rerunnable; the automatic moments (`startup`, `join`, `contribute`) answer `incomplete` and ask for no
password. `status` answers `{ state: 'incomplete', missing, detail }`. `buildSetupScript` (cli/src/team/script.ts) pins
`PATH=/usr/sbin:/usr/bin:/sbin:/bin` right after `set -eu`, as the Linux scripts do, so a GNU `stat` (micromamba) ahead
on the owner's PATH no longer breaks `owned_by_root`. Desktop: `superTabTeamSetupLine` says what is missing, the row's
button reads Repair, and the dialog opened from it says what is missing and offers Repair; the setup lock reads
`incomplete` after a run as unfinished.

**Tech Stack:** TypeScript (CLI), vitest; Dart/Flutter (Desktop), flutter_test.

**Spec:** task #2765's brief (Scholes, Darren-MacBook, 11-04); #2921/#2937's step markers.

## Global Constraints

- Two independent security reviews (setup runs as root).
- Never run real osascript, sudo, dscl or team setup: AdminDeps and AutoSetupDeps fakes only.
- People's own environments are not changed.

## Review Focus

- A part missing never makes an automatic moment ask for the password: only Set up (manual) repairs.
- A complete setup (account, daemon loaded, privacy passed) still answers `exists`, and runs nothing.
- The PATH pin comes before any command the script runs, and every tool the script needs is in those folders.
- Windows keeps its own script; Linux scripts already pin PATH.

## Design

N/A for storage: nothing new is stored. Failure: a part that cannot be read counts as missing and is said; the repair is
the rerunnable setup script, so a repair that fails is said as setup failures are.

### Task 1: Setup counts its parts, and Set up repairs (autoSetup.ts)

- [ ] Failing tests (autoSetup.spec.ts): account without daemon → `manual` starts setup; `startup` answers `incomplete`
  without setup; `status` names the missing part; account, daemon and privacy all there → `exists`, nothing runs.
- [ ] Implement; run.

### Task 2: The root script pins a system-only PATH (script.ts)

- [ ] Failing tests (script.spec.ts): PATH is pinned before the first command; on macOS a GNU-style `stat` first on the
  PATH does not fail the owner check of `/`.
- [ ] Implement; run.

### Task 3: The row and the dialog name the missing part (Desktop)

- [ ] Failing tests: `superTabTeamSetupLine` for `incomplete`; the dialog opened with a missing part says it and offers
  Repair.
- [ ] Implement; run; Desktop guard tests.
