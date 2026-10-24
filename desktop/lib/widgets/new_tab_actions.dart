import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import 'desktop_chrome.dart';
import 'finger_target.dart';

/// The command New Swarm runs: Alt+S's.
const kNewSwarmCommand = 'super_tab.new';

/// What a New tab page offers besides its New Harness box, each a workspace
/// command id: the same one its key and menu row run.
const kNewTabActions = [
  (command: 'harnesses.list', label: 'Open Harness', icon: AppIcons.search),
  (command: 'machines.list', label: 'Machines', icon: AppIcons.server),
  (command: kNewSwarmCommand, label: 'New Swarm', icon: AppIcons.users),
  (command: 'app.store', label: 'Store', icon: AppIcons.store),
];

/// [kNewTabActions] as plain buttons, for a host that shows no key hints (the
/// mouse-first web): where Desktop teaches chords, a click is the way in
/// (audit findings S7, B2). Each runs its command through [onCommand]; on a
/// phone each is a finger's size.
class NewTabActions extends StatelessWidget {
  const NewTabActions({
    super.key,
    required this.onCommand,
    this.offersNewSwarm = true,
  });

  final ValueChanged<String> onCommand;

  /// False leaves New Swarm out: on a Swarm draft it would start the thing
  /// already on screen.
  final bool offersNewSwarm;

  @override
  Widget build(BuildContext context) {
    final finger = workspaceIsCompact(context);
    return Wrap(
      key: const ValueKey('new-tab-actions'),
      spacing: 8,
      runSpacing: finger ? 0 : 8,
      children: [
        for (final action in kNewTabActions)
          if (offersNewSwarm || action.command != kNewSwarmCommand)
            fingerTarget(
              enabled: finger,
              DesktopPill(
                key: ValueKey('new-tab-action:${action.command}'),
                label: action.label,
                icon: action.icon,
                onPressed: () => onCommand(action.command),
              ),
            ),
      ],
    );
  }
}
