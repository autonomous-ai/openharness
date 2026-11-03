# Team account setup lock on join: implementation plan

> Way of working: this project's Engineer role (project instructions). Plan first, then each task test first: its
> failing test in one commit, the code that passes it in the next. No per-task review; the pull request's Review step is
> the one independent review.

**Goal:** On Desktop, when this Mac joins a Swarm project (or is added to one), the Harness Team account setup window
opens at once over the whole app and stays until setup succeeds. A wrong password says so and allows a retry.

**Architecture:** `AppNotifier` keeps which Swarms this Mac joined that still wait on its Team account. It stores them
on this computer so that a restart locks again, and clears them once this Mac's daemon reports the account `exists`.
`TeamAccountSetupLock` wraps the whole window above the Navigator, in `MaterialApp.builder`. While locked it covers
every route and dialog with a barrier, excludes them from focus, pointer and semantics, and shows the explanation from
`team_account_setup.dart`. It drives the same daemon actions as today (`teamSetupCheck`, `teamSetup` `manual`,
`teamSetupStatus`). The password is asked only by the system's own prompt (macOS `osascript`, polkit, UAC).

**Tech Stack:** Flutter 3.47.2 (desktop/), flutter_test widget tests. No CLI or backend change.

**Spec:** task #2418 brief, as changed by the PM in the task's thread on 2026-11-03 (Scholes's ask). The prompt opens on
join and blocks the whole app until setup succeeds; there is no banner and no dismiss. Phone and web stay as they are.
Only where setup can never finish here, the window says why and offers "Remove this Mac from the Swarm", never a plain
close.

## Global Constraints

- The password is never collected or stored by Harness; the system's own prompt only (cli/src/team/admin.ts).
- Desktop only: `AppNotifier.teamAccountOn` systems (macOS, Linux, Windows). The web build and the phone app never lock.
- Tests never sign this Mac out of the real CLI; they use `createApp` with a fake daemon connection and a memory store.
- No CLI change (Swarm code stays out of cli/src/core); no backend change.
- PR body first line: "Requested by scholes@autonomous.ai through Harness."
- Copy follows docs/naming-system.md: "Harness Team", "this Mac" / "this computer", "Swarm".

## Design (feature design rules)

- growth: one small list of Swarm ids per account on this computer; cleared when the account exists, or when this Mac is
  removed from those Swarms.
- concurrency: N/A because it is one in-process list on the UI isolate; joins add with set semantics.
- read cost: one local file read at connect. While the system prompt is open, this Mac's own daemon is asked for its
  status every 2 s. That stops once setup ends, and after the prompt's own 15-minute limit. Nothing reads the server.
- scale: N/A because the list holds one entry per Swarm joined at this computer.
- compatibility: an older daemon without `teamSetupCheck` answers an error. Nothing locks then, as today. Without
  `teamSetupStatus` the window keeps "macOS is asking…" and Try again.
- migration + rollback: no migration. Rolling back the app drops the lock; the stored list is ignored by older builds.
- audience: the lock follows only this computer's own daemon and this account; the server already decides what a
  machine without a Team account may run.
- identity: N/A because the setup runs as this Mac's own person, through the existing daemon action.
- failure: every end state says why (cancelled, password not accepted, failed with the daemon's detail, cannot set up
  here, Harness unreachable), with Try again or the one way out.
- platforms: macOS, Linux, Windows Desktop. Not web, not the phone.

## Review Focus

- A dialog or menu opened before the lock, or by a native menu item while locked: it must sit under the barrier and take
  no key or click. Covered by task 2's dialog-behind test.
- The ⌘⌥ keys that answer the daemon's line go through a global keyboard handler, not focus. While locked they must do
  nothing. Covered by task 3.
- Quitting and reopening during the lock: it locks again until the account exists. Covered by task 1's restart test.
- The person cancels macOS's prompt, or is not an administrator: Try again, plus the one way out. Covered by task 2.
- A second join while locked: one window, not two. Covered by task 1 ("once").

---

### Task 1: AppNotifier knows when this Mac must finish its Team account

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`offerTeamAccount`, `addMachineOnJoin`, the start offer)
- Test: `desktop/test/team_account_offer_test.dart`

**Interfaces:**
- Produces:
  - `bool get teamSetupLocked`: true while this Mac's own Team account is wanted for a Swarm it joined or was added to.
  - `Future<void> teamAccountMade()`: clears the lock and its stored list.
  - `Future<String?> removeLockedMachine()`: removes this Mac (`machine.remove`) from each Swarm the lock is for. Returns
    null when done, otherwise the Swarm's own sentence.
  - `offerTeamAccount('join' | 'contribute', tabId:)`: the daemon's check. `wanted`, `declined`, `waiting`, `running` or
    `no-prompt` locks (a cancel remembered from before does not let a new join through). `exists` and the rest do not.
    `startup` keeps today's dismissible explanation (`teamSetupAsks`), and never while locked.
  - Storage key `team_setup_lock.<accountId>`: a JSON list of Swarm ids.

- [ ] Step 1: failing tests:
  - `a join locks once, though asked twice` (two offers for the same Swarm and one for another give
    `teamSetupLocked == true` and no `teamSetupAsks` event).
  - `a join on a Mac with the account does not lock` (`exists`).
  - `a cancel remembered from before still locks a new join` (`declined`).
  - `the lock comes back after a restart until the account exists`: a new `AppNotifier` on the same memory store locks
    on connect when `teamSetupStatus` says `none`, and not when it says `exists`.
  - `teamAccountMade clears it`.
  - `removing this Mac from the Swarm clears it` (`machine.remove` sent for this Mac's id).
- [ ] Step 2: run `flutter test test/team_account_offer_test.dart`; expect FAIL (no `teamSetupLocked`).
- [ ] Step 3: implement in app_state.dart.
- [ ] Step 4: run the file; expect PASS.
- [ ] Step 5: commit.

### Task 2: the lock window over the whole app

**Files:**
- Modify: `desktop/lib/super_tabs/team_account_setup.dart` (add `TeamAccountSetupLock`; `_Words` gains the lock's
  sentences)
- Modify: `desktop/lib/app_shell.dart` (`MaterialApp.builder` wraps in the lock)
- Test: `desktop/test/team_account_lock_test.dart`

**Interfaces:**
- Consumes: task 1's `teamSetupLocked`, `teamAccountMade`, `removeLockedMachine`; existing `setUpTeamAccount`,
  `teamSetupStatus`.
- Produces: `TeamAccountSetupLock({required AppNotifier app, required Widget child, String? operatingSystem})`.
  Keys: `team-account-lock`, `team-account-lock-continue`, `team-account-lock-retry`, `team-account-lock-remove`,
  `team-account-lock-outcome`.

Window states and copy (Mac words; Linux and Windows use the existing "this computer" words):
- intro: today's title and three paragraphs; one button, Continue.
- waiting: today's `started` sentence, with a progress indicator; it asks this Mac's daemon every 2 s. `exists` closes
  the window (`teamAccountMade`); `failed`, `declined` or `none` after a run end it.
- password not accepted (failed, detail matching `-60005`, `incorrect` or `password`): "macOS did not accept that
  password. Try again." Try again.
- failed (other detail): "Setup did not finish: <detail>." Try again.
- cancelled (`declined`): "The password window was closed before setup finished." Try again. Then "No administrator
  password for this Mac? Remove it from the Swarm; you can add it again from Machines." and Remove this Mac from the
  Swarm.
- cannot here (`update`, `unsupported`, `no-prompt`): today's sentence. Remove this Mac from the Swarm only.
- unreachable: today's sentence. Try again.

- [ ] Step 1: failing tests:
  - `locked, nothing behind it takes a click, a key or focus`: a button, a text field and a CallbackShortcuts under the
    lock, and a dialog route pushed before it, take no tap, no Tab focus and no shortcut. `Semantics` behind it are
    excluded.
  - `there is no way to close it`: Escape and a barrier tap leave it, and it has no Cancel or Not now.
  - `Continue starts setup and success closes it` (`teamSetup` `manual`, then status `running`, then `exists`).
  - `a wrong password says so and Try again asks again`: status `failed` with -60005 detail shows the sentence, and Try
    again sends a second `teamSetup`.
  - `a cancel offers Try again and the one way out`; `cannot set up here offers only the way out`, and Remove closes it
    (sends `machine.remove`).
  - `unlocked, it is not there` (the child is reachable).
- [ ] Step 2: run; expect FAIL (no `TeamAccountSetupLock`).
- [ ] Step 3: implement. A `Stack`: the child in `ExcludeFocus`, `IgnorePointer` and `ExcludeSemantics` while
  locked; a non-dismissible `ModalBarrier`; the panel in a `FocusScope` with autofocus. The panel has no `Tooltip`
  (there is no Overlay above the Navigator). In app_shell.dart, `builder` wraps `framed` in the lock, reading the app
  through `Consumer`.
- [ ] Step 4: run the lock file and team_account_offer_test.dart; expect PASS.
- [ ] Step 5: commit.

### Task 3: global keys and the old dialog while locked

**Files:**
- Modify: `desktop/lib/screens/swarm_screen.dart` (`_noteKey`, the `teamSetupAsks` listener)
- Test: `desktop/test/team_account_lock_test.dart`

- [ ] Step 1: failing test `the daemon line's ⌘⌥ keys do nothing while locked`: a `SwarmScreen` key handler test with
  the app locked. If pumping SwarmScreen is too heavy, test an extracted `bool swarmKeysHeld(AppNotifier app)` that
  `_noteKey` returns early on.
- [ ] Step 2: run; expect FAIL.
- [ ] Step 3: `_noteKey` returns false at once while `app.teamSetupLocked`. The start explanation is not shown while
  locked.
- [ ] Step 4: run; expect PASS.
- [ ] Step 5: commit.

### Task 4: screenshots and the suite

- [ ] Light and dark screenshots of the lock (intro, waiting, password not accepted, cancelled) from a golden-style
  capture test run locally, committed for the PR, then removed in the next commit (pr-screenshots-via-commit).
- [ ] `flutter analyze`; `flutter test` for the touched files plus `super_tab_team_machine_test.dart`,
  `super_tab_add_computers_test.dart`, and the app_shell tests; then the whole desktop suite.
- [ ] Red/green evidence in a PR comment.
