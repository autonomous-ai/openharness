import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'personal_machines.dart';

/// The person's own machines still to join their Personal Swarm, each with one
/// word, and a failure's reason on hover. The list only: the sync is
/// [PersonalMachines]', so this can move with the machines' section.
class PersonalMachineRows extends StatelessWidget {
  const PersonalMachineRows({
    super.key,
    required this.controller,
    required this.app,
  });

  final SuperTabController controller;
  final AppNotifier app;

  @override
  Widget build(BuildContext context) {
    final machines = PersonalMachines.of(app);
    return ListenableBuilder(
      // The section rebuilds with its Swarm; this one only with the sync.
      listenable: machines,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [for (final row in machines.waiting(controller)) _row(row)],
      ),
    );
  }

  Widget _row(PersonalMachineRow row) {
    final failed = row.reason != null;
    final line = Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.panelPadding,
        vertical: grid.AppDesktop.controlGap,
      ),
      child: Row(
        children: [
          Icon(
            failed ? AppIcons.triangleAlert : AppIcons.cloudOff,
            size: grid.AppControl.iconSizeChip,
            color: DesktopChrome.muted,
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Expanded(
            child: Text(
              row.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.text(color: DesktopChrome.muted),
            ),
          ),
          const SizedBox(width: grid.AppDesktop.controlGap),
          Text(row.status, style: DesktopChrome.metadata()),
        ],
      ),
    );
    return KeyedSubtree(
      key: ValueKey('super-personal-machine-${row.machineId}'),
      child: failed ? Tooltip(message: row.reason, child: line) : line,
    );
  }
}
