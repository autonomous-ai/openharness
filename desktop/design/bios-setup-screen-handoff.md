# New Harness and Open Harness as BIOS screens — handoff

Branch: `feat/centered-new-harness-palette`. Written 2026-09-23.

## Why this exists

The team said the bottom command dock was "too hard to use": every answer was
a trip into a sub-list and back. The replacement is a **BIOS setup utility** —
one screen holding every answer, changed where it stands, keyboard only.

That reference was chosen deliberately and researched. What separates a BIOS
screen from an ncurses dialog is that **the screen is the chrome**: values sit
bracketed at a fixed column, the selection is inverse video rather than a
marker glyph, the key legend never moves, and nothing is a button. `dialog`,
`whiptail` and `menuconfig` read as TUI rather than BIOS precisely because
they are a centred rounded box with a drop shadow and `<Select> <Exit>`.

Three earlier designs were rejected, and the reasons still apply:

- **A unified fuzzy list** where Return means "start" on one row and "set" on
  another. Same key, two verbs, one surface. This is Spotlight behaviour, not
  fzf behaviour.
- **A shell-style command line** (`claude ~/code/foo -b main -w`). It looks
  like a shell, so it inherits a contract it cannot honour — people reach for
  `Ctrl-R`, `!$`, globs, history. k9s users filed exactly that request against
  its `:` prompt. Positional grammar also cannot work here: branch candidates
  depend on which project is selected, so `-b main` cannot be typed before the
  project resolves.
- **Phoenix's `-`/`+` for changing values.** Folder and branch names are full
  of hyphens; a screen that swallows one to nudge a value is broken for the
  thing people type most. `PgUp`/`PgDn` keep the convention instead.

## The key model (do not quietly change this)

| Key | On the items | With the list live |
| --- | --- | --- |
| `↑↓` | move between rows | move within the list |
| `←→` | change the focused value in place | — |
| `↵` | **Pick from List** — hand the arrows to the right column | take the value |
| `Esc` | close | back to the items |
| `Tab` | walk the rows | walk the list |
| typing | fuzzy search the focused row | narrow further |

Two rules hold it together:

1. **Only `[ New Harness ]` starts an agent.** Return on a value row never
   launches. This was an explicit request after a stray Return started work.
2. **The bright bar marks which column has the keys.** Full inverse video is
   where the arrows are; a dim bar means "this is the current value" on the
   side that is only showing. The idle column's text greys out too. A test
   counts the bright bars and asserts there is never more than one.

`Tab` is handled explicitly because unhandled it runs Flutter's focus
traversal, which moves focus *out* of the form and leaves it deaf to every
later key. That looked like a freeze and took a while to find.

## Files

| File | What it holds |
| --- | --- |
| `lib/widgets/new_harness_form.dart` | The whole ⌘N screen. New. |
| `lib/state/new_harness.dart` | `stepValues()` and `applyOption()` added; rest untouched. |
| `lib/screens/swarm_screen.dart` | Mounts the form; ⌘O overlay geometry and scrim. |
| `lib/widgets/swarm_switcher.dart` | ⌘O results/preview split. |
| `lib/widgets/box_chrome.dart` | `boxMonoStyle` now follows the terminal's size. |
| `test/new_harness_form_test.dart` | 32 tests, all key paths. New. |

### The one controller subtlety

`stepValues()` returns a field's values in a **stable** order. The displayed
list re-ranks the chosen row to the front, so stepping through *that* by index
walks in circles — right always took the second row, left always wrapped to
the last. The form captures a wheel on focus and steps through that instead.

Synthetic rows are not all the same thing. `Clone`, `Open Folder`,
`New Project` and `Change Machine` are **doors**: they open a prompt or the
system chooser. `Create branch x` is synthetic too and is a genuine **answer**.
`_doors` names them explicitly; inferring from `synthetic` broke branch
creation.

## What is left

1. **73 test failures**, the blocker for merging. 67 come from tests that
   drive the old dock (`NewHarnessBox`), which the form replaces; ~6 from the
   `CommandDock` centering. The old dock is still mounted-but-unused in
   `swarm_screen.dart` behind an `ignore: unused_local_variable` so those
   tests still compile — deleting it is step one. Measured baselines: 25
   `grid_model_picker_test` failures predate this work and fail on clean main.
   The `boxMonoStyle` change will also have moved the typography tests; that
   has not been measured.
2. **⌘O sorting.** Rows are grouped by tab (tab row, then its agents) by
   `rankSwarmLocations`. The ask is a flat most-recent-first order. That
   function is shared with ⌘P and the splits, so it needs a decision: change
   it for everyone, or fork a navigation-only ordering.
3. **⌘O's interior is not BIOS yet.** Only the frame, ordering and geometry
   changed. The rows, hints bar and count still use the old search styling —
   no `>` prompt with block cursor, no bracketed values, no bottom-left
   legend.
4. **`boxMonoStyle`'s blast radius.** It is shared by every box over the
   terminals, including the non-terminal variants of the switcher and preview.
   No live caller of those was found, but none was proven absent either.
5. **The browse surface** opened by `Open Folder` still uses the fixed UI font.

## Two process notes that cost real time

- **Write the widget test before rebuilding.** Every bug the user found by
  hand — arrows not stepping, search looking broken, the list not moving — was
  reachable from a test that sends real key events. The first such test caught
  six failures in one run, three of which had already been reported.
- **Scripted `str.replace` edits must assert their anchor.** Three silently
  matched nothing after an earlier edit moved the text, so changes were
  reported that never reached the file, and the wrong code got debugged.
