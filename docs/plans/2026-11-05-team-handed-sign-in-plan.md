# A Team account handed to a new owner trusts the new owner's devices — plan

> Task #3262 (P0 hotfix). Worked by the project's instructions: failing tests first, then the code, one pull request.

**Goal:** After Repair hands a Mac's Harness Team account to another Harness account (kelvin → Amon), the Team daemon's
device key log and trust start over for the new account. It then trusts the new owner's daemon and refuses the old owner's.
The trigger is the owner's own setup run behind the macOS password, never the backend's word.

**Architecture:** A Team sign-in's `signInEpoch` is `adopted:team:…` (lib/authSession.ts `teamSignInEpoch`). Adopted, it may
never start the device log over (lib/e2ee/deviceLogSyncer.ts `mayStartOver`), so after Repair the log stays the old account's
and freezes as `invalid`. The Team daemon takes a sign-in code from the handoff file in `team __start` (team/command.ts
`jobStart`). Only the owner's setup script writes that file, as the Team account, behind the macOS administrator prompt
(team/script.ts step 7, windowsScript.ts on Windows), and `takeHandoffFile` refuses one the Team account does not own or
others can read. A session made from that file is a sign-in by hand: the owner ran it. So it gets an epoch that is not
adopted, `team:<random>@<now>` (team/handoff.ts `handedTeamSignInEpoch`). The syncer's existing rule then applies unchanged:
a new sign-in by hand may start the log over for another account, within DEVLOG_RESET_WINDOW_MS of being made, and the
switch puts away everything the old account trusted (lib/e2ee/accountTrust.ts `switchAccountTrust`).

**Tech Stack:** TypeScript, Vitest.

**Spec:** the task's brief, and Dahlia's cause in #3215.

## Global Constraints

- The trigger is only the handoff file of a setup run. A backend that names another account, with no new handed sign-in, or
  more than 10 minutes after one, freezes the log as before.
- `harness team on` (a computer turned into a team machine at its own terminal, no handoff file) keeps the adopted epoch.
- No change in lib/ or core/: the epoch is made in team/. Every reader of an epoch matches it exactly or by `adopted:`.

## Review Focus

- Only the handoff file's code makes a handed (not adopted) Team epoch.
- After the switch, nothing the old owner's account trusted is live: its stores are put away under its account id and come
  back only on a switch back to it (another handed sign-in to that account).

## Tasks

### Task 1: The handed Team epoch, and the trust it moves

**Files:** `cli/src/team/handoff.ts`, `cli/src/team/handedTrust.spec.ts`.

- [ ] Failing spec, with the real DeviceLogSyncer, DeviceLogStore and `signInOf`: a Team account signed in for A by a setup
      run trusts A's daemon; Repair to B (a new handed epoch) makes it trust B's daemon and not A's; B's log served under the
      same sign-in, or under an adopted Team sign-in (no handoff), or 11 minutes after the handoff, freezes the log and moves
      no trust.
- [ ] `handedTeamSignInEpoch(now)`.

### Task 2: `team __start` gives a handoff file's sign-in that epoch

**Files:** `cli/src/team/command.ts`, `cli/src/team/command.spec.ts`.

- [ ] Failing spec: `__start` with a handoff file writes a session whose epoch is not adopted and was made at the run's time.
- [ ] `jobStart` passes `{ signInEpoch: handedTeamSignInEpoch(now) }` to `teamSession`.
