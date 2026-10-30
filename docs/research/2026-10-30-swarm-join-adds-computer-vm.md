# Joining a Swarm adds your computer: fresh-Mac VM test

Scholes, 10-30: "have you tested it? if so how?" This is the end-to-end run of the join flow
(#2188) on a fresh Mac, with its real administrator prompt, against production with test
accounts and a separate test Swarm. Status: **in progress, waiting for the test sign-ins.**

## Builds under test

| Part | Version | Has |
|---|---|---|
| Desktop | 1.3.40 (`Harness-macos.dmg`, sha256 `1d684e6a…1250`, notarized) | #2188 |
| CLI | 0.5.9 (installer, latest) | #2188 and #2267 |
| Claude Code | latest installer | engine presence for "Add machine" |

#2267 is CLI-only (Team-account Codex model, starts kept across a daemon restart, `current`
task ids), so the released CLI 0.5.9 already carries it. A second run on `main` is needed only
for a failure that `main` fixes after 0.5.9.

## Rig

- tart 2.41.1 (checksum checked) in the Engineer's session folder, `TART_HOME` there too;
  nothing installed on the host. Image `ghcr.io/cirruslabs/macos-tahoe-vanilla` (macOS 26.6.2,
  build 25G83), one VM.
- Three macOS users inside the VM, one per test account, each with its own login session and
  its own Harness Desktop and CLI, like three people's computers:
  `admin` = the new member (an administrator, as on a person's own Mac), `owner` = the test
  Swarm's owner, `viewer` = a viewer. Sessions run side by side (fast user switching); Screen
  Sharing with a user's own login shows and drives that user's screen.
- Sign-in: `harness login --code --json` in each user. A phone signed in to Harness as that
  test account types the code. Before saying yes, the CLI shows which email approved, and only
  the matching test account is accepted.

### Rig notes (not product bugs)

- `tart run --vnc-experimental` crashed tart on the first VNC connection (assertion in
  Virtualization.framework `_VZVNCServer`). Headless `tart run --no-graphics` plus the guest's
  own Screen Sharing works.
- A sign-in code lives at most 10 minutes in all (`QR_SIGN_IN_MAX_LIFE_SEC = 600`,
  `backend/src/lib/harnessSession.ts:381`), however long the computer keeps it open. Codes
  posted ahead of time expire; they are made when the person is ready.
- Desktop's sign-in screen offers Google, Apple and email only; there is no QR or code on it.
  The CLI's code sign-in is the way to sign a test account in without a browser login.
- Starting an app in another user's session from ssh: `open` fails with -600, and
  `launchctl asuser UID sudo -u USER` keeps the caller's `HOME` unless `-H -i` is given.

## Steps

Each step: pass or fail, screenshot, and for a failure the exact error and where it comes from.

| # | Step | Code | Result |
|---|---|---|---|
| 1 | Install Desktop and CLI on the fresh Mac | | ✓ installed (sign-in pending) |
| 2 | Owner makes a test Swarm and invites the member and the viewer | Desktop Swarm sharing | pending |
| 3 | Member accepts; the Mac appears under Machines without + | `join_dialog.dart:79`, `tab_invites_section.dart:114` → `app_state.dart` `addMachineOnJoin` → `join_machine.dart` `SwarmJoinMachine.add` → backend `commands.ts` `machine.contribute` (`teamAccountOnly`) | pending |
| 4 | The note says it was added, and how to pause or remove it | `join_machine_note.dart` | pending |
| 5 | macOS asks once for the Harness Team account; approve | `app_state.dart` `offerTeamAccount('join')` → `cli/src/team/autoSetup.ts` | pending |
| 6 | The privacy check passes | backend `machines.ts` `teamWorkRefusal` | pending |
| 7 | The owner's side starts an agent on the Mac; it runs in the Team account, never as the member | backend `leadStart.ts` (`teamAccountOnly`); process owner in the VM | pending |
| 8 | Pause, then Remove, work | `commands.ts` `machine.pause` / `machine.remove` | pending |
| 9 | The viewer's join adds nothing | `addMachineOnJoin` (`role != 'collaborator'`) | pending |

## Failures

None yet.
