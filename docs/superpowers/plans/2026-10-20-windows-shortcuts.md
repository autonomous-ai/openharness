# Windows shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, every Mac ⌘ shortcut also answers to Ctrl when focus is outside a terminal. The current
Windows keys keep working everywhere. Inside a terminal, plain Ctrl+letter stays the program's, and Ctrl+C and
Ctrl+V copy and paste there as in Windows Terminal.

**Architecture:**
- **Aliases.** A Mac ⌘ chord's Ctrl twin is a new kind of default binding: `KeyBinding.outsideTerminal == true`.
  They are generated in the workspace context on native Windows only, and never on a chord another default already
  holds.
- **Resolution.** The resolved keymap keeps them like any default, so user rows, rebinding and conflict checks work
  unchanged.
- **Dispatch.** Dispatch skips an alias when focus is the terminal view itself (`aliasesBlocked`). The key then falls
  through to the terminal.
- **Hints.** Menu and tooltip hints never pick an alias.
- **Copy and paste.** The terminal's Ctrl+C/Ctrl+V handling and the Edit menu are separate tasks.

**Tech Stack:** Flutter desktop (`desktop/`), Dart, `flutter_test`, vendored xterm in `desktop/third_party/xterm`.

**Spec:** `docs/superpowers/specs/2026-10-20-windows-shortcuts-design.md`

## Global Constraints

- **Platforms.** Native Windows only: `!kIsWeb && defaultTargetPlatform == TargetPlatform.windows`, which is what
  `ctrlWorkspacePrefix` already tests.
  - macOS, Linux and web bindings, labels and behaviour do not change.
  - Their existing tests stay green unchanged.
- **The current Windows table stays.** Every chord pinned today in `desktop/test/windows_shortcuts_test.dart` keeps
  its command (Goal 2). No test line pinning an existing Windows chord is deleted or edited, except the assertions
  this plan replaces by name.
- **Which chords get an alias.** Starting from a Mac chord `⌘[⇧]key`:
  - **The rule:** the alias is `ctrl[+shift]+key`.
  - **No alias with Alt.** A Mac chord that has ⌥ gets none. Ctrl+Alt is AltGr on many European layouts.
  - **Excluded triggers:** arrows, Enter, numpad Enter, Backspace, Delete, Home, End, Tab, digits 1–9, comma, A, C,
    V, X, Z, Y.
  - **No collisions:** no alias on a chord that any other default binding already holds in the same context.
  - **Order:** aliases come after their command's Goal 2 keys.
- **Inside the terminal view**, plain Ctrl+letter reaches the program, except:
  - Ctrl+C with a selection, which copies;
  - Ctrl+V, which pastes.
- **Text fields in the terminal pane.** In the composer and the find bar:
  - text-field keys win;
  - Ctrl+W and Ctrl+U stay the composer's line editing;
  - other aliases work.
- **User keybindings.**
  - A user's own rows behave exactly as today.
  - Rebinding a command removes its alias, through the existing null rows.
- **Copy.**
  - Labels say Ctrl, Shift and Alt in full, joined with `+` (existing `describeKeyBinding`).
  - The Shortcuts sheet marks a plain-Ctrl alias as working outside a terminal. The exact wording is the builder's
    call, and it is in English.
- **Repo rules.**
  - Docs, comments and commit messages are in English.
  - The repo is public: no addresses, account names or passwords in commits or evidence.
  - Never bare `git stash`, never `git clean -fdx`.

## Review Focus

1. **Vietnamese and other IME input in the composer (Telex/VNI).** While composing, no alias fires, and Ctrl+W and
   Ctrl+U still edit. `KeymapDispatch` already returns early on `composing`. Task 2 pins it for an alias.
2. **A user keybindings file that already binds an alias chord**, for example `ctrl+t` to another command. The
   user's row wins everywhere, including inside the terminal. Pinned in Task 1 (resolution) and Task 2 (dispatch).
3. **A pane whose control was taken by another machine (`_inputBlocked`).** Ctrl+C with a selection still copies.
   Ctrl+V does not paste into a pane this window does not control: it behaves as Ctrl+Shift+V does there today.
   Pinned in Task 4.
4. **Holding a key down.** Holding Ctrl+W outside a terminal closes one tab, not a run of them, because aliases
   inherit the command's `repeatable` flag. Pinned in Task 2.
5. **A Ctrl+C with a selection that ends on an empty line, or a whitespace-only selection.** It still copies and
   sends no ^C. A program that is mid-prompt never receives a stray interrupt. Pinned in Task 4.

---

### Task 1: Generate the Ctrl aliases as default bindings

**Files:**
- Modify: `desktop/lib/shortcuts/keymap.dart`:
  - `KeyBinding` gains `final bool outsideTerminal` (default `false`);
  - `_KeyNode` and `KeymapMatch` carry it.
- Modify: `desktop/lib/shortcuts/app_shortcuts.dart`: add `String? windowsCtrlAlias(SingleActivator mac)`.
- Modify: `desktop/lib/shortcuts/keymap_commands.dart`:
  - `HarnessCommand` gains `List<String> get outsideTerminalKeys`;
  - `harnessDefaultBindings` appends them with `outsideTerminal: true`, after dropping any whose sequence another
    default already holds in that context.
- Test: `desktop/test/windows_shortcuts_test.dart`, `desktop/test/keymap_edit_test.dart`

**Interfaces:**
- Produces:
  - `KeyBinding({..., bool outsideTerminal = false})`, with the field `outsideTerminal`.
  - `KeymapMatch.outsideTerminal` (`bool`, default `false`). It is true when the matched node's binding is an alias.
  - `String? windowsCtrlAlias(SingleActivator mac)`:
    - returns a keymap string such as `'ctrl+t'` or `'ctrl+shift+i'`;
    - returns `null` for a non-⌘ chord, a chord with ⌥, or an excluded trigger (Global Constraints);
    - is platform-independent and pure.
  - `HarnessCommand.outsideTerminalKeys`:
    - empty unless `ctrlWorkspacePrefix`;
    - for an `action` command, the aliases of that action's Mac activators in `kAppShortcuts`/`kSwarmShortcuts`;
    - for an `extraKeys` command, the aliases of its `cmd+…` strings.

- [ ] **Step 1: Write the failing tests** in `windows_shortcuts_test.dart`, under Windows (the file's `setUp`).
  Replace the test `'every plain Ctrl+letter stays with the terminal'` with these two tests.

```dart
test('outside a terminal, Ctrl does what ⌘ does on the Mac', () {
  for (final (keys, id) in [
    ('ctrl+t', 'swarm.new'), ('ctrl+w', 'swarm.close'), ('ctrl+n', 'agent.new'),
    ('ctrl+f', 'terminal.find'), ('ctrl+g', 'terminal.find_next'), ('ctrl+o', 'agent.open'),
    ('ctrl+r', 'machines.refresh'), ('ctrl+slash', 'keyboard.help'), ('ctrl+p', 'harnesses.list'),
  ]) {
    expect(command(keys), id, reason: keys);
  }
  // Goal 2 keys are untouched and still win their chords.
  expect(command('ctrl+shift+g'), 'terminal.find_next');
  expect(command('alt+shift+g'), 'terminal.find_previous');
  expect(command('ctrl+shift+t'), 'swarm.new');
  expect(command('ctrl+shift+w'), 'swarm.close');
});

test('no alias on text, word-motion or AltGr keys', () {
  for (final keys in ['ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y',
      'ctrl+left', 'ctrl+right', 'ctrl+up', 'ctrl+down', 'ctrl+enter', 'ctrl+backspace',
      'ctrl+shift+c', 'ctrl+shift+v', 'ctrl+shift+a', 'alt+enter', 'alt+backspace']) {
    expect(command(keys), isNull, reason: keys);
  }
  expect(harnessDefaultBindings.where((b) => b.outsideTerminal &&
      b.keys.any((k) => k.alt)), isEmpty);
  expect(windowsCtrlAlias(const SingleActivator(LogicalKeyboardKey.keyT, meta: true, alt: true)), isNull);
});
```

  The ids above were read from `keymap_commands.dart` on 2026-10-20.

  Add a golden test: `'the alias list'`. It pins the full sorted list of `'<sequence> <command>'` for every
  `outsideTerminal` binding.
  - Write it after Step 3 by printing the list once.
  - Review every line against the Global Constraints, then pin it.
  - Record the list in the ledger.

  In `keymap_edit_test.dart`, add `'rebinding a Windows command drops its Ctrl alias'`:
  - under Windows, `rebindBindings` for `swarm.new` to `ctrl+shift+y` (context workspace) yields a null row for
    `ctrl+t`;
  - the resolved keymap no longer matches `ctrl+t`.

  Add a test for a user row (Review Focus 2): a `KeymapConfig` row `ctrl+t → pane.zoom` resolves `ctrl+t` to
  `pane.zoom` in the workspace and terminal contexts.

  Add Mac and Linux guards: under `TargetPlatform.macOS` and `TargetPlatform.linux`,
  `harnessDefaultBindings.where((b) => b.outsideTerminal)` is empty.

- [ ] **Step 2: Run them and see them fail**

  Run: `cd desktop && flutter test test/windows_shortcuts_test.dart test/keymap_edit_test.dart`

  Expected: FAIL. `windowsCtrlAlias` and `outsideTerminal` are undefined.

- [ ] **Step 3: Implement**
  - `windowsCtrlAlias` uses `keyStrokeFor(...)` to name the key.
  - `outsideTerminalKeys` is described in Interfaces.
  - `harnessDefaultBindings` appends aliases per command after its `keys`. It skips a sequence any non-alias
    default holds in the same context, and any sequence an earlier alias took.
  - `ResolvedKeymap` copies `outsideTerminal` from the effective binding onto its `_KeyNode`, and `match()` returns
    it in `KeymapMatch`.

- [ ] **Step 4: Run them and see them pass, and Mac/Linux stay green**

  Run: `cd desktop && flutter test test/windows_shortcuts_test.dart test/keymap_edit_test.dart test/shortcuts_test.dart test/keymap_dispatch_test.dart`

  Expected: PASS. The existing `'no two Windows defaults share a chord in one context'` passes with aliases
  included.

- [ ] **Step 5: Commit**

```bash
git add desktop/lib/shortcuts/keymap.dart desktop/lib/shortcuts/app_shortcuts.dart desktop/lib/shortcuts/keymap_commands.dart desktop/test/windows_shortcuts_test.dart desktop/test/keymap_edit_test.dart
git commit -m "feat(windows): Ctrl does what ⌘ does on the Mac, outside a terminal"
```

### Task 2: Skip aliases when the terminal view has focus

**Files:**
- Modify: `desktop/lib/shortcuts/keymap_dispatch.dart`: `dispatch(...)` gains `bool aliasesBlocked = false`.
- Modify: `desktop/lib/shortcuts/keymap_host.dart`: computes `aliasesBlocked`.
- Test: `desktop/test/keymap_dispatch_test.dart`, `desktop/test/keymap_host_test.dart`

**Interfaces:**
- Consumes: `KeymapMatch.outsideTerminal` (Task 1).
- Produces:
  - `KeymapDispatch.dispatch({..., bool aliasesBlocked = false})`. A match with `outsideTerminal && aliasesBlocked`
    is treated as no match. The key is not consumed, and a pending sequence is cancelled as for any other non-match.
  - `const composerOwnedStrokes = {KeyStroke('w', control: true), KeyStroke('u', control: true)}` in
    `keymap_host.dart`.

- [ ] **Step 1: Write the failing tests**
  - `keymap_dispatch_test.dart`: `'a Ctrl alias is left to the terminal when aliases are blocked'`. A resolved map
    with an alias `ctrl+t → swarm.new`:
    - `dispatch(... aliasesBlocked: true)` returns `handled: false, command: null`;
    - with `aliasesBlocked: false` it returns `command: 'swarm.new'`;
    - a non-alias binding on another chord is unaffected by `aliasesBlocked`;
    - with `composing: true` an alias returns `handled: false` (Review Focus 1);
    - a repeat of a non-repeatable alias returns `command: null` (Review Focus 4).
  - `keymap_host_test.dart`, under Windows, three widget tests:
    - `'Ctrl+T in the terminal view reaches the terminal'`. A `KeymapRegion(contextKind: terminal)` with a focused
      non-text `Focus`: sending Ctrl+T does not run `swarm.new`, and the event reaches the child's `onKeyEvent`.
    - `'Ctrl+T in the terminal composer opens a tab, Ctrl+W edits the line'`. The same region with a focused
      `TextField`: Ctrl+T runs `swarm.new`; Ctrl+W does not run `swarm.close`.
    - `'a user row on Ctrl+T still runs in the terminal view'`. A user row `ctrl+t → pane.zoom` runs `pane.zoom` in
      the terminal view (Review Focus 2).

- [ ] **Step 2: Run them and see them fail**

  Run: `cd desktop && flutter test test/keymap_dispatch_test.dart test/keymap_host_test.dart`

  Expected: FAIL. The parameter `aliasesBlocked` is undefined.

- [ ] **Step 3: Implement.** In `_KeymapHostState._handle`, set `aliasesBlocked` to:

```
region?.contextKind == KeymapContext.terminal &&
(value == null || composerOwnedStrokes.contains(keyStrokeForEvent(event)))
```

  Here `value` is the existing `EditableTextState` controller value, null when focus is not a text field. Pass it
  to `dispatch`.

- [ ] **Step 4: Run them and see them pass**

  Run: `cd desktop && flutter test test/keymap_dispatch_test.dart test/keymap_host_test.dart test/windows_shortcuts_test.dart`

  Expected: PASS.

- [ ] **Step 5: Commit**: `feat(windows): Ctrl+letter stays the program's inside a terminal`

### Task 3: Labels never promise an alias; the sheet and palette list it

**Files:**
- Modify: `desktop/lib/shortcuts/app_keymap.dart`: `hint`, `effectiveShortcutHint`, `effectiveCommandHint` and
  `effectiveShortcutRows` skip `outsideTerminal` bindings when they pick the one hint.
- Modify: `desktop/lib/shortcuts/keymap_native.dart`: `nativeKeymapSnapshot` omits `outsideTerminal` bindings. The
  in-window menu bar's hints come from this snapshot (`SwarmMenuBus._parseHints`).
- Modify: `desktop/lib/shortcuts/shortcuts_browser.dart` (the Shortcuts sheet) and the command palette's key column
  (`desktop/lib/widgets/swarm_switcher.dart`). They list a command's alias after its other keys, with the
  outside-a-terminal marker.
- Test: `desktop/test/windows_shortcuts_test.dart`, `desktop/test/shortcuts_browser_test.dart`,
  `desktop/test/swarm_switcher_test.dart`, `desktop/test/in_window_menu_bar_test.dart`

**Interfaces:**
- Consumes: `KeyBinding.outsideTerminal` (Task 1).
- Produces: none new.

- [ ] **Step 1: Write the failing tests**, under Windows:
  - `effectiveCommandHint(context, 'swarm.new')` is `'Ctrl+Shift+T'`.
  - `nativeKeymapSnapshot(...)` has no entry whose `keys` is `['ctrl+t']`.
  - The Shortcuts sheet's New Tab row shows `Ctrl+Shift+T` and `Ctrl+T` with the marker.
  - The palette's New Tab row shows both.
  - The menu bar's New Tab row hint is `Ctrl+Shift+T`.
- [ ] **Step 2: Run and see them fail**

  Run: `cd desktop && flutter test test/windows_shortcuts_test.dart test/shortcuts_browser_test.dart test/swarm_switcher_test.dart test/in_window_menu_bar_test.dart`

  Expected: FAIL. Hints and the snapshot include `ctrl+t`, or the alias is not listed.
- [ ] **Step 3: Implement** as listed under Files.
- [ ] **Step 4: Run the same command**

  Expected: PASS. Run `test/shortcuts_deck_test.dart test/keyboard_practice_test.dart` as well; both are green.
- [ ] **Step 5: Commit**: `feat(windows): shortcut hints show the key that works everywhere`

### Task 4: Ctrl+C copies a selection and Ctrl+V pastes, in the terminal

**Files:**
- Modify: `desktop/lib/widgets/terminal_panel.dart`, `_onTerminalKey`.
- Modify: `desktop/lib/shortcuts/app_shortcuts.dart`, `kTerminalOwnedKeys`. The Windows variant lists Ctrl+V
  (paste) and describes Ctrl+C as "Copy the selection, or interrupt".
- Test: `desktop/test/terminal_clipboard_test.dart`, `desktop/test/windows_shortcuts_test.dart`

**Interfaces:**
- Consumes: the existing `_controller.selection`, `widget.session.terminal.buffer.getText`, `_paste()` and
  `_inputBlocked`.
- Produces: none.

- [ ] **Step 1: Write the failing tests** in `terminal_clipboard_test.dart`, under Windows:
  - `'Ctrl+C with a selection copies and sends nothing'`. After the key: the clipboard holds the selected text, the
    selection is cleared, and the session wrote no bytes.
  - `'Ctrl+C with only spaces selected still copies'` (Review Focus 5).
  - `'Ctrl+C without a selection sends ^C'`. The session writes `\x03`.
  - `'Ctrl+V pastes as Ctrl+Shift+V does'`. `_paste` runs and no `\x16` is written.
  - `'a pane this window does not control: Ctrl+C copies a selection, Ctrl+V behaves as Ctrl+Shift+V does'`
    (Review Focus 3).
  - A macOS guard: ⌘C and ⌘V are unchanged, and Ctrl+V on macOS is not intercepted.
- [ ] **Step 2: Run and see them fail**

  Run: `cd desktop && flutter test test/terminal_clipboard_test.dart`

  Expected: the new Windows cases FAIL.
- [ ] **Step 3: Implement** in `_onTerminalKey`, native Windows only:
  - **Ctrl+C** (no Shift, Alt or Meta) with a non-null selection: copy as `_copyOrPaste` does and return `handled`.
    With no selection, return `ignored`, so xterm sends ^C as today.
  - **Paste:** the `pasting` condition accepts Ctrl+V with or without Shift.

  In the Windows `kTerminalOwnedKeys` list, keep `Ctrl+Shift+C/V/A`, and update the `windows_shortcuts_test.dart`
  expectation to include `Ctrl+V`.
- [ ] **Step 4: Run them and see them pass**

  Run: `cd desktop && flutter test test/terminal_clipboard_test.dart test/windows_shortcuts_test.dart test/terminal_view_interaction_test.dart`

  Expected: PASS.
- [ ] **Step 5: Commit**: `feat(windows): Ctrl+C copies a selection and Ctrl+V pastes in a terminal`

### Task 5: Ctrl+V in the terminal composer takes an image too

**Files:**
- Modify: `desktop/lib/widgets/terminal_composer.dart`: new `final Future<void> Function()? onPasteNonText`.
  - On native Windows, a Ctrl+V when the clipboard has no text calls it and consumes the key.
  - With text on the clipboard, the field pastes as today.
- Modify: `desktop/lib/widgets/terminal_panel.dart`: passes `onPasteNonText: _paste`.
- Test: `desktop/test/terminal_composer_test.dart`

**Interfaces:**
- Produces: `TerminalComposer({..., Future<void> Function()? onPasteNonText})`.

- [ ] **Step 1: Write the failing tests**, under Windows:
  - `'Ctrl+V with text pastes into the field'`. With a mocked clipboard holding text, the field contains it and
    `onPasteNonText` was not called.
  - `'Ctrl+V with no text hands the paste to the pane'`. With a clipboard that has no text, `onPasteNonText` was
    called once and the field is unchanged.
  - A macOS guard: ⌘V is unchanged.
- [ ] **Step 2: Run and see them fail**

  Run: `cd desktop && flutter test test/terminal_composer_test.dart`

  Expected: FAIL. The parameter `onPasteNonText` is undefined.
- [ ] **Step 3: Implement.** Intercept Ctrl+V in the composer's key handling. Check `Clipboard.hasStrings()`. If
  true, invoke the field's own `PasteTextIntent`; otherwise call `onPasteNonText`.
- [ ] **Step 4: Run the same command, plus `test/terminal_clipboard_test.dart`**

  Expected: PASS.
- [ ] **Step 5: Commit**: `feat(windows): Ctrl+V in the terminal composer takes an image too`

### Task 6: The Windows Edit menu gains Cut, Copy, Paste and Select All

**Files:**
- Modify: `desktop/lib/widgets/in_window_menu_bar.dart`, `_buildEditMenu`. Add four rows above Find:
  - Cut, Copy, Paste and Select All;
  - keys `menu-bar-cut`, `menu-bar-copy`, `menu-bar-paste` and `menu-bar-select-all`;
  - a divider after them;
  - native Windows only; Linux keeps its current menu.
- Modify: `desktop/lib/widgets/terminal_panel.dart`. Expose the focused terminal's copy, paste and select-all to
  the menu. Use the same entry points the keys use: copy the selection, `_paste()`, and xterm select-all.
- Test: `desktop/test/in_window_menu_bar_test.dart`

**Interfaces:**
- Produces: `enum EditMenuTarget { textField, terminal, none }`, computed from
  `FocusManager.instance.primaryFocus`:
  - an `EditableTextState` ancestor is `textField`;
  - a terminal view's focus node is `terminal`;
  - anything else is `none`.

  The rows dispatch:
  - for a text field: `CopySelectionTextIntent.cut`, `CopySelectionTextIntent.copy`, `PasteTextIntent` and
    `SelectAllTextIntent` through `Actions.invoke` on the focused context;
  - for a terminal: the panel's copy, paste and select-all.

- [ ] **Step 1: Write the failing tests**, under Windows, forcing the bar visible as the file's other tests do:
  - With a focused `TextField`:
    - the rows' hints are `Ctrl+X`, `Ctrl+C`, `Ctrl+V` and `Ctrl+A`;
    - Copy puts the selected text on the clipboard;
    - Select All selects the field.
  - With a focused terminal:
    - Cut is disabled;
    - the hints are `Ctrl+C`, `Ctrl+V` and `Ctrl+Shift+A`;
    - Copy copies the terminal selection.
  - With nothing focused, all four rows are disabled.
  - A Linux guard: no Cut row.
- [ ] **Step 2: Run and see them fail**

  Run: `cd desktop && flutter test test/in_window_menu_bar_test.dart`

  Expected: FAIL, with no `menu-bar-cut`.
- [ ] **Step 3: Implement.** Update the class doc comment's sentence about Edit lacking Cut/Copy/Paste, so it says
  that Windows has them and why.
- [ ] **Step 4: Run the same command**

  Expected: PASS.
- [ ] **Step 5: Commit**: `feat(windows): Edit menu has Cut, Copy, Paste and Select All`

### Task 7: Tab-number hints appear on Ctrl

**Files:**
- Modify: `desktop/lib/screens/swarm_screen.dart`, `_noteKey` (`_tabShortcutHints.value = …`, near line 4646).
  - On native Windows, the hint follows `isControlPressed` with no other modifier.
  - Elsewhere it follows `isMetaPressed`, as today.
  - Extract the decision as `bool showsTabShortcutHints(HardwareKeyboard keyboard)` in `app_shortcuts.dart`, so it
    is testable without the screen.
- Test: `desktop/test/windows_shortcuts_test.dart`

- [ ] **Step 1: Write the failing test** `'tab hints follow Ctrl on Windows and ⌘ on the Mac'`:
  - under Windows: Ctrl alone → true; Ctrl+Shift → false; Win alone → false;
  - under macOS: ⌘ → true; Ctrl → false.
- [ ] **Step 2: Run and see it fail**

  Run: `cd desktop && flutter test test/windows_shortcuts_test.dart`

  Expected: FAIL. `showsTabShortcutHints` is undefined.
- [ ] **Step 3: Implement, and use it in `_noteKey`.**
- [ ] **Step 4: Run the same command**

  Expected: PASS.
- [ ] **Step 5: Commit**: `fix(windows): tab-number hints appear while Ctrl is held`

### Task 8: The keybindings file lives in %APPDATA% on Windows

**Files:**
- Modify: `desktop/lib/shortcuts/keymap_store.dart`.
  - `defaultPath({Map<String, String>? environment, bool? isWindows})` returns `<APPDATA>\harness\keybindings.jsonc`
    on Windows when `APPDATA` is an absolute path, and falls back to today's rule otherwise.
  - New `static String? legacyPath({Map<String, String>? environment, bool? isWindows})` returns today's
    `~/.config/harness/keybindings.jsonc` on Windows, and `null` elsewhere.
  - **Reading:** the store reads `legacyPath` when the default path does not exist.
  - **Writing:** a write always goes to the default path. The first write copies the legacy file's content in
    first, and leaves the legacy file in place.
- Test: `desktop/test/keymap_store_test.dart`

- [ ] **Step 1: Write the failing tests**, using a temp dir as `APPDATA` and as the home:
  - `defaultPath(environment: {'APPDATA': r'C:\Users\u\AppData\Roaming', 'USERPROFILE': r'C:\Users\u'}, isWindows: true)`
    is `r'C:\Users\u\AppData\Roaming\harness\keybindings.jsonc'`.
  - The macOS and Linux paths are unchanged.
  - A store with only the legacy file loads its rows.
  - The first rebind writes the new file containing the legacy rows plus the new one, and the legacy file is
    unchanged.
- [ ] **Step 2: Run and see them fail**

  Run: `cd desktop && flutter test test/keymap_store_test.dart`

  Expected: FAIL.
- [ ] **Step 3: Implement.** Also update the "Edit keybindings" action so it opens the default path. The new file
  is created from the legacy one first if only the legacy file exists.
- [ ] **Step 4: Run the same command, plus `test/keymap_edit_test.dart`**

  Expected: PASS.
- [ ] **Step 5: Commit**: `feat(windows): keybindings.jsonc lives in %APPDATA%\harness`

### Task 9: Docs, one Windows CI run, and the live check

**Files:**
- Modify:
  - `desktop/CLAUDE.md`, the Windows shortcut paragraph near line 797: add the alias rule and the terminal
    copy/paste.
  - The spec's status line.
  - `docs/testing/windows-desktop-e2e.md`: add a short "Windows shortcuts" section with the live check results.

- [ ] **Step 1: Mac suite.**

  Run: `cd desktop && flutter analyze && flutter test --reporter=failures-only`

  Expected:
  - analyze reports no new errors or warnings in changed files;
  - the test run's failures are only the documented baseline. Compare against `origin/feat/windows-desktop` at
    this plan's base. A failure that load causes ("Failed to load … flutter_tester") is rerun alone.
- [ ] **Step 2: Push, then one Windows run.**
  - Push `feat/windows-desktop`.
  - Run `gh workflow run windows-desktop.yml --repo autonomous-ai/openharness --ref feat/windows-desktop` once.
  - Watch it with `gh run watch <id> --exit-status`.

  Expected: both `build-test` jobs succeed, with no new failures against `desktop/test/windows_known_failures.txt`.
- [ ] **Step 3: Live check on the x64 test PC.** Ask the owner first. Install the branch's build there, either from
  a staging release with the owner's OK or from the CI artifact.

  **Person:** the owner runs a Claude Code or Codex harness and checks each item below, then reports the results.
  1. From the sidebar or the New Harness composer: Ctrl+T opens a tab, Ctrl+W closes it, and Ctrl+N opens New
     Harness.
  2. Inside the terminal: Ctrl+R, Ctrl+W and Ctrl+U reach the shell or agent.
  3. Inside the terminal: Ctrl+Shift+T opens a tab.
  4. Ctrl+C with a selection copies; without one it interrupts.
  5. Ctrl+V pastes text, and a screenshot reaches the agent.
  6. In the composer: Ctrl+T opens a tab and Ctrl+W deletes a word.
  7. The Edit menu's four rows work in a text field and in a terminal.
  8. Holding Ctrl shows the tab numbers.

  Record pass or fail for each item in the e2e doc. No addresses, accounts or screenshots with private content.
- [ ] **Step 4: Commit**: `docs(windows): record the Windows shortcut rule and its live check`
