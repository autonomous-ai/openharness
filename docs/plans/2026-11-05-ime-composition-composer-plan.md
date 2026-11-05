# Typing Vietnamese, Japanese or Korean in a chat box never garbles (task #3245) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it.

**Goal:** A controller update that lands while an input method is composing (Telex, kana to kanji, jamo to syllable)
never replaces the chat box's value, so the input method and the box keep agreeing on what is typed.

**Architecture:** One small helper in `composer_tags.dart`, `SuperTabComposerWrites`, wraps a box's
`TextEditingController`. A programmatic write goes through it: with no composing range it applies at once, as today;
while a range is active it waits and runs once composing ends, recomputed from the box's text then and keeping the
caret (clamped). The main view's draft sync and its zip-path removal use it. The thread box has no draft sync and
none of its writes can land mid-composition (Task 2), so it is only tested. Switching to another conversation or
thread still replaces the box at once.

**Tech Stack:** Flutter (pinned 3.47.2), widget tests with `tester.testTextInput.updateEditingValue` on macOS.

**Spec:** task #3245 brief (Guide2's reading of task #3069: `view.dart` draft sync replaces the value mid-composition).

## Global Constraints

- Owned files only: `desktop/lib/super_tabs/view.dart`, `thread_panel.dart`, `composer_tags.dart`, `desktop/test/`.
- Desktop only, no visible UI change. Keep the @ picker and tag backspace stepping aside while composing, and the
  Enter-during-composition tests.

## Design

N/A because nothing is stored, synced or exposed: the draft is written exactly as before, only the moment a box is
overwritten moves to the end of a composition.

## Review Focus

- The deferred write never resurrects stale text over what the person typed after it (it reads the box and draft at
  apply time).
- Conversation and thread switches still replace the box at once and drop any waiting write.

## Task 1: The main composer keeps a composition through a controller update

**Files:** `desktop/test/super_tab_composer_ime_test.dart` (new), `desktop/lib/super_tabs/view.dart`,
`desktop/lib/super_tabs/composer_tags.dart`.

**Interfaces:** `bool superTabComposing(TextEditingValue)`; `SuperTabComposerWrites(TextEditingController)` with
`write(String? Function(String current))`, `cancel()`, `dispose()`.

- [ ] Test: Telex (`a`, `â`, `ấ`; `u`, backspace, `ư`), Japanese (`か`… `漢字`) and Korean (`ㅎ`, `하`, `한`) replayed
      after `@F ` in the main box, with a controller update carrying a lagging saved draft mid-composition. Each step's
      value (text and composing range) is intact; the committed text is the draft. Run, see it fail on main.
- [ ] Code: route the draft sync and the zip-path removal through `SuperTabComposerWrites`. Run, see it pass.
- [ ] Test (`super_tab_folder_drop_test.dart`): a folder zip that lands while `à` is composed replaces nothing until
      composing ends, then takes its path out. Red with main's `view.dart`, green with the change.

## Task 2: The thread box keeps a composition the same way

**Files:** the same test file.

- [ ] Test: the same compositions in the thread reply box with controller updates mid-composition.
- [ ] Finding: it passes on main and needs no code. The thread box has no draft sync; its programmatic writes are a
      thread switch (a deliberate replace), the clear after a sent reply (Enter does not send while composing, and a
      click on Send takes focus, which ends composing in `EditableText`) and the restore after a refused reply (only
      into an empty box). The test stays as the regression guard.

## Task 3: Unchanged behaviour

- [ ] Run the composer, thread panel and composer_tags tests (including `super_tab_view_test.dart` Enter during
      composition and `super_tab_composer_newline_test.dart`) and `make check-ui-style`.
