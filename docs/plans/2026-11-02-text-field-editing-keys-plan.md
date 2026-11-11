# Text-field editing keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With the caret in a Desktop text field, the standard editing keys (word, line and text moves, selects, word and line deletes) edit the text instead of running an app shortcut.

**Architecture:** `KeymapHost` (`desktop/lib/shortcuts/keymap_host.dart`) is an early key handler, so it sees every key before the focused field and turns ⌘-arrows into pane focus and ⇧⌘-arrows into pane moves. A new pure predicate, `textFieldKeepsStroke`, says which strokes a field keeps for itself; the host returns `ignored` for them when the primary focus sits under an `EditableTextState`, so Flutter's own text-editing shortcuts serve them. Only the ⌘-arrows depend on the field holding text: an empty box keeps pane focus and pane moves.

**Tech Stack:** Flutter 3.47.2 (Desktop `desktop/`), `flutter_test`.

**Spec:** Task #2010 brief (Scholes's Buddy 11-02): Mac Option+Left/Right by word; Cmd+Left/Right line start/end; Cmd+Up/Down text start/end; Shift selects; Option+Backspace deletes a word; Cmd+Backspace to line start; Ctrl+A/E/K. Windows Ctrl+arrows by word, Home/End, Ctrl+Backspace. Pane focus stays on Cmd+H/J/K/L and on the arrows when the box is empty or not focused; tab switching on Cmd+Option+arrows unchanged. Out: keymap editing, emoji, IME.

## Global Constraints

- Desktop only; no change to `app_shortcuts.dart` bindings, the keymap file format or the native menu.
- Never run a test that signs the Mac out of the real CLI; tests use `MemoryKeymap` and fake sessions.
- Format only the files touched (`dart format <files>`), never a folder.
- Picker and project menu contexts keep their own keys (`ctrl+j/k/n/p` navigate there).
- IME composition keeps today's path (`composing` cancels dispatch).

## Review Focus

1. Empty box: ⌘←/→/↑/↓ and ⇧⌘-arrows still focus and move panes (test `⌘-arrows still move panes while the box is empty`, both boxes plus the terminal composer).
2. A chord already pending (a prefix pressed first) must finish, not be cut by an editing key (`!_dispatch.hasPending` guard in the host).
3. Picker and project menu search fields still take Ctrl+K/J as "up/down" (context guard; covered by the existing `keymap_host_test.dart` picker tests, which must stay green).
4. Pane focus on ⌘H/J/K/L and tabs on ⌘⌥-arrows with text in the box (tests `⌘H/J/K/L still focus panes with text in the box` and `pane and tab keys work with focus outside a text field`).
5. Windows/Linux: Alt+arrows stay pane keys with text in the box (predicate test `Windows and Linux word moves...`).

---

### Task 1: The predicate

**Files:**
- Create: `desktop/lib/shortcuts/text_editing_keys.dart`
- Test: `desktop/test/text_field_editing_keys_test.dart` (group `which strokes a text field keeps`)

**Interfaces:**
- Produces: `bool textFieldKeepsStroke(KeyStroke? stroke, {required TargetPlatform platform, required bool hasText})`.

- [ ] **Step 1: Write the failing tests** — macOS list kept (`alt+left`, `cmd+shift+up`, `alt+backspace`, `cmd+backspace`, `ctrl+a/e/k`…), never kept (`cmd+h/j/k/l`, `cmd+alt+left/right`, `cmd+t`, `cmd+shift+backspace`, `ctrl+w`), ⌘-arrows only with `hasText`, Windows/Linux list (`ctrl+left`, `home`, `end`, `ctrl+backspace`…) and `alt+left` not kept.
- [ ] **Step 2: Run it, expect a compile failure** — `flutter test test/text_field_editing_keys_test.dart`.
- [ ] **Step 3: Implement the predicate** as a pure function of platform, modifiers and key name.
- [ ] **Step 4: Run it, expect PASS.**

### Task 2: The host gives the keys back

**Files:**
- Modify: `desktop/lib/shortcuts/keymap_host.dart` (`_handle`, before the `composing` check)
- Test: `desktop/test/text_field_editing_keys_test.dart` (groups `the message box and the thread reply box`, `the terminal composer`, and the outside-a-field test)

**Interfaces:**
- Consumes: `textFieldKeepsStroke`, `KeymapRegion.contextKind`, the `EditableTextState` already read for `value`.

- [ ] **Step 1: Write the failing widget tests** — for the Super Tab message box (`super-message-composer`), the thread reply box (`super-thread-composer`) and `TerminalComposer`: each listed key reaches the field (selection or text asserted), and no `pane.*` action runs; empty box keeps `pane.focus_left`, `pane.focus_below`, `pane.move_right`; ⌘H/L still run with text; focus on a button still runs pane, move and tab actions.
- [ ] **Step 2: Run them on main's host, expect FAIL** (record the assertion lines for the PR comment).
- [ ] **Step 3: Return `KeyEventResult.ignored`** when `value != null`, no chord is pending, the context is neither `picker` nor `project`, and the predicate keeps the stroke.
- [ ] **Step 4: Run the new file and `keymap_host_test.dart`, `keymap_dispatch_test.dart`, `terminal_composer_test.dart`, `windows_shortcuts_test.dart`, `shortcuts_test.dart`, expect PASS.**
- [ ] **Step 5: Commit** — `git add` the four files by name (no `node_modules`, no symlinks), then commit and open the PR with the privacy/concurrency/lifecycle checklist.
