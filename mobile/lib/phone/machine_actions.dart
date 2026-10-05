import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/rename_agent_dialog.dart'
    show showMachineRenameDialog;

import 'link_page.dart';
import 'phone_navigation.dart';
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'remove_machine.dart';
import 'unlink_machine.dart';
import 'team_page.dart';

/// The sheet of what can be done TO a computer — Settings ▸ Computers.
///
/// Every computer opens it, whatever it reads, because what the account can do to a computer does
/// not wait on the computer: a rename and a removal are the backend's (`AppNotifier.renameMachine`,
/// `deleteMachine`), and an asleep or locked one is as likely as any to be the one somebody wants to
/// rename or take off the account. What its own socket can do — its swarms, its harnesses, its
/// password — is offered only where it answers.
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
        PhoneSheetAction(
          icon: LucideIcons.users300,
          label: 'Swarms',
          chevron: true,
          onTap: () => Navigator.of(context).push(
            phoneRoute(
              (_) => TeamPage(notifier: notifier, machineId: machineId),
            ),
          ),
        ),
        if (status == PhoneMachineStatus.connecting)
          tryAgain
        else
          PhoneSheetAction(
            icon: LucideIcons.refreshCw300,
            label: 'Reload harnesses',
            onTap: () => unawaited(notifier.reloadMachineData(machineId)),
          ),
        rename,
        PhoneSheetAction(
          icon: LucideIcons.keyRound300,
          label: 'Re-enter password…',
          onTap: () => Navigator.of(context).push(
            phoneRoute(
              (_) => LinkPage(notifier: notifier, machineId: machineId),
            ),
          ),
        ),
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
  showPhoneSheet(
    context,
    title: machine.machine.displayName,
    actions: actions,
    // Their own card, below a gap: the rows that end something stand apart from the ones that
    // only look or ask.
    sections: [PhoneSheetSection(actions: destructive)],
  );
}
