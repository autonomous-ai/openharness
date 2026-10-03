# Friendly desktop validation

Validation for the desktop redesign in PR #484. The earlier checkpoints below
are historical, not the current visual specification.
Current behavior and later validation are recorded in
[friendly-desktop-experiment.md](friendly-desktop-experiment.md); the broader
redesign follows [desktop-design-system.md](desktop-design-system.md).

## Release checkpoint — 2026-09-30

The branch incorporates main through `dd3097b7f`, including machine profiles,
companion artwork and shared chat, local-model management, web picker layouts,
and background opacity behind running harnesses.

| Check | Result |
| --- | --- |
| Full desktop unit/widget suite | 4,932 passed; 16 skipped; one stale startup expectation corrected below |
| Startup rerun | All 4 passed after adding the new background preference to the expected load |
| Native macOS composer/search journeys | All 25 passed |
| Native macOS workspace journeys | 26 passed in the full run; the corrected reconnect case passed separately (27 total) |
| AppKit titlebar, tabs, and footer checks | All 4,193 passed |
| Companion render fixtures | All 95 passed |
| Latest background and tab geometry checks | All 13 passed |
| Welcome composer render fixtures | All 14 passed |
| Dart analysis of app, tests, and native fixtures | No issues |

The reconnect fixture now advertises the daemon's no-takeover capability and
represents an established terminal whose initial control claim has been consumed.
It checks automatic reattachment without takeover, retention of the terminal
view and selection, and keyboard input after the new stream arrives. Setup uses
the same isolated guest fixture as the current unit tests; it never launches a
real daemon. Hermes first-message support is kept in sync with the CLI contract.

Synthetic [dark](review/2026-09-30-welcome-dark.png) and
[light](review/2026-09-30-welcome-light.png) screenshots were visually checked,
including agent colors and system text. The welcome fixtures also cover narrow
windows and 160% text size.

These checks use fake agents and injected Flutter keys. They do not establish
physical AppKit IME, VoiceOver, or interactive Linux/browser behavior. Release
CI builds macOS Intel and Apple Silicon variants and Linux x64 and arm64.
Coverage percentages from the historical checkpoints are not measurements of
this merged release candidate.

## Historical minimal composer iteration (after a26237c9)

The form is 860 points wide, with Agent, Machine, and Repo across the top and
the existing agent brand marks. The optional message editor says “Harness anything”
and keeps New harness inside its lower-right corner. The initial focus still
supports Cmd-N followed by Return. Model, Approvals, and Codex Profile are small,
text-only controls below. Worktree on/off and Branch stay together on the right,
moving together below the other settings in narrow windows or at larger text
sizes. The title, Add task toggle, and Options disclosure are removed.

Keyboard focus uses a subtle fill without thick outlines or layout movement.
Cmd-N and Cmd-P share the darker backdrop and softened dialog shadow. Choosers
start at search, size to their contents, and omit visible headings, close
buttons, and key legends. A back control remains for nested prompts. Long names
truncate visually while retaining complete tooltips and accessibility labels.

Open Folder… invokes the selected machine's native local dialog or remote
browser immediately. Cancelling preserves the draft and returns to the Repo
list; choosing a folder returns focus to Repo. Its menu row has no submenu
chevron. Legacy terminal presentation and launch validation are preserved.

Cmd-N resumes an interrupted draft even after typing in Cmd-P. Search text seeds
a new composer when no compatible draft exists; explicit new-task search
actions and Store examples still use their requested task. Pending launch
receipts keep their exact reviewed values.

Independent AI review added 26 composer journeys in
`test/desktop_composer_layout_test.dart`, alongside the updated launch fixtures.
These cover the visual hierarchy, full Tab/Shift-Tab traversal, empty and
multiline launch, live shortcut remapping, all dropdowns, outside clicks,
Codex-only profiles, Terminal focus, folder cancellation/acceptance, long names,
light/dark themes, narrow windows, and 160% text size. They pass with the normal
test font and with real UI fonts. A four-round mixed mouse/keyboard journey
changes agents and settings, reopens menus, filters lists, cancels by click and
Escape, then switches through search and restores the complete draft.

Review found and verified fixes for competing focus restoration after folder
acceptance, a stale Return hint after focus moved into the editor, clipped
Change Machine actions in short folder menus, and search text replacing an
unsent message when switching back to the composer.

Synthetic screenshots were visually inspected in both themes, with decoded
agent assets and real shadows enabled. No live-account screenshots are committed.
The native fixture uses injected Flutter keys and fake daemons, and does not
establish physical AppKit IME or VoiceOver behavior.

Final unit/widget validation on 2026-09-29, against `a26237c9`:

| Check | Result |
| --- | --- |
| Full desktop unit/widget suite | 4,500 passed; 12 skipped |
| Native macOS interaction fixture | 19 passed across four sequential shards |
| App, test, and integration-test analysis | No issues |
| Formatting | 19 changed Dart files; no changes needed |
| Normal macOS debug build | Passed; opened for review |
| Changed executable-line coverage | 1,986 / 1,986 (100%) |
| Complete creation form and controller | 3,627 / 3,627 (100%) |
| Resource picker coverage gate | 1,265 / 1,265 (100%) |

All three coverage gates passed against a single fresh full-suite trace. Source
hashes remained unchanged during the run; no stale traces or coverage exclusions
were used. These are executable-line measurements, not exhaustive branch or
input coverage. Unscoped analysis also reports 12 pre-existing info lints in
unchanged `third_party/xterm` files.

After the native fixture finished, the normal `lib/main.dart` app was rebuilt
with analytics disabled and opened for review. Cmd-N opens the final composer.

The single-process native fixture encountered background frame-delivery
throttling after roughly 30 seconds. Diagnostics showed responsive Dart timers
and native queries, with drawing reduced to about one frame every ten seconds,
even while the display was awake. All 19 independent journeys then passed once
each across four fresh native processes (5 + 5 + 4 + 5), with the original
assertions, timeouts, lifecycle, and frame policy unchanged. Temporary diagnostic
code was removed. This is a validation-environment limitation, not a claimed
product fix.

## Earlier polished checkpoint

| Check | Result |
| --- | --- |
| Full desktop unit/widget suite | 4,424 passed; 12 skipped |
| Native macOS interaction fixture | 12 passed |
| Dart analysis | No issues |
| Formatting | 62 changed Dart files checked; no changes needed |
| Normal macOS debug build | Passed; opened for review |
| Changed executable-line coverage | 1,809 / 1,809 (100%) |
| Complete creation form and controller | 3,541 / 3,541 (100%) |
| Resource picker coverage gate | 1,265 / 1,265 (100%) |

Coverage combines real test traces from the final source. Modules edited after
the broad coverage run were replaced with fresh traces; obsolete line offsets
were not combined. No coverage exclusions were added. The measurements cover
executable lines, not every branch or possible input.

## Earlier interaction review

The added suites exercise keyboard and mouse behavior through rendered widgets
with fake application state and daemon responses:

- `desktop_dialog_interaction_test.dart`: initial focus, traversal, custom
  shortcuts, composition ownership, nested cancellation, outside clicks, draft
  restoration, repeat submission, source-pane ownership, and dialog switching.
- `desktop_new_harness_edge_test.dart`: creation errors, configuration changes,
  terminal/task compatibility, and narrow layouts.
- `desktop_search_polish_test.dart` and `desktop_final_ux_test.dart`: search
  toolbar, scope selection, prefixes, focus, enlarged/narrow layouts, disposal,
  and repeated reopening. Keyboard-selected scopes stay visible after resizing.
- `desktop_search_edges_test.dart`: model availability, inventory updates,
  failed/repeated actions, API editing, preview ownership, polling, and recovery.
- `desktop_resource_forms_edge_test.dart`: native machine/API configuration,
  keyboard behavior, asynchronous responses, and errors.
- `desktop_remote_folder_picker_test.dart`: path entry, browsing, pagination,
  keyboard shortcuts, input composition, refresh, failure, retry, and disposal.
- `desktop_preview_compatibility_test.dart`: dated search matches, external
  conversation warnings, legacy keyboard activation, empty-result recovery,
  preview scrolling, Store history, and recovery from a full destination tab.

Independent AI developers reviewed synthetic user journeys and rendered
screens. Their findings led to fixes for hidden selected scopes, stale preview
callbacks, immediate action focus, clipping, and editor movement. Native visual
review checked the floating frames and shadows, typography, option lists,
search results, and previews. At that checkpoint, the normal app was left on Cmd-N.

## Reproduction

Run from `desktop/` with the repository's Flutter/Dart toolchain:

```sh
flutter test --no-pub --coverage --reporter expanded
flutter analyze --no-pub lib test integration_test
node tool/check_new_harness_coverage.mjs coverage/lcov.info
node tool/check_resource_picker_coverage.mjs coverage/lcov.info
python3 tool/check_portability_coverage.py --base a26237c9 --lcov desktop/coverage/lcov.info
```

On macOS, run the isolated native fixture, then restore the normal review app:

```sh
caffeinate -d -i -u env FLUTTER_TEST=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer flutter test -d macos --no-pub --dart-define=HARNESS_TEST=true integration_test/friendly_desktop_e2e_test.dart --reporter expanded
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer flutter build macos --debug --no-pub --target lib/main.dart --dart-define=HARNESS_ANALYTICS_DISABLED=true
```

If this host throttles a background native test window, add `--total-shards=4`
and run `--shard-index=0`, `1`, `2`, and `3` in separate sequential processes.
Run every shard and check the combined test count; do not skip slow assertions.

Native tests inject Flutter keys and use fake daemons. They do not establish
physical AppKit IME or VoiceOver behavior. Linux widget variants passed; no
Linux native build was performed. Live-account review remained read-only, and
live screenshots are not repository fixtures.

## Earlier compact launch checkpoint

Final validation on 2026-09-29, against `a26237c9`:

| Check | Result |
| --- | --- |
| Full desktop unit/widget suite | 4,471 passed; 12 skipped |
| Native macOS interaction fixture | 19 passed |
| Dart analysis | No issues |
| Formatting | 12 changed Dart files checked |
| Normal macOS debug build | Passed; compact Cmd-N opened for review |
| Changed executable-line coverage | 1,973 / 1,973 (100%) |
| Complete creation form and controller | 3,645 / 3,645 (100%) |
| Resource picker coverage gate | 1,265 / 1,265 (100%) |

All three coverage gates passed using the single final full-suite trace from
the current source. No earlier traces or coverage exclusions were needed.
These are executable-line measurements, not exhaustive branch or input coverage.

The team review identified two needs: immediate keyboard launch and discoverable
controls. Empty-task Cmd-N now opens at 560 points wide with Start focused.
Machine is in the header; Project and Agent remain the main fields. Approvals
and Worktree stay directly accessible. Add task reveals the composer; Options
reveals Branch, Model, and Profile in the same dialog. Restored tasks remain
visible, and empty task editors can be collapsed.

The last explicit approval selection is saved per agent. Worktree is saved per
machine/project. The existing preference files are extended without changing
their paths or replacing agent/project recents. Unsupported stored approval
modes are ignored, storage failures retain the in-memory choice, and pending or
restored drafts keep their reviewed values. Automatic retry recovery does not
replace an explicit worktree preference.

Independent test drives added 23 compact interaction journeys and 24 preference
scenarios. They found and verified fixes for an invisible Tab stop, loss of
focus after a failed launch, disabled-Start keyboard recovery, late preference
repainting, and a draft whose resolved worktree choice was not snapshotted.
The macOS fixture now includes seven compact journeys alongside the existing
12 composer/search journeys; all 19 passed. The fixture uses fake app state and
daemons, including when Return submits a launch.

Synthetic visual review covered compact and expanded layouts, both themes,
600-point windows, and 160% text size. The normal app is rebuilt after the native
fixture, with the compact Cmd-N left open for review. Physical AppKit IME and
VoiceOver remain outside this validation.
