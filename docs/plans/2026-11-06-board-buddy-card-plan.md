# Board Buddy card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Restart Buddy (with launch flags as chips), Rename and Remove back on Desktop's Board: a Buddy card that
opens from the Buddy pane's name.

**Architecture:**
- Task 1 extracts the dialog's restart and result logic and adds a shell-word splitter (`buddy_restart.dart`).
- Task 2 builds the chip field (`launch_flags_field.dart`).
- Task 3 builds the card and turns the Board's Buddy pane header into its button (`buddy_card.dart`, `view.dart`
  `_boardChat`), reusing the anchored-card pattern of `identity_card.dart`.

**Tech Stack:** Flutter (Desktop), flutter_test.

**Spec:** `docs/specs/2026-11-06-board-buddy-card.md` (mockup `desktop/mockup/buddy-card-flags.html`).

## Global Constraints

- **Copy, verbatim:**
  - "Running", "Stopped", "Restarting…";
  - "Runs on", "Engine", "Launch flags", "add a flag…";
  - "Press Enter or Space to add · ⌫ removes the last flag";
  - the help line "Added to <engine>'s command line each time this Buddy starts on <machine>. Your Buddy runs with full
    permissions. Don't put secrets here: other people on that computer can see them.";
  - buttons "Restart" / "Start" / "Restarting", "Rename", "Remove";
  - result lines "Update Harness on <machine> to use launch flags." and "The Buddy didn't start with these flags. Fix or
    clear them and restart."
- **Board only:** the card appears only in `SuperTabView.board` mode, on the right pane's header while the Buddy chat is
  shown.
- **Old dialog unchanged:** `showRestartBuddy` keeps its behaviour for the old layout. The existing
  `test/super_tab_buddy_restart_test.dart` must stay green.
- **Desktop design system:** `DesktopChrome`, `AppType`, `grid.AppTheme.watch`, shared widgets. No raw `EdgeInsets` or
  colours where `scripts/check-ui-style.py` forbids them.

## Review Focus

1. **A chip that holds a space or a quote.** It must round-trip through `launchArgsLine` and the splitter unchanged
   (`--add-dir "a b"` → chips `--add-dir`, `a b` → line `--add-dir 'a b'`). Pinned in Task 1.
2. **An unclosed quote while typing** (`--x "a`). Space must not split it; Enter on it shows nothing broken and keeps
   the text. Pinned in Task 2.
3. **The card opened while a card's chat is shown, or the pane switching while it is open.** The header is not a button
   then; an open card closes when the pane leaves the Buddy chat. Pinned in Task 3.
4. **A restart that fails, then a second press.** The second press must send the edited chips again (a fresh attempt),
   not a status check. Pinned in Task 3.
5. **No machine agent known** (the Buddy's machine not loaded). The card shows name and "Stopped", no flags field, no
   Restart, and never throws. Pinned in Task 3.

---

### Task 1: Shared restart and a shell-word splitter

**Files:**
- Modify: `desktop/lib/super_tabs/buddy_restart.dart`
- Test: `desktop/test/super_tab_buddy_restart_test.dart` (existing; add cases)

**Interfaces:**
- Produces:
  - `List<String>? splitLaunchArgs(String line)`: shell-word split (whitespace, single and double quotes, backslash
    escapes, no expansion). Returns null for an unclosed quote or a trailing backslash. Inverse of `launchArgsLine`.
  - `Agent? buddyMachineAgent(SuperTabController c, String projectId, AppNotifier? app)`: what the dialog's
    `_machineAgent` reads today.
  - `enum BuddyRestartOutcome { done, ignored, refused, notStarted, failed }`.
  - `class BuddyRestartResult { final BuddyRestartOutcome outcome; final String? message; }`. `message` is the exact line
    to show, null on `done`.
  - `Future<BuddyRestartResult> restartBuddyWithFlags(SuperTabController c, String projectId, AppNotifier app,
    {required String text, required String saved})`: the dialog's `_submit` body (fresh attempt; `launchArgs` null when
    `text` and `saved` are both empty) and its result copy.
- The dialog's `_submit` calls `restartBuddyWithFlags`; the dialog's behaviour is unchanged.

- [ ] **Step 1: Write the failing tests** (in super_tab_buddy_restart_test.dart, a `group('splitLaunchArgs')`):
  - `splitLaunchArgs('--chrome')` == `['--chrome']`; `splitLaunchArgs('  ')` == `[]`.
  - `splitLaunchArgs('--add-dir "a b" --x=\'y z\' c\\ d')` == `['--add-dir', 'a b', '--x=y z', 'c d']`.
  - `splitLaunchArgs('--x "a')` == null; `splitLaunchArgs('a\\')` == null.
  - Round trip: for `['--add-dir', 'a b', "it's", r'back\slash']`, `splitLaunchArgs(launchArgsLine(w))` == `w`.
  - `restartBuddyWithFlags`, with the fake connection the file already uses:
    - success gives `done`;
    - an `INVALID_LAUNCH_ARGS` reply gives `refused` with the daemon detail as message;
    - an unconfirmed receipt gives `notStarted` with the exact line;
    - a created reply with no echo gives `ignored` with "Update Harness on <machine> to use launch flags.".
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_buddy_restart_test.dart`. Expected: the new cases FAIL
  (undefined names).
- [ ] **Step 3: Implement** the four names above in `buddy_restart.dart`. Move the dialog's `_submit` logic into
  `restartBuddyWithFlags` and the dialog's `_machineAgent` into `buddyMachineAgent`, and call them from the dialog.
- [ ] **Step 4: Run** the same command plus
  `flutter test test/agent_restart_launch_args_test.dart && flutter analyze lib/super_tabs/buddy_restart.dart`.
  Expected: all pass, no issues.
- [ ] **Step 5: Commit**
  ```bash
  git add desktop/lib/super_tabs/buddy_restart.dart desktop/test/super_tab_buddy_restart_test.dart
  git commit -m "desktop: Buddy restart shared by the dialog and a card, and a launch-flag word splitter"
  ```

### Task 2: The launch flags chip field

**Files:**
- Create: `desktop/lib/super_tabs/launch_flags_field.dart`
- Test: `desktop/test/launch_flags_field_test.dart`

**Interfaces:**
- Consumes: `splitLaunchArgs` (Task 1).
- Produces:
  - `class LaunchFlagsField extends StatefulWidget`, with constructor
    `({Key? key, required List<String> words, required ValueChanged<List<String>> onChanged, bool readOnly = false, String? marked, VoidCallback? onSubmitted})`.
  - `marked` is the word to show in the error style.
  - Keys: each chip `ValueKey('launch-flag-chip-$index')`, its × `ValueKey('launch-flag-remove-$index')`, the input
    `ValueKey('launch-flag-input')`.

- [ ] **Step 1: Write the failing tests** (testWidgets, the widget alone in a `MaterialApp` with the app theme):
  - `words: ['--chrome']` shows one chip reading `--chrome` and the hint "add a flag…".
  - Typing `--foo` then Enter calls `onChanged(['--chrome', '--foo'])` and clears the input. Typing `--bar` then a space
    does the same with `--bar`.
  - Typing `--add-dir "a b"` then Enter gives `['--chrome', '--add-dir', 'a b']`.
  - Typing `--x "a` then a space adds nothing and keeps the text `--x "a ` (unclosed quote).
  - Backspace in the empty input calls `onChanged([])` with `words: ['--chrome']`.
  - Tapping `launch-flag-remove-0` calls `onChanged([])`.
  - `readOnly: true` disables the input and the ×.
  - `marked: '--model'` gives that chip the error style: find it and check its decoration colour against the theme's
    danger token used elsewhere in super_tabs.
  - While the input has focus, the help line reads "Press Enter or Space to add · ⌫ removes the last flag". If the help
    line lives in the card instead, move this assertion to Task 3 and note it.
- [ ] **Step 2: Run** `cd desktop && flutter test test/launch_flags_field_test.dart`. Expected: FAIL (file missing).
- [ ] **Step 3: Implement `LaunchFlagsField`.** A `Wrap` of chips (monospace via `AppType`) followed by a borderless
  `TextField`, in a bordered box using the field tokens other super_tabs inputs use.
- [ ] **Step 4: Run** the same test plus `flutter analyze lib/super_tabs/launch_flags_field.dart`. Expected: PASS, no
  issues.
- [ ] **Step 5: Commit**
  ```bash
  git add desktop/lib/super_tabs/launch_flags_field.dart desktop/test/launch_flags_field_test.dart
  git commit -m "desktop: launch flags as chips"
  ```

### Task 3: The Buddy card and the Board's Buddy pane header

**Files:**
- Create: `desktop/lib/super_tabs/buddy_card.dart`
- Modify: `desktop/lib/super_tabs/view.dart`: `_boardChat` (~line 3590), the header `Expanded(child: Text(onBuddy ? 'Your Buddy' : ...))`
- Test: `desktop/test/super_tab_board_buddy_card_test.dart`

**Interfaces:**
- Consumes:
  - from Task 1: `buddyMachineAgent`, `restartBuddyWithFlags`, `BuddyRestartOutcome`, `launchArgsLine`;
  - from Task 2: `LaunchFlagsField`;
  - existing: `buddyMachineName`, `externalEngineName`, `showRenameBuddy`, `confirmRemoveBuddy`.
- Produces:
  - `class BuddyCardButton extends StatefulWidget`, with constructor
    `({required SuperTabController controller, required String projectId, AppNotifier? app, required String label})`.
  - It draws the header button (avatar, `label`, chevron) and owns the anchored card. Follow `identity_card.dart`'s
    anchored-card pattern (`OverlayPortal`).
  - Keys: button `ValueKey('super-board-buddy-button')`; card `ValueKey('super-buddy-card')`; Restart
    `ValueKey('super-buddy-card-restart')`; Rename `ValueKey('super-buddy-card-rename')`; Remove
    `ValueKey('super-buddy-card-remove')`.
  - `projectId` is the Buddy chat's `group.projectId`, the same one the old menu passed to `showRestartBuddy`.

- [ ] **Step 1: Write the failing tests.** Build the Board as desktop/test/super_tab_board_layout_test.dart does, with
  the machine and agent fakes of super_tab_buddy_restart_test.dart.
  - On the Board with the Buddy chat shown, tapping `super-board-buddy-button` shows `super-buddy-card` with "Running",
    "Runs on" + the machine name, "Engine" + "Claude Code", and a chip `--chrome` (the agent's saved `launchArgs`).
  - After opening a task card's chat (as the layout test does), `super-board-buddy-button` is not found.
  - Esc closes the card. Switching the pane to a task card's chat while the card is open closes it.
  - Adding a chip `--foo` and tapping Restart sends `agent_restart` with `launchArgs: '--chrome --foo'`. Success closes
    the card.
  - A stopped Buddy (agent not live) shows "Stopped" and a button reading "Start". It sends `agent_resume` with
    `launchArgs`.
  - Refused (`INVALID_LAUNCH_ARGS`, detail `--model is set by Harness and can't be added here.`): the detail shows and
    the `--model` chip is marked. Unconfirmed: the didn't-start line shows. No echo: the "Update Harness on <machine>…"
    line shows.
  - After a failure, a second Restart sends a new `agent_restart` (new creationId) with the current chips.
  - Rename opens the existing rename dialog; Remove opens the existing remove confirm.
  - A Buddy whose machine agent is unknown shows "Stopped", no `launch-flag-input`, no `super-buddy-card-restart`, and
    no exception.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_board_buddy_card_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement `BuddyCardButton`** in buddy_card.dart, and use it in `_boardChat` in place of the header
  `Text` when `onBuddy`. Leave the non-Buddy branch as is.
- [ ] **Step 4: Run**
  ```
  flutter test test/super_tab_board_buddy_card_test.dart test/super_tab_board_layout_test.dart test/super_tab_buddy_restart_test.dart test/launch_flags_field_test.dart test/agent_restart_launch_args_test.dart test/super_tab_tasks_view_test.dart
  flutter analyze lib/super_tabs
  python3 ../scripts/check-ui-style.py --only desktop/lib/super_tabs
  ```
  Expected: all pass, no new analyze issues in touched files, style check passes.
- [ ] **Step 5: Commit**
  ```bash
  git add desktop/lib/super_tabs/buddy_card.dart desktop/lib/super_tabs/view.dart desktop/test/super_tab_board_buddy_card_test.dart
  git commit -m "desktop: the Board's Buddy card: Restart with launch flags, Rename, Remove"
  ```
