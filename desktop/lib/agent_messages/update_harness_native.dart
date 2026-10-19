import 'dart:io';

import '../core/harness_cli_runner.dart';

/// This computer's desktop can run the CLI itself.
const canRunHarnessUpdate = true;

/// Runs `harness <args>` the way the rest of the app runs it (managed Node, no shell). True when it
/// exited 0.
Future<bool> runHarnessUpdate(List<String> args) async {
  try {
    final result = await HarnessCliRunner(
      runTimeout: const Duration(minutes: 5),
    ).run(args);
    return result.exitCode == 0;
  } on ProcessException {
    return false;
  }
}
