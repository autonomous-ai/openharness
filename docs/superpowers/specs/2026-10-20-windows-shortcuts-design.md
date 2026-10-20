# Windows shortcuts: Ctrl where the Mac has ⌘

Status: implemented; 8/8 delegated live checks passed across recorded sources, 20 October 2026.
The Ctrl+backslash sidebar example remains excluded. Full Windows CI covers `38dde786e`; local
repair `9fcc9f769` has scoped Mac/Windows checks, an x64 release build, and live image confirmation.
Live testing used x64 under ARM64 emulation; native physical-x64 acceptance is not established.
See the [acceptance record](../../testing/windows-desktop-e2e.md#windows-shortcuts) for evidence and remaining limits.
Part of C (the Harness desktop on Windows), on `feat/windows-desktop`; merge and publication remain open.

## Why

People on Windows press Ctrl where Mac people press ⌘: Ctrl+T for a new tab, Ctrl+W to close it, Ctrl+N for
something new, Ctrl+F to find. The Windows desktop today takes Ctrl+**Shift** for nearly every command (⌘T →
Ctrl+Shift+T, ⌘W → Ctrl+Shift+W, ⌘N → Ctrl+Shift+N) and Alt+Shift for their shifted twins (⇧⌘T → Alt+Shift+T).
Only the tab digits and Settings take plain Ctrl. A Windows user who presses Ctrl+T gets nothing, or the key goes
to the terminal.

That scheme exists for a good reason (`desktop/lib/shortcuts/app_shortcuts.dart`, the comment on
`ctrlWorkspacePrefix`): inside a terminal, plain Ctrl+letter belongs to the program running there, such as
readline's ^A ^E ^K ^U ^W, PowerShell's ^C ^V ^Z ^Y ^L ^R, Claude Code's ^T ^O ^B ^G and Codex's ^T ^J. Harness
lives in terminals, so taking those keys would break the agents people run.

The owner's direction (2026-10-20): "win hay dung ctrl thay cho mac dung Cmd". Use VS Code as the reference, and
let the builder settle the details.

## How VS Code does it, and what Harness takes from it

- Outside the terminal, every ⌘ chord on the Mac is the same chord with Ctrl on Windows.
- Inside the integrated terminal, Ctrl+letter goes to the shell. A short, chosen list of app keys still wins there.
- Ctrl+C copies when text is selected and sends ^C when nothing is. Ctrl+V pastes.

Harness takes the same shape. The difference is that the current Windows table stays as the set of keys that work
everywhere, including inside a terminal.

## Goals

1. **Ctrl like the Mac's ⌘, outside a terminal.** Every Mac app shortcut written as ⌘ + a letter or symbol also
   answers to Ctrl + that key on Windows when focus is not in a terminal pane. Examples: Ctrl+T New Tab, Ctrl+W Close
   Tab, Ctrl+N New Harness, Ctrl+F Find, Ctrl+O Open Project, Ctrl+B Route task, Ctrl+R Reload, Ctrl+/ Shortcuts,
   Ctrl+\ sidebar, Ctrl+[ and Ctrl+] Back and Forward, Ctrl+H/J/K/L focus a pane, Ctrl+G find next. A ⇧⌘
   letter whose Ctrl+Shift form is free also answers to Ctrl+Shift + that letter. An alias is added only on a
   chord that no Goal 2 key uses. So ⇧⌘G (find previous) gets no Ctrl+Shift+G alias, because Ctrl+Shift+G is Find
   Next in the Goal 2 table, and Find Previous keeps Alt+Shift+G. A chord never means two things depending on
   focus.
2. **The current Windows keys keep working everywhere**, including inside a terminal. They are the keys a terminal
   user reaches for, in the style of Windows Terminal: Ctrl+Shift+T new tab, Ctrl+Shift+W close tab, Ctrl+Shift+F
   find, Ctrl+Shift+P palette, Alt+Shift for pane operations. Nobody who learned them loses them.
3. **Inside a terminal pane, plain Ctrl+letter goes to the program**, except the keys in Goal 4.
4. **App keys that win even in a terminal**, because no terminal program needs them, or Windows people expect them
   there:
   - Ctrl+1–9, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Up/Down (tabs);
   - Ctrl+, (Settings);
   - every Ctrl+Shift and Alt+Shift chord in the current Windows table.
5. **Copy and paste in a terminal, as in Windows Terminal and VS Code:**
   - Ctrl+C copies when text is selected, clears the selection, and sends nothing. With no selection it sends ^C,
     as today.
   - Ctrl+V pastes through Harness's paste (the one that also takes images), as Ctrl+Shift+V does today.
   - Ctrl+Shift+C, Ctrl+Shift+V and Ctrl+Shift+A keep working.
6. **Labels tell the truth.** A command's shortcut hint in the menu bar and in tooltips shows the key that works
   wherever focus is: the Goal 2 key. The Shortcuts sheet and the command palette show both, for example `Ctrl+T`
   and `Ctrl+Shift+T`, with the plain Ctrl one marked as working outside a terminal.
7. **Fixes found in the same code:**
   - The tab-number hints appear while Ctrl is held on Windows. Today they appear while the Win key is held
     (`swarm_screen.dart`, `isMetaPressed`).
   - The Windows menu bar's Edit menu has Cut, Copy, Paste and Select All. They act on the focused text field or
     terminal, as the keys do. Their hints follow focus, so the label is the key that works there:
     - in a text field: Ctrl+X, Ctrl+C, Ctrl+V and Ctrl+A;
     - in a terminal: Cut is disabled, Copy shows Ctrl+C, Paste shows Ctrl+V, and Select All shows Ctrl+Shift+A,
       because plain Ctrl+A is the program's.

     Only the Edit menu's hints change with focus.
   - The user keybindings file on Windows is `%APPDATA%\harness\keybindings.jsonc`, where VS Code keeps its own.
     The current path is `~/.config/harness/`. A file already at the old path is read when the new one does not
     exist.

## Where "in a terminal pane" begins and ends

- A terminal pane, for these rules, is the terminal view itself. The keymap's `KeymapContext.terminal` is the
  existing notion to build on.
- Everywhere else counts as outside: the sidebar, the New Harness composer, lists, Settings, dialogs, and the
  agent-message composer.
- The terminal composer is a text field with its own line editing. It keeps its keys:
  - the text-field keys below;
  - Ctrl+W and Ctrl+U, as today;
  - Ctrl+V pastes through Harness's paste, which takes images as well as text;
  - Ctrl+C copies a selection. With nothing selected it does what it does today.

  Every other Ctrl+letter runs the Goal 1 alias there, as in any text field. For example, Ctrl+T opens a new tab
  from the composer, so no key goes dead.
- The terminal view's find bar counts as outside: it is a text field.
- In a text field outside a terminal, the field's own editing keys win over Goal 1: Ctrl+A/C/V/X/Z/Y,
  Ctrl+←/→, Ctrl+Backspace/Delete and Ctrl+Home/End. No ⌘ command uses those keys on the Mac, so nothing is lost.
  Other Ctrl+letter keys (Ctrl+T, Ctrl+W…) do the app's command from a text field, as in a browser's address bar.

## Non-goals

- The Mac and Linux bindings do not change, and neither does the web app.
- No new commands. No change to which commands exist or to what they do.
- No change to the keymap file format, or to how custom bindings are recorded.
- No Win-key shortcuts. The Win key stays Windows' own.

## Anti-goals (a failure even if the keys work)

- A program inside a terminal loses a plain Ctrl+letter it uses today, other than Ctrl+C with a selection and
  Ctrl+V.
- A key does one thing in the menu label and another under the user's finger.
- A Windows user's custom binding in the keybindings file stops working after the update.
- A chord is bound to two commands in the same place.

## Constraints

- Ctrl+Alt is not used for new bindings. On many European layouts it is AltGr, which types characters.
- Ctrl+Enter, Ctrl+arrows and Ctrl+Backspace stay out of Goal 1. They are text and PowerShell editing keys. ⌘⏎ zoom
  and the ⌘-arrows keep their Goal 2 keys.
- ⌘Q has no Windows twin: Alt+F4 closes the window, and Quit stays in the tray menu.
- The repo is public, and docs are in English.

## Testing

- `test/windows_shortcuts_test.dart` grows to cover:
  - the Ctrl alias of every ⌘ command, outside a terminal;
  - that every Goal 2 key still binds;
  - that plain Ctrl+letter is not taken in the terminal context, except Ctrl+C with a selection and Ctrl+V;
  - no duplicate chord per context;
  - the labels (Goal 6).
- Terminal tests:
  - Ctrl+C with a selection copies and sends nothing; without one it sends ^C;
  - Ctrl+V pastes text and images.
- Text-field tests: Ctrl+A/C/V/X/Z in the New Harness composer edit text and do not run app commands.
- Tab hints appear on Ctrl on Windows.
- The keybindings path test for Windows, including the fallback to the old path.
- Mac and Linux shortcut tests stay green and unchanged.
- One live check on the Windows test PC with an agent running (Claude Code or Codex):
  - Ctrl+T, Ctrl+W and Ctrl+N from the sidebar;
  - Ctrl+R, Ctrl+W and Ctrl+U inside the terminal reach the agent or shell;
  - Ctrl+C with and without a selection;
  - Ctrl+V pastes;
  - the Edit menu.

## Custom keybindings

- The Goal 1 aliases are ordinary default bindings in the workspace context. They do not carry into the terminal
  context.
- Rebinding a command removes its defaults, including the alias, as the recorder's null rows already do. A rebound
  command does not get its alias back after an update.
- A user's own rows behave exactly as today. A custom `ctrl+k` row still fires inside a terminal, because the user
  chose it.

## Left to the builder

- How the terminal context gates the Goal 1 aliases: a second activator per command that is skipped in the
  terminal context, or a keymap context layer.
- The exact wording that marks the plain Ctrl key in the Shortcuts sheet and the palette.
- Whether the Edit menu's rows reuse the text-field intents or call the terminal's copy and paste directly.

## Calls made without asking

- Labels show the key that works everywhere (Goal 6), not the plain Ctrl one, so a menu never promises a key that
  a focused terminal swallows.
- Ctrl+V in a terminal pastes. Readline's literal-next (^V) is lost there, as in Windows Terminal and VS Code.
- The current Windows table is kept whole as the everywhere set, rather than redesigned.
- In the terminal composer, the text field's keys and its own Ctrl+W and Ctrl+U come first, and other Ctrl+letters
  are Goal 1 aliases. So the composer counts as outside for app keys. The earlier draft counted it as inside, which
  would have left Ctrl+T and other keys dead there.
- Ctrl+C with nothing selected in the composer does not start sending ^C. It stays as it is today, to keep the
  scope small.
- Edit menu hints follow focus; no other menu's hints do.
- Aliases are defaults: rebinding removes them, and users' own rows are unchanged.
