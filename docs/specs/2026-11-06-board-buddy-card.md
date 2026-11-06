# The Buddy card on the Board, with launch flags as chips (Diego, 2026-11-06)

## Why

On the Board (#3365) the person's Buddy chat sits in the right pane. That pane's header holds only "Your Buddy" and a
hide icon. The Buddy chat's old header menu (Rename Buddy…, Restart Buddy…, Remove Buddy) is not reachable there.
That menu is in `view.dart`, inside `if (_isBuddyChat(group))`, and is only drawn for the old chat layout. So Restart
Buddy with extra launch flags (#3351, e.g. `--chrome`) disappeared from Desktop.

Mockups: `desktop/mockup/buddy-restart-board.html` (options), `desktop/mockup/buddy-card-flags.html` (chosen: option B's
card, with option C's chip field for the flags).

## Behaviour

### The header
- On the Board's right pane, while the Buddy chat is shown, the title becomes a button: the Buddy's avatar, the name the
  header shows today ("Your Buddy"), and a chevron.
- Clicking it opens the Buddy card, anchored under it. Esc, a click outside, or a second click closes it.
- While a card's chat is shown (the "‹ Your Buddy" back button), the header stays as today, with no card.

### The Buddy card
Top to bottom:
- **Name and status.** The status is "Running" with a green dot when the Buddy's machine agent is live, "Stopped" with
  a grey dot otherwise, and "Restarting…" with an amber dot while a restart runs.
- **Runs on:** the machine name (`buddyMachineName`).
- **Engine:** `externalEngineName(engine)`, plus " · <model>" when the agent reports one.
- **Launch flags:** the chip field below, with the help line under it. The help line is the dialog's copy:
  "Added to <engine>'s command line each time this Buddy starts on <machine>. Your Buddy runs with full permissions.
  Don't put secrets here: other people on that computer can see them." While the field has focus, the help line reads
  "Press Enter or Space to add · ⌫ removes the last flag".
- **Buttons:** **Restart** (primary; it reads **Start** when the Buddy is stopped), **Rename** (`showRenameBuddy`), and
  **Remove** at the right in the destructive style (`confirmRemoveBuddy`).

What the card shows when it applies:
- The flags field and Restart/Start show only for the reader's own Buddy with an agent on a machine (`c.buddy(...)` with
  a non-empty `harnessId` and `machineId`, as the old menu item required) whose machine agent is loaded, so the card
  knows its saved flags and whether it runs (audit). The card opens only on the reader's own Buddy chat.
- Rename and Remove follow the old menu's rule (`editable`).

### The chip field
- Each saved word (the machine agent's `Agent.launchArgs`) is a chip in monospace with a × that removes it.
- After the chips, an input with the hint "add a flag…".
- Enter or Space turns the typed text into chips. Enter never restarts the Buddy; only the Restart button does. The text is split as a shell would split it, so `--add-dir "a b"` gives
  two chips, `--add-dir` and `a b`. An unclosed quote waits for more typing instead of splitting.
- Backspace in an empty input removes the last chip.
- While a restart runs, the field is read-only.
- After a refusal (`INVALID_LAUNCH_ARGS`), the chip the daemon names (the detail's first word, compared to each chip's
  word before any `=`) is marked red until the field changes.

### Restart
- Restart sends the chips as one line (`launchArgsLine(words)`), on the same path the dialog uses:
  - `AppNotifier.restartAgent` with a fresh `restartAttempt`;
  - `launchArgs` omitted when nothing is saved and there are no chips;
  - a stopped Buddy is resumed with the flags, as today.
- While it runs, the button shows a spinner and "Restarting", and Rename and Remove are disabled. Closing and reopening
  the card keeps that state until the restart answers. Text typed but not yet a chip is added before sending; an
  unclosed quote stops the restart with "Close the quote in the launch flags, or remove it."
- Results, shown in the card under the field with the dialog's copy:
  - **success:** the card closes;
  - **`launchArgsIgnored`:** amber line "Update Harness on <machine> to use launch flags.";
  - **refused:** red line with the daemon's detail, and the named chip marked red;
  - **`engineNotStarted`:** red line "The Buddy didn't start with these flags. Fix or clear them and restart.";
  - **any other error:** a red line with `result.error`.
- The restart and its result copy are one shared piece of code, called by both the card and the old dialog. The dialog
  stays for the old chat layout (web), unchanged in behaviour.

## Design

- **Growth, read cost, scale:** none. The card reads what the controller and `AppNotifier` already hold. Nothing new is
  stored.
- **Compatibility:** the same daemon requests as #3351. An older daemon gives the "Update Harness" line, as today.
- **Platforms:** Desktop's Board only (`SuperTabView.board`). The web keeps the old menu and dialog.
- **Audience:** the card's actions apply only to the reader's own Buddy, as the menu did.
- **Failure:** every failure is shown in the card and nothing closes on its own. A lost reply shows its error and
  Restart can be pressed again (each press is a fresh intent).
