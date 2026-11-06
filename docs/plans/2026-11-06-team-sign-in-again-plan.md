# A revoked Team sign-in comes back from Repair or the card: Implementation Plan

> Way of working: this project's Engineer role. The plan is implemented task by task, each failing test committed and
> watched fail before its code, by superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On a Mac whose Harness Team sign-in was revoked, the person's own Repair, Restart or Sign in again signs the
Team account in again, and its machine row returns to running (task #3684, reported by kelvin1295 retesting #3307).

**Architecture:** A revoke marks the Team account's session file signed out and stops its daemon for good
(core/main.ts `onRevoked`, lib/authSession.ts `markSignedOut`). The setup script signs in only when that file is
empty, so Repair started the daemon again with the revoked sign-in. Three changes: the setup script (run as root,
only for a person's own setup) treats a session marked signed out as missing; the owner's daemon reports a Team
account whose status says signed out or failed as `sign-in-again`, and a person's own setup there signs in again;
Desktop reads that status for its own offline Team row and offers Sign in again.

**Tech Stack:** TypeScript (cli, vitest), POSIX sh (setup script), Dart/Flutter (desktop, widget tests).

**Spec:** task #3684's brief (Goal, Changes, Constraints, Review).

## Root cause, measured in the code

- `cli/src/team/script.ts` `signInStep`: `if [ "$SIGN_IN" = always ] || [ ! -s "$TEAM_SESSION" ]`. A revoked
  session is kept on disk with a `signedOut` mark (lib/authSession.ts, since 10-27), so the file is not empty and
  nothing is handed over. `SIGN_IN` is `always` only with `--sign-in-again`, which Repair and Restart did not send.
- `cli/src/team/command.ts` `jobStart` (`team __start`) records `signIn: signed-out` in the status file at each job
  start, but a revoke exits the core with `CORE_EXIT_STOP`, which launchd does not restart (`KeepAlive`
  `SuccessfulExit` false). So the status keeps `signed-in` until something restarts the job; after Repair it reads
  `signed-out`.
- Desktop reads `teamSetupStatus` only for a `TEAM_ACCOUNT_REQUIRED` row (`desktop/lib/super_tabs/machines.dart`
  `_readTeamSetup`), never for its own `MACHINE_OFFLINE` Team row, which only ever shows Restart.

## Global Constraints

- Keep #3307's behaviour: the Team account starts again by itself after an update, and the offline row explains what
  to do.
- An ordinary daemon-down or after-update case never triggers a new sign-in; a new sign-in comes only from a person's
  own Repair, Sign in again or Restart.
- Never print or log a token; the status and row payload carry fixed words only.
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Button copy follows docs/naming-system.md: "Sign in again" (a sign-in action, as the CLI's own `--sign-in-again`).

## Review Focus

1. A Team account whose daemon is merely down (status `signed-in`) is offered Restart, never Sign in again, and its
   Restart hands no new sign-in over (the session file is not marked). Task 1 and Task 2 pin it.
2. An automatic offer (`startup`, `join`, `contribute`) on a revoked account starts nothing. Task 2 pins it.
3. A status file the owner cannot read, or one with no `signIn`, reads as not revoked (no new sign-in). Task 2 pins it.
4. A `failed` sign-in (a handover that did not redeem) is as lost as a `signed-out` one. Task 2 pins it.
5. Windows decides by the status file only (command.ts `windowsHandOver`): after a revoke that stopped the daemon its
   status still says `signed-in` until the job starts again. Out of this task's measured scope (kelvin1295's Mac);
   noted in the PR.

---

### Task 1: The setup script replaces a sign-in marked signed out

**Files:**
- Modify: `cli/src/team/script.ts` (`signInStep`)
- Test: `cli/src/team/script.spec.ts`

**Interfaces:** Produces: no new names. `SIGN_IN=missing` now also hands over when `$TEAM_SESSION` holds a
`"signedOut"` mark.

- [ ] **Step 1: Write the failing test.** It runs the step's condition in `/bin/sh` against three session files in
  a `mktemp -d` folder: empty (hands over), `{"accessToken":"a"}` (does not), `{"accessToken":"a","signedOut":{"at":1,"reason":"revoked"}}`
  (hands over), each with `SIGN_IN=missing`; and the built script contains `grep -q '"signedOut"' "$TEAM_SESSION"`.
- [ ] **Step 2: Run it and watch it fail:** `npx vitest run src/team/script.spec.ts` fails on the marked file.
- [ ] **Step 3: Change the condition** to `if [ "$SIGN_IN" = always ] || [ ! -s "$TEAM_SESSION" ] || grep -q '"signedOut"' "$TEAM_SESSION" 2>/dev/null; then`.
- [ ] **Step 4: Run it and see it pass**, and `src/team/command.spec.ts` with it.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 2: The owner's daemon says a lost Team sign-in, and a person's own setup signs in again

**Files:**
- Modify: `cli/src/team/autoSetup.ts` (`AutoSetupDeps`, `TeamSetupStatus`, `decide`, `status`, `realTeamAutoSetup`)
- Test: `cli/src/team/autoSetup.spec.ts`

**Interfaces:**
- Produces: `AutoSetupDeps.signInLost?(): Promise<boolean>`: the Team account's status file says `signIn.state` is
  `signed-out` or `failed`; false when it cannot be read.
- Produces: `TeamSetupStatus.state` gains `'sign-in-again'`, with `detail: TEAM_SIGN_IN_LOST` =
  `'its sign-in was ended. Sign in again to bring it back'`.

- [ ] **Step 1: Write the failing tests:**
  - `status()` with an existing account and `signInLost` true answers `{ state: 'sign-in-again', detail: TEAM_SIGN_IN_LOST }`,
    even with the daemon missing.
  - `offer('manual')` on it starts setup with `{ signInAgain: true }`; `offer('manual', …, { restart: true })` too.
  - `offer('manual', …, { restart: true })` with `signInLost` false starts setup with no options (an ordinary restart).
  - `offer('startup' | 'join' | 'contribute')` on a lost sign-in starts nothing (`incomplete` or `exists`).
  - `signInLost` that throws reads as false.
- [ ] **Step 2: Run and watch them fail:** `npx vitest run src/team/autoSetup.spec.ts`.
- [ ] **Step 3: Implement.** In `decide`, for a `manual` reason on an existing account read `signInLost`; it counts
  as asked again and runs with `signInAgain`. In `status`, a lost sign-in answers before the missing parts.
  `realTeamAutoSetup.signInLost` reads `teamCommandDeps().readStatus(config.statusFile ?? layout.statusFile)`.
- [ ] **Step 4: Run and see them pass**, with `src/superTabs/service.spec.ts`.
- [ ] **Step 5: Commit** the tests first, then the code.

### Task 3: Desktop offers Sign in again on its own revoked Team row

**Files:**
- Modify: `desktop/lib/super_tabs/machines.dart` (`_readTeamSetup`, `restartTeam` label, click handler, row line)
- Modify: `desktop/lib/super_tabs/team_account_setup.dart` (`signInAgain` wording for a lost sign-in)
- Test: `desktop/test/super_tab_team_machine_test.dart`

**Interfaces:** Consumes Task 2's `teamSetupStatus` answer `{ state: 'sign-in-again', detail }`.

- [ ] **Step 1: Write the failing widget test**, from the Restart test's pattern (memory store, fake daemon,
  `TEAM_RESTART_SHOTS` screenshots): an own offline Team row whose status is `sign-in-again` shows the line "Harness
  Team account signed out" and the button "Sign in again"; tapping it and Continue sends
  `{'action':'teamSetup','reason':'manual','signInAgain':true}`; a row whose status is `exists` keeps Restart and
  sends `restart: true` only. Light and dark shots `team-sign-in-again-light/dark`.
- [ ] **Step 2: Run and watch it fail:** `flutter test test/super_tab_team_machine_test.dart`.
- [ ] **Step 3: Implement:** `_readTeamSetup` also reads for an own `MACHINE_OFFLINE` Team row; the label is
  "Sign in again" when the state is `sign-in-again`; the click sends `signInAgain: true` for it; the dialog's
  `missing` text is the status detail.
- [ ] **Step 4: Run and see it pass**, and the shots in light and dark.
- [ ] **Step 5: Commit** the test first, then the code.
