# Machines UI review

The screenshot is rendered from the production Machines panel and toolbar with in-memory fixtures, not a signed-in account. The toolbar presents **Machines · Models · Harnesses**, followed by Harness Store. All three marks are monochrome SVGs shared by Flutter and AppKit: muted gray normally, brighter on hover or while open, and white when carrying a notification.

Machines counts unseen online computers ready to connect; optional password setup never adds a badge. Models counts completed model starts/downloads. Opening a panel acknowledges its own badge. Newly added model catalog entries receive a quiet **New** label inside Models instead of a toolbar notification.

To reproduce the visual review from `desktop`:

```sh
HARNESS_MACHINES_CAPTURE_DIR=/tmp/harness-machines-review flutter test test/machines_panel_test.dart
```

To check the new feature's executable-line coverage:

```sh
flutter test --coverage test/machines_panel_test.dart test/machine_resources_test.dart test/machines_manager_test.dart test/boot_flow_widget_test.dart test/toolbar_notices_test.dart
node tool/check_machines_coverage.mjs
```

This gate covers the four new files: the panel, SVG widget, resource model, and toolbar notification controller. It does not assert whole-application coverage or replace testing on two physical computers.

For a disposable interactive review, build `tool/machines_preview.dart` and launch its executable with `FLUTTER_TEST=1`. Use `MACHINES_PREVIEW_EMPTY=1` for the first-computer experience, or `MACHINES_PREVIEW_GUEST=1` for sign-in. F6 simulates a newly discovered Mac mini; its fixture password is `123456`. F7 simulates a model becoming ready; F8 adds a model to the catalog. Account edits, links, password operations, model operations, and resource values in this entrypoint remain in memory. Copy and Download use the actual system clipboard/browser. Restore the regular build afterward with `flutter build macos --debug --target lib/main.dart`.
