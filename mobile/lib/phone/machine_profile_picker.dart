import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'machine_index.dart';
import 'phone_sheet.dart';
import 'phone_status.dart';

/// What Settings ▸ Profile reads: "All computers", or the one whose tabs the phone shows.
String machineProfileLabel(AppNotifier notifier) {
  final id = notifier.machineProfileId;
  if (id == null) return 'All computers';
  // Chosen, but its row not here yet — a launch before the machine list has landed.
  return notifier.stateOf(id)?.machine.displayName ?? 'One computer';
}

/// Settings ▸ Profile: show every computer's tabs, or only one computer's — the desktop's Profiles
/// section (`desktop/lib/settings/sections/profiles_section.dart`) as a phone sheet.
///
/// One sign-in, one desk: picking a computer hides the other computers' tabs on THIS phone only
/// ([AppNotifier.setMachineProfile]). A tab is that computer's when every harness on it runs there.
///
/// A computer the phone cannot reach right now cannot be picked, as on the desktop: it has no live
/// tabs to narrow to. One already picked stays listed and picked whatever it reads, so the choice
/// on screen is never one the sheet hides.
Future<void> showMachineProfilePicker(
  BuildContext context,
  AppNotifier notifier,
) {
  final chosen = notifier.machineProfileId;
  return showPhoneSheet(
    context,
    title: 'Show tabs from',
    actions: [
      PhoneSheetAction(
        icon: chosen == null ? LucideIcons.check300 : LucideIcons.layers300,
        label: 'All computers',
        onTap: () => notifier.setMachineProfile(null),
      ),
    ],
    sections: [
      PhoneSheetSection(
        caption: "Only one computer's tabs",
        actions: [
          for (final machine in visibleMachines(notifier))
            _choice(notifier, machine, chosen),
        ],
      ),
    ],
  );
}

PhoneSheetAction _choice(
  AppNotifier notifier,
  MachineState machine,
  String? chosen,
) {
  final id = machine.machine.machineId;
  final picked = id == chosen;
  final status = phoneMachineStatusOf(machine);
  // The words the Computers page uses for the same states, so a row reads the same in both places.
  final unavailable = switch (status) {
    PhoneMachineStatus.ready => null,
    PhoneMachineStatus.connecting => 'connecting',
    PhoneMachineStatus.needsPassword => 'locked',
    PhoneMachineStatus.offline => 'asleep',
  };
  return PhoneSheetAction(
    icon: picked ? LucideIcons.check300 : LucideIcons.laptopMinimal300,
    label: machine.machine.displayName,
    value: unavailable,
    enabled: picked || unavailable == null,
    onTap: () => notifier.setMachineProfile(id),
  );
}
