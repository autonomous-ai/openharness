import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'team_glance.dart';

/// Opens Team at a glance over the Swarm, live: it follows the Swarm as it changes.
Future<void> showSuperTabTeamGlance(
  BuildContext context,
  SuperTabController c,
  AppNotifier? app,
) => showAppDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    title: const Text('Team at a glance'),
    content: ListenableBuilder(
      listenable: Listenable.merge([c, ?app]),
      builder: (context, _) =>
          SuperTabTeamGlancePanel(glance: SuperTabTeamGlance.of(c, app)),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Close'),
      ),
    ],
  ),
);

/// The glance as one column of at most [width], so another panel (a leaderboard) can sit beside it; narrower on a
/// phone.
class SuperTabTeamGlancePanel extends StatelessWidget {
  const SuperTabTeamGlancePanel({super.key, required this.glance});
  final SuperTabTeamGlance glance;
  static const width = 420.0;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget heading(String text) => Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 6),
      child: Text(
        text,
        style: DesktopChrome.metadata().copyWith(fontWeight: FontWeight.w600),
      ),
    );
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: width),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (glance.warnings.isEmpty)
              Text('Nothing looks wrong.', style: DesktopChrome.metadata())
            else
              for (final warning in glance.warnings) _Warning(warning),
            heading('Machines'),
            for (final machine in glance.machines) _Machine(machine),
            heading('Models'),
            Column(
              key: const ValueKey('glance-models'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final (model, count) in glance.models)
                  Text('$model · $count', style: DesktopChrome.control()),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Warning extends StatelessWidget {
  const _Warning(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          Icons.warning_amber_rounded,
          size: 16,
          color: grid.AppPalette.warn,
        ),
        const SizedBox(width: 6),
        Expanded(child: Text(text, style: DesktopChrome.control())),
      ],
    ),
  );
}

class _Machine extends StatelessWidget {
  const _Machine(this.machine);
  final SuperTabGlanceMachine machine;

  String get _summary {
    final state = switch (machine.status) {
      null => 'Not reported',
      SuperTabMachineStatus.offline => 'Offline',
      SuperTabMachineStatus.late => 'Late',
      _ => 'Online',
    };
    final total = machine.total;
    if (total == null) return state;
    final used = machine.free == null
        ? machine.agents.length
        : total - machine.free!;
    return '$state · $used of $total slots used';
  }

  @override
  Widget build(BuildContext context) => Padding(
    key: ValueKey('glance-machine-${machine.id}'),
    padding: const EdgeInsets.only(bottom: 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.end,
          children: [
            Text(machine.name, style: DesktopChrome.control()),
            Text(_summary, style: DesktopChrome.metadata()),
          ],
        ),
        if (machine.agents.isEmpty)
          Text('No agents', style: DesktopChrome.metadata())
        else
          for (final (name, agent) in machine.agents)
            Padding(
              padding: const EdgeInsets.only(left: 12),
              child: Text(
                '$name · ${agent.label}',
                style: DesktopChrome.metadata(),
              ),
            ),
      ],
    ),
  );
}
