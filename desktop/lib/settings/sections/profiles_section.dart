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
                    unavailable: _unavailable(machine),
                  ),
                  control: _choice(
                    selected: selected == machine.machineId,
                    // A computer this window cannot reach has no live tabs to
                    // narrow down to, so it cannot be chosen until it is back.
                    // One already chosen stays shown.
                    onPressed: _unavailable(machine) == null
                        ? () => notifier.setMachineProfile(machine.machineId)
                        : null,
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );

  /// Why [machine] cannot be chosen right now, or null when it can: this
  /// window has no live connection to it, it has to be linked again, or it
  /// reports itself offline.
  String? _unavailable(Machine machine) {
    final state = notifier.stateOf(machine.machineId);
    if (state == null || state.needsLink) return 'Not connected.';
    if (state.nodeOnline == false) return 'Offline.';
    if (state.connectionStatus != ConnectionStatus.connected) {
      return 'Not connected.';
    }
    return null;
  }

  String _detail(
    Machine machine, {
    String? localId,
    required bool sharedName,
    String? unavailable,
  }) {
    final where = machine.machineId == localId
        ? 'This computer. Tabs whose agents are all here.'
        : 'That computer. Tabs whose agents are all there.';
    final short = machine.machineId.length > 8
        ? machine.machineId.substring(0, 8)
        : machine.machineId;
    final named = sharedName ? '$where ($short)' : where;
    return unavailable == null ? named : '$unavailable $named';
  }

  /// [onPressed] null is a machine that cannot be chosen now: the button is
  /// disabled. A chosen one reads Showing, and is disabled for being chosen.
  Widget _choice({required bool selected, required VoidCallback? onPressed}) {
    return OutlinedButton(
      onPressed: selected ? null : onPressed,
      child: Text(selected ? 'Showing' : 'Show'),
    );
  }
}
