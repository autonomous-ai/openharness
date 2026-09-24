# New Harness setup and minimal Open Harness picker — handoff

Branch: `feat/centered-new-harness-palette`. Updated 2026-09-23.

## Latest review direction

The user reviewed the first BIOS version of ⌘O and explicitly asked to remove
`Harness:` labels, brackets and all arrow instructions, pointing to fzf in Vim:
"clean, minimal but functional. less is better". **This supersedes the BIOS
presentation requirements for Open Harness below.** The first simplification
was too sparse; the user then requested machine, repository, branch and last
activity, and asked that New Harness look different from session names.

The final ⌘O list has a plain title and subdued highlight, a small engine mark,
a machine/repository/branch line, and elapsed activity at the right.
New Harness is a plus-marked action separated from sessions by a rule.
The next review removed the match count entirely and asked for typography
and spacing identical to the terminal. Titles, metadata, activity, input and
preview now use the renderer's selected face, size and line height, with no
inherited UI tracking. Secondary details and their glyphs are muted gray,
without the repository/branch accent colors. The preview stays available.
The subsequent review found the rows too crowded. Sessions now have 12 px
above and below their two text lines and a 4 px title/context gap, with wider
horizontal insets. The preview uses 24 px margins and section separation;
terminal font metrics remain unchanged.
The latest review asked why the visible ages were out of order. ⌘O now sorts
by the displayed last-activity timestamp, newest first, rather than by opening
history. Filtering retains that order, and catalog updates retain the selected
session. Unknown timestamps follow dated sessions; visit history only breaks
ties. Search remains at the top.

The user approved ⌘O's UI/UX and asked to carry its typography, spacing and
colors to ⌘N. Creation shares its terminal font metrics, muted labels,
generous padding and subdued selection. The subsequent review asked for
less unused space: ⌘N now has its own 960 × 480 frame, growing by up to 25%
with larger terminal text and clamping to the window. Fields and choices
use a 55:45 split while retaining their row spacing. Field values have no
brackets or punctuation; the start action has a plus mark and accent.
The arrow legend and More options / F2 footer are gone, including the
hard-coded F2 shortcut. The existing remappable Cmd+. advanced-form action
remains available. Wide windows keep fields and choices side by side;
narrow windows give the active list full width with a back action. Search
stays above its scrolling choices. Field/value clicks work alongside the
existing keyboard contract.
The next refinement makes project, machine, branch and approval choices a
single line. Machines show their names; only the local machine has a muted **This machine**
note. Folder paths and branch metadata remain searchable without being
printed below every choice. Profile appears only for the selected agent when
it uses Codex profiles; merely browsing other agents does not move the fields.
Field navigation skips the hidden Profile row in both directions.

The latest review adds icons to Clone Repository, Open Folder, and New Project.
Open Folder leads to the short Folder path prompt with a Browse Folder action.
GitHub URL and Project name prompts are short too. Pasting works with Cmd-V or
Ctrl-V, and accepted paths, URLs, and names return to Project. Delayed clipboard
replies cannot overwrite a different field or newly typed input. Backspace
removes a complete Unicode character. The idle right pane has no highlight;
the active list keeps its keyboard highlight. The cursor sits beside its hint
without an extra space. Pending Git discovery does not flash a false non-Git
message. Unavailable choices explain why they cannot be used.
This supersedes the historical BIOS presentation described below.

## Latest verification and native review

See [picker-verification.md](picker-verification.md) for the scenario matrix,
measured coverage, native observations, exact run artifacts and limitations.
The latest full suite is **3,010 passed, 12 skipped, 17 pre-existing failures**.
Two randomized affected repeats (seeds 924 and 925) each pass **260 tests**.
Seven isolated native creation fixtures passed again. New Harness form line
coverage is **97.6%**, not 100%; controller coverage is **93.7%**.

The repeat audit added 29 edge-case regressions and fixed composing-text keys
being taken by Cmd-N, native menu/search commands bypassing composition guards,
and unhandled folder-browser failures. It also exercises installation and Git
failure/retry/disposal, delayed clipboard selection changes, duplicate Start
and carried-task limits. The final full run's failed test names match the prior
17-test baseline exactly. Build 7 (`harness-picker-review-build-7.log`) was
rebuilt and restarted; the project prompts, agent-specific settings, Worktree,
machine labels and Cmd-O branch widths passed another hands-on review.

The native audit replaced the simulated query editor with a real text field,
removed the nine-option scroll limit, fixed acceptance/focus after project
prompts, and corrected stale agent preview, stale machine error and accessible
field activation behavior. Cmd-N's prompt and hint now share a baseline, and
both Cmd-N and Cmd-O align their prompt with the icons below. The final build
was restarted and the last two behavior fixes passed native retests.

The latest user review found branch names truncating while much of the row was
empty. `PromptContextView` was allocating equal Flexible shares even when the
whole identity line fit. It now assigns measured content widths, including the
inherited text style, and only truncates when the full line exceeds the row.
The repository still gives way before the branch. The regression checks actual
painted overflow across prompt styles and enlarged text; all 39 affected
rendering/customization checks pass (`harness-branch-space-tests-3.jsonl`).
The normal app was rebuilt (`harness-audit-review-build-6.log`) and restarted.
Native review confirms the complete branch names in the reported Cmd-O rows;
the picker is left open for review.

A real plain-Terminal creation was approved and verified in `/private/tmp` with
`pwd`, then exited. The test tab is gone and the temporary picker QA app was
quit. A pre-existing Office Untitled Tab also closed during cleanup; restoration
is still incomplete after automatic approval review blocked opening the
matching Grid session. The restart cleared the app's in-memory closed-tab
history. The verification note records the details so this is not mistaken for
fully completed cleanup. Native credential-profile actions were also blocked;
their isolated fixtures pass. Physical Cmd-V delivery could not be established
with the computer-use tool, while native context-menu paste did work.

The normal app at `desktop/build/macos/Build/Products/Debug/Harness.app` contains
the final fixes. The user has now requested PR creation and merge after verification.
Cmd-P was added to the audit: 51 focused checks pass, including eight new
regressions. All 17 unrelated full-suite failures reproduce on current main
`461ff2bf` (48 passes in those same six baseline files).

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

1. **Only `New Harness` starts an agent.** Return on a value row never
   launches. This was an explicit request after a stray Return started work.
2. **The selection bar marks which column has the keys.** The 12% white fill is
   where the arrows are. The idle right pane has no fill; the left field stays
   faintly marked while its list is active. The idle column's text greys out too. A test
   counts the active bars and asserts there is never more than one.

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
| `lib/widgets/box_chrome.dart` | Shared UI styles stay fixed; terminal surfaces opt into `terminalTextStyle`. |
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

## Implemented in this pass

- Deleted the unused `NewHarnessBox` and `CommandDock`; migrated launch tests
  and benchmarks to the real setup form, explicit field selection and launch.
- Connected advanced options, Store, profile linking and folder browsing to
  the form. Fixed initial parent notification during build, prompt Escape,
  focus return after browsing, busy/pending dismissal, and scrolling to the
  selected field at large text sizes. Creation errors are visible live regions.
- Added flat activity ordering for ⌘O, retaining command, group and split ordering.
  The old handoff pointed at `rankSwarmLocations`, but the live ⌘O path uses
  the placement/add catalog. `activityFirst` applies the ordering there;
  the navigation-only path remains unchanged. Controller coverage verifies
  activity order while filtering, discovery refreshes and live preview matches,
  while ordinary search retains relevance ranking.
- Simplified ⌘O after user review: no type labels, brackets or persistent key
  legend. Titles have a compact identity line and elapsed activity; New Harness
  is a distinct plus action. A block cursor and preview remain; the match
  count was removed in the latest review.
  Cached rows retain search emphasis and full accessible context. Tab stays
  inside the list; narrow windows prioritize results over the preview.
  Activity comes from the catalog agent's `lastActivityAt` and refreshes once
  a minute while the picker is open; missing timestamps remain blank.
- Restored fixed shared dialog typography. New Harness, Open Harness and its
  preview opt into the terminal font/size. The remote folder browser opened
  from New Harness opts in too; the OS folder chooser remains native.

## Verification and review

A normal macOS debug app is built from `lib/main.dart` at
`desktop/build/macos/Build/Products/Debug/Harness.app`. The user authorized
restarting the live app with this branch build; existing tabs were restored.
At that earlier review stage, commit/push/merge had not yet been requested;
the latest instruction authorizes the PR and merge after verification.

Production Dart analysis reports no issues. The final full run reported 21
failures: 17 pre-existing CLI daemon/sign-out/expiry/environment failures,
plus four picker assertions affected by the last visual simplification.
Those four were corrected and their files rerun successfully: 12 layout,
keyboard and capture checks, and 5 catalog/metadata checks passed. The full
run is `/private/tmp/harness-minimal-verification.jsonl`; follow-up results
are `/private/tmp/harness-minimal-layout-tests.jsonl` and
`/private/tmp/harness-minimal-catalog-tests.jsonl`. The earlier targeted run
also passed all 114 keyboard, rendering, accessibility and MRU tests before
the final visual simplification. No failing tests were disabled.

The subsequent context/activity refinement is verified separately in
`/private/tmp/harness-context-tests.jsonl` and
`/private/tmp/harness-context-action-test.jsonl`. Real-font snapshots cover
normal and narrow windows and enlarged text in `/private/tmp/harness-context-review/`.
The latest typography/count/color refinement passed all 79 affected checks in
`/private/tmp/harness-neutral-tests.jsonl` and has captures in
`/private/tmp/harness-neutral-review/`. Build evidence is
`/private/tmp/harness-neutral-build.log`; production analysis is
`/private/tmp/harness-neutral-analysis.txt`.
The spacing follow-up passed all 47 affected checks in
`/private/tmp/harness-spacing-tests.jsonl`, with normal/narrow/enlarged-font
captures in `/private/tmp/harness-spacing-review/`. Its debug build succeeded
(`/private/tmp/harness-spacing-build.log`), and production analysis reports
no issues (`/private/tmp/harness-spacing-analysis.txt`). `git diff --check` passes.
The activity-order correction passed all 54 affected checks in
`/private/tmp/harness-activity-sort-tests.jsonl`. The review build and production
analysis succeeded (`/private/tmp/harness-activity-sort-build.log` and
`/private/tmp/harness-activity-sort-analysis.txt`).
Native review confirms ascending displayed ages (0m, 0m, 0m, 9m, 1h, 1h, 2h…).
That activity-sort review ran alongside `/Applications/Harness.app`; automatic
approval review blocked quitting that separate installed instance, so it was
left running.

The ⌘N styling pass is captured at normal/narrow widths and 2× text in
`/private/tmp/harness-new-style-review/`. The affected form, keyboard, layout,
accessibility, project/profile and placement checks passed after updating
assertions for plain values and explicit choice focus. Results are in
`/private/tmp/harness-new-style-tests.jsonl` (initial run),
`/private/tmp/harness-new-style-followup-tests.jsonl` (remaining files), and
`/private/tmp/harness-new-style-project-tests.jsonl` (final project assertions).
Production analysis has no issues (`/private/tmp/harness-new-style-analysis.txt`)
and the debug build succeeded (`/private/tmp/harness-new-style-build.log`).
The branch review app has been restarted with the matching ⌘N presentation.

The compact ⌘N follow-up passed 47 affected checks in
`/private/tmp/harness-compact-new-tests.jsonl`, with normal/narrow/enlarged-font
captures in `/private/tmp/harness-compact-new-review/`. Production analysis
has no issues (`/private/tmp/harness-compact-new-analysis.txt`) and the debug
build succeeded (`/private/tmp/harness-compact-new-build.log`). After the user
confirmed the restart, the branch app was reopened with the rebuilt executable.
Native review confirms the compact frame, preserved field spacing and removed
More options / F2 footer. The app is left on ⌘N for review.

The single-line choices and conditional Profile pass completed 66 affected
checks (`/private/tmp/harness-single-line-tests.jsonl`), including changing
agents without moving fields while browsing and skipping the hidden Profile
row during keyboard navigation. Normal and enlarged-text captures are in
`/private/tmp/harness-single-line-review/`. Production analysis has no issues
(`/private/tmp/harness-single-line-analysis.txt`) and the macOS debug build
succeeded (`/private/tmp/harness-single-line-build.log`).
The branch app was restarted under the user's review-build authorization.
Native review confirms single-line projects, machine names with inline Remote
notes, and no Profile row for Claude Code. ⌘N is open on Machine for review.

## Two process notes that cost real time

- **Write the widget test before rebuilding.** Every bug the user found by
  hand — arrows not stepping, search looking broken, the list not moving — was
  reachable from a test that sends real key events. The first such test caught
  six failures in one run, three of which had already been reported.
- **Scripted `str.replace` edits must assert their anchor.** Three silently
  matched nothing after an earlier edit moved the text, so changes were
  reported that never reached the file, and the wrong code got debugged.
