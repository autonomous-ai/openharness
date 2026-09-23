# Local models validation — 2026-09-23

Tested on macOS with Flutter 3.47.2 and Node 22.23.1. Base: `b5edd10a`.

## Monitor styling follow-up

Models now uses Harness Monitor's panel width, type scale, search and filter styling,
unboxed 22 px row marks, and 40 px play/pause controls. A single brain identifies Models in
both toolbars and the introduction. Model rows and the session picker use provider artwork,
with the brain as the fallback. Idle rows show only size in GB; running rows add available
throughput and request counts. All / Running filters remain. Play retains the existing
download/start operation; pause unloads the model and keeps its download.
Accessible action names and tooltips describe those effects; active operations replace
the control with a spinner and keep their progress in the row.

The focused panel/controller/picker suite passed 97 tests (one existing skip).
Model modules retain 100% executable line coverage: panel 335/335, mark 17/17,
controller 254/254, and lifecycle values 43/43. Changed Dart files analyze cleanly,
and the macOS review build passes. Updated captures cover first run, downloading,
running, errors, both themes, and a 360 px window at 1.7× text. Native computer-use
retesting verified the brain entry, branded rows, size-only idle copy, running telemetry,
play/pause, All / Running, and search/clear. The broader journeys below were also exercised
on the original implementation.

## Automated checks

| Check | Result |
| --- | --- |
| Full CLI suite | 4,218 passed, 63 skipped |
| Local-model lifecycle, bundled installer, Grid subprocess gate | 100 passed |
| New CLI lifecycle + installer coverage | 277/277 lines; 393/393 statements; 344/344 branches; 75/75 functions |
| Focused Flutter marks, controller, popover, picker, native menu, terminal presentation | 97 passed, 1 existing skip |
| New Flutter model modules | 649/649 executable lines |
| Full desktop suite | 2,981 passed, 12 skipped, 17 baseline failures |
| Model Manager operation/viewer tests | 43 passed |
| CLI typecheck and release bundle | Passed |
| Bundled installation, manifest check, repeated installation | Passed in a fresh temporary DSH directory |
| macOS debug build | Passed |
| Static analysis | No new findings; 15 existing findings elsewhere |

The CLI coverage gate covers `cli/src/lib/localModels.ts` and `cli/src/dsh/builtins.ts`.
Flutter coverage covers `local_model.dart` (43/43), `model_manager_controller.dart` (254/254),
`models_panel.dart` (335/335), and `model_mark.dart` (17/17). These are scope-specific measurements, not 100% repository
coverage or a claim that every hardware/model combination has been exercised.

The subprocess integration test uses the real process runner, a temporary Grid executable,
a local HTTP catalog/inference server, durable receipts, and an actual downloaded fixture file.
It exercises discovery → download → start → verified response → stop → restart, confirming
that restarting keeps the file and does not download again. Other regressions cover pagination,
partial files, disk/memory pressure, engine ownership, shared runtimes, failed starts and stops,
stale inventory, concurrent clicks, dropped acknowledgements, account changes, interrupted
operations, credential redaction, and encrypted RPC routing.

## Native user testing

Clicked the actual Flutter/macOS interface with computer use. Model operations used controlled
responses in `desktop/tool/models_review.dart`; this did not download or stop real models.

| Journey | Observed result |
| --- | --- |
| Toolbar Models icon and native Models → Open Models | Anchored popover; workspace stays in place |
| First-run Explore models | Opens the same list; invitation dismissed after discovery |
| All / Running | Correct counts, rows, and empty states |
| Search, no results, clear search | Filters immediately; one click restores the list |
| Start a missing model | Checking/download/start/test progress followed by Running |
| Start a downloaded model | Reaches Running without another download |
| Close and reopen during setup | Operation finishes; completed state survives panel closure |
| Start while another model runs | Clear instruction to stop the existing model |
| Pause | Progress, then size-only idle row; file remains available |
| Interrupted download and Start again | Recoverable row error; successful retry clears it |
| Unavailable inventory and Try again | Actions disabled; reconnection restores them |
| Session OpenAI → local model → OpenAI | Header and selected row follow the explicit choice |
| Models ↔ Harness Monitor | One popover at a time |
| Model Manager from another tab | Existing manager tab reused, including while attaching |
| Tab, Enter, Escape | Filters can be selected and the popover dismissed with the keyboard |
| Light/dark, 1.7× text, smaller window, scrolling | Actions and footer remain reachable |

Native testing caught and fixed duplicate Model Manager tabs, the truncated discovery link,
missing search clearing, the lingering first-run prompt, and singular request-count copy.
Regression work also fixed stale operation status, disconnected actions, the immediate Stop
label, shared-model picker refresh, and narrow pane-header overflow.

Command+A was verified by a macOS widget regression. The computer-use key injection did not
deliver the Command modifier to Flutter, so that native shortcut was not certified by automation.
The advanced manager's terminal stream is not simulated; native testing verifies its opening
and reuse, while package tests cover its operations and viewer.

## Existing failures and limits

All 17 desktop failures were reproduced on the unchanged base in an isolated checkout:

| Suite | Failures |
| --- | ---: |
| `workspace_account_lifecycle_test.dart` | 8 |
| `signout_recovery_test.dart` | 2 |
| `workspace_expiry_screen_test.dart` | 4 |
| `local_cli_discovery_test.dart` | 1 |
| `environment_setup_screen_test.dart` | 1 |
| `environment_recheck_timer_test.dart` | 1 |

The CLI startup test initially discovered the developer's existing tmux sessions and timed out.
It now has its own socket directory, pins the terminal backend, and disables provisioning and
hook installation. All 10 startup contracts and the subsequent full CLI suite pass.

Read-only integration on the real 64 GB Mac returned 30 compatible catalog models and the
existing Qwen deployment, with 17.6 tok/s and 1 completed request over 24 hours. Total engine
requests were not attributed to that model. Real model downloads, GPU allocation, and unloading
were not exercised on the user's machine. No live conversations or models were changed.

## Reproduce

From `cli/`:

```sh
npm run test:local-models
npm test -- --maxWorkers=2
npm run typecheck
npm run bundle
```

From `desktop/`:

```sh
flutter test --coverage test/model_mark_test.dart test/model_manager_controller_test.dart test/models_panel_test.dart test/grid_model_picker_test.dart test/models_menu_test.dart test/terminal_panel_presentation_test.dart
flutter test --concurrency=4
flutter analyze
flutter build macos --debug
FLUTTER_TEST=1 flutter run -d macos -t tool/models_review.dart
```

The review entry point refuses to run without `FLUTTER_TEST`. F6 changes its theme, F7 toggles
an inventory failure, F8 fails the next download, and F9 changes text size. All responses are
fixtures. Use a separate review app identity if another Harness build is already open.

From the repository root:

```sh
node --test store/agents/autonomous-grid/test/*.test.mjs
node cli/dist/cli.js dsh check store/agents/autonomous-grid
```

Set `HARNESS_MODELS_CAPTURE_DIR` when running `models_panel_test.dart` to regenerate the widget
PNGs. Final workspace, downloading, and running captures are in `output/visualizations/`.
