import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/rename_agent_dialog.dart'
    show showMachineRenameDialog;

import 'change_wifi_page.dart';
import 'link_page.dart';
import 'phone_navigation.dart';
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'remove_machine.dart';
import 'tty.dart';
import 'unlink_machine.dart';

/// The Wi-Fi a Harness OS computer is on, as it last said.
String? _ssidOf(AppNotifier notifier, String machineId) {
  final wifi = notifier.osStatus[machineId]?['wifi'];
  return wifi is Map ? wifi['ssid'] as String? : null;
}

/// Update ▸ a Harness OS computer updates itself (`harness update`, the same as Super+u there). It
/// restarts its daemon on the way, so it reads offline for a moment and comes back on the new version.
Future<void> updateComputer(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final name =
      notifier.stateOf(machineId)?.machine.displayName ?? 'The computer';
  final reply = await notifier.osDevice(machineId, {'action': 'update'});
  final String said;
  if (reply['started'] == true) {
    said =
        '$name is updating. It restarts by itself and comes back in a minute or two.';
    notifier.osStatus.remove(machineId);
    // Asked again once it is back on the new version.
    Timer(
      const Duration(minutes: 2),
      () => unawaited(notifier.refreshOsStatus(machineId, force: true)),
    );
  } else if (reply['error'] == 'BUSY') {
    said = '$name is already updating.';
  } else {
    said = 'Could not start the update. Try again.';
  }
  messenger?.showSnackBar(SnackBar(content: Text(said)));
}

/// The sheet of what can be done TO a computer — Settings ▸ Computers.
///
/// Every computer opens it, whatever it reads, because what the account can do to a computer does
/// not wait on the computer: a rename and a removal are the backend's (`AppNotifier.renameMachine`,
/// `deleteMachine`), and an asleep or locked one is as likely as any to be the one somebody wants to
/// rename or take off the account. What its own socket can do — its harnesses, its password — is
/// offered only where it answers.
///
/// Read at the tap, not when the row was drawn, so a computer that got linked in between gets the
/// sheet for what it is now.
void openMachineActions(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) {
  final machine = notifier.stateOf(machineId);
  if (machine == null) return;
  final status = phoneMachineStatusOf(machine);
  final retrying = notifier.machineRetrying(machineId);
  final removing = notifier.machineRemoving(machineId);

  // Asleep or stuck connecting: the one thing worth a tap is asking it again.
  final tryAgain = PhoneSheetAction(
    icon: LucideIcons.refreshCw300,
    label: 'Try again',
    value: retrying ? 'trying…' : null,
    enabled: !retrying && !removing,
    onTap: () => unawaited(retryComputer(context, notifier, machineId)),
  );
  final rename = PhoneSheetAction(
    icon: LucideIcons.pencil300,
    label: 'Rename…',
    enabled: !removing,
    onTap: () =>
        unawaited(showMachineRenameDialog(context, notifier, machineId)),
  );
  final remove = PhoneSheetAction(
    icon: LucideIcons.trash2300,
    label: 'Remove from account…',
    destructive: true,
    value: removing ? 'removing…' : null,
    enabled: !removing,
    onTap: () => unawaited(confirmRemoveMachine(context, notifier, machineId)),
  );

  final List<PhoneSheetAction> actions;
  final List<PhoneSheetAction> destructive;
  switch (status) {
    case PhoneMachineStatus.offline:
      actions = [tryAgain, rename];
      destructive = [remove];
    case PhoneMachineStatus.needsPassword:
      actions = [
        // First, because it is what the row said a tap would do.
        PhoneSheetAction(
          icon: LucideIcons.lockOpen300,
          label: 'Unlock…',
          chevron: true,
          enabled: !removing,
          onTap: () => Navigator.of(context).push(
            phoneRoute(
              (_) => LinkPage(notifier: notifier, machineId: machineId),
            ),
          ),
        ),
        rename,
      ];
      destructive = [remove];
    case PhoneMachineStatus.connecting || PhoneMachineStatus.ready:
      actions = [
        if (status == PhoneMachineStatus.connecting)
          tryAgain
        else
          PhoneSheetAction(
            icon: LucideIcons.refreshCw300,
            label: 'Reload harnesses',
            onTap: () => unawaited(notifier.reloadMachineData(machineId)),
          ),
        rename,
        // A Harness OS computer, often one with no screen: its update and its Wi-Fi, from here.
        if (notifier.runsHarnessOs(machineId)) ...[
          PhoneSheetAction(
            icon: LucideIcons.download300,
            label: 'Update',
            // The dot: a new version is waiting.
            value: notifier.updateAvailable(machineId)
                ? '● new version'
                : 'up to date',
            valueColor: notifier.updateAvailable(machineId)
                ? Tty.of(context).green
                : null,
            enabled: notifier.updateAvailable(machineId),
            onTap: () =>
                unawaited(updateComputer(context, notifier, machineId)),
          ),
          PhoneSheetAction(
            icon: LucideIcons.wifi300,
            label: 'Change Wi-Fi…',
            value: _ssidOf(notifier, machineId),
            chevron: true,
            onTap: () => Navigator.of(context).push(
              phoneRoute(
                (_) => ChangeWifiPage(notifier: notifier, machineId: machineId),
              ),
            ),
          ),
        ],
      ];
      destructive = [
        // No confirmation, the same as before: this sheet is the step between the tap and the
        // unlink. Removing from the account asks, because it reaches every device.
        PhoneSheetAction(
          icon: LucideIcons.unlink300,
          label: 'Unlink this phone',
          destructive: true,
          enabled: !removing,
          onTap: () => unawaited(unlinkThisPhone(context, notifier, machine)),
        ),
        remove,
      ];
  }
  // Asked as the sheet opens; the rows above come from the last answer, and a new one rebuilds them
  // the next time.
  if (status == PhoneMachineStatus.ready) {
    unawaited(notifier.refreshOsStatus(machineId));
  }
  showPhoneSheet(
    context,
    title: machine.machine.displayName,
    actions: actions,
    // Their own card, below a gap: the rows that end something stand apart from the ones that
    // only look or ask.
    sections: [PhoneSheetSection(actions: destructive)],
  );
}
