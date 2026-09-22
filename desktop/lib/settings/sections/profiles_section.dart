import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../state/app_state.dart';

/// One login, several computers. The account desk still holds every tab.
/// This window draws all of them, or only the computer named here.
class ProfilesSection extends StatelessWidget {
  const ProfilesSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      final selected = notifier.machineProfileId;
      final localId = notifier.localMachineState?.machine.machineId;
      final machines = notifier.machines;
      final names = <String, int>{};
      for (final machine in machines) {
        names[machine.displayName] = (names[machine.displayName] ?? 0) + 1;
      }
      return SectionScaffold(
        title: 'Profiles',
        subtitle:
            'One sign-in. Choose a computer to show only that computer\'s tabs. All machines keeps the shared desk.',
        child: SingleChildScrollView(
          child: Column(
            children: [
              SettingRow(
                title: 'All machines',
                detail: 'Every tab on this account, whichever computer it runs on.',
                control: _choice(
                  selected: selected == null,
                  onPressed: () => notifier.setMachineProfile(null),
                ),
              ),
              for (final machine in machines)
                SettingRow(
                  title: machine.displayName,
                  detail: _detail(
                    machine,
                    localId: localId,
                    sharedName: (names[machine.displayName] ?? 0) > 1,
                  ),
                  control: _choice(
                    selected: selected == machine.machineId,
                    onPressed: () => notifier.setMachineProfile(machine.machineId),
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );

  String _detail(Machine machine, {String? localId, required bool sharedName}) {
    final where = machine.machineId == localId
        ? 'This computer. Tabs whose agents are all here.'
        : 'That computer. Tabs whose agents are all there.';
    if (!sharedName) return where;
    final short = machine.machineId.length > 8
        ? machine.machineId.substring(0, 8)
        : machine.machineId;
    return '$where ($short)';
  }

  Widget _choice({required bool selected, required VoidCallback onPressed}) {
    return OutlinedButton(
      onPressed: selected ? null : onPressed,
      child: Text(selected ? 'Showing' : 'Show'),
    );
  }
}
