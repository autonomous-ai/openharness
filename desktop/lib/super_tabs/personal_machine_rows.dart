import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'personal_machines.dart';

/// The person's own machines still to join their Personal Swarm, each saying
/// why in a few words ("Couldn't join: machine is off"), with Try again and a
/// failure's whole reason on hover (task #3042). The list only: the sync is
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
    final machines = PersonalMachines.of(app);
    final status = Text(
      row.status,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: DesktopChrome.metadata(),
    );
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
          Flexible(
            child: Text(
              row.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.text(color: DesktopChrome.muted),
            ),
          ),
          Text(' · ', style: DesktopChrome.metadata()),
          Expanded(
            child: failed
                ? Tooltip(message: row.reason, child: status)
                : status,
          ),
          if (row.canRetry) ...[
            const SizedBox(width: grid.AppDesktop.controlGap),
            DesktopPill(
              key: ValueKey('super-personal-machine-retry-${row.machineId}'),
              label: 'Try again',
              quiet: true,
              compact: true,
              onPressed: () =>
                  unawaited(machines.retry(controller, row.machineId)),
            ),
          ],
        ],
      ),
    );
    return KeyedSubtree(
      key: ValueKey('super-personal-machine-${row.machineId}'),
      child: line,
    );
  }
}
