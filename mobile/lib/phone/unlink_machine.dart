import 'package:flutter/material.dart';

import 'package:harness_mobile/state/app_state.dart';

/// Drops this phone's pairing with [machine], and says so only if it fails.
///
/// ⚠️ No confirmation, by decision. The usual argument for one holds here — the pairing cannot be
/// rebuilt without that machine's password, so a mistaken tap costs a trip to find it — and it was
/// weighed and declined: the act is two taps deep inside a sheet nobody opens by accident, and the
/// row moving to "Needs your attention" is itself the report that it happened.
///
/// ⚠️ This drops THIS DEVICE's trust pin — `AppNotifier.unlinkMachine`, deliberately not
/// `deleteMachine`. The machine is untouched and its agents keep running; what ends is this phone's
/// permission to reach them.
///
/// Its own file rather than a closure in the sheet, so the one place this is done stays one place
/// when a second caller appears — the same reason `delete_agent.dart` exists.
Future<void> unlinkThisPhone(
  BuildContext context,
  AppNotifier notifier,
  MachineState machine,
) async {
  final error = await notifier.unlinkMachine(machine.machine.machineId);
  if (error == null || !context.mounted) return;
  ScaffoldMessenger.maybeOf(context)
      ?.showSnackBar(SnackBar(content: Text(error)));
}
