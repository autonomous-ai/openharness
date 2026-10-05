import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'phone_sheet.dart';

/// The one "remove this computer from the account" confirmation on the phone — Settings ▸ Computers.
/// Its own file for the reason `delete_agent.dart` and `unlink_machine.dart` give: one wording of one
/// irreversible act, and one way of reporting that it failed.
///
/// ⚠️ **Not "Unlink this phone", and the sentence has to say so.** Unlinking drops this phone's own
/// pin and leaves the computer as it was. This takes the computer off the ACCOUNT: the backend
/// signs Harness out there (`AppNotifier.deleteMachine`), on every device at once. What it does not
/// touch is the computer's disk — the projects stay — and signing in there again brings it back.
///
/// Says something only when it fails: the row leaving the list is the report that it worked.
Future<void> confirmRemoveMachine(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) async {
  final machine = notifier.stateOf(machineId)?.machine;
  if (machine == null) return;
  final name = machine.displayName;
  final hostname = machine.hostname?.trim() ?? '';
  final confirmed = await confirmPhoneAction(
    context,
    // The Remove row's own icon — see [confirmPhoneAction].
    icon: LucideIcons.trash2300,
    title: 'Remove $name?',
    // What the computer calls itself, when the account's name for it differs — two computers
    // renamed alike are still told apart at the one step that removes one.
    detail: hostname.isEmpty || hostname == name ? null : hostname,
    message:
        'It leaves your account, and Harness on that computer is signed out. '
        'Its projects stay there. Sign in on it again to bring it back.',
    confirmLabel: 'Remove',
  );
  if (!confirmed || !context.mounted) return;
  final error = await notifier.deleteMachine(machineId);
  if (error == null || !context.mounted) return;
  ScaffoldMessenger.maybeOf(context)
      ?.showSnackBar(SnackBar(content: Text(error)));
}

/// "Try again" on a computer that reads asleep or is stuck connecting — see
/// [AppNotifier.retryMachine]. The row's own word moves with the answer, so this says something only
/// when the account itself could not be read.
Future<void> retryComputer(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) async {
  final error = await notifier.retryMachine(machineId);
  if (error == null || !context.mounted) return;
  ScaffoldMessenger.maybeOf(context)
      ?.showSnackBar(SnackBar(content: Text(error)));
}
