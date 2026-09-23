# Machines UI review

The screenshot is rendered from the production Machines panel and toolbar with in-memory fixtures, not a signed-in account. The toolbar uses `desktop/assets/machines.svg` in both Flutter and AppKit.

To reproduce the visual review from `desktop`:

```sh
HARNESS_MACHINES_CAPTURE_DIR=/tmp/harness-machines-review flutter test test/machines_panel_test.dart
```

To check the new feature's executable-line coverage:

```sh
flutter test --coverage test/machines_panel_test.dart test/machine_resources_test.dart test/machines_manager_test.dart test/boot_flow_widget_test.dart
node tool/check_machines_coverage.mjs
```

This gate covers the new panel, SVG widget, and resource model. It does not assert whole-application coverage or replace testing on two physical computers.

For a disposable interactive review, build `tool/machines_preview.dart` and launch its executable with `FLUTTER_TEST=1`. Use `MACHINES_PREVIEW_EMPTY=1` for the first-computer experience, or `MACHINES_PREVIEW_GUEST=1` for sign-in. F6 simulates a newly discovered Mac mini; its fixture password is `123456`. Account edits, links, password operations, and resource values in this entrypoint remain in memory. Copy and Download use the actual system clipboard/browser.
