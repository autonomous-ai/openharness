import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'machine_status.dart';
import 'team_glance.dart';

/// Opens Team at a glance over the Swarm, live: it follows the Swarm as it changes.
Future<void> showSuperTabTeamGlance(
  BuildContext context,
  SuperTabController c,
  AppNotifier? app,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDetailDialog(
    title: 'Team at a glance',
    body: ListenableBuilder(
      listenable: Listenable.merge([c, ?app]),
      builder: (context, _) =>
          SuperTabTeamGlancePanel(glance: SuperTabTeamGlance.of(c, app)),
    ),
  ),
);

/// The glance as one column of at most [width]: what looks wrong, each machine with its agents by state, and the
/// models in use, in the details dialogs' label and value rows.
class SuperTabTeamGlancePanel extends StatelessWidget {
  const SuperTabTeamGlancePanel({super.key, required this.glance});
  final SuperTabTeamGlance glance;
  static const width = 420.0;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: width),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (glance.warnings.isEmpty)
            Text('Nothing looks wrong.', style: DesktopChrome.metadata())
          else
            for (final warning in glance.warnings) _Warning(warning),
          SuperTabDetailSection(
            title: 'Machines',
            children: [
              for (final machine in glance.machines) _Machine(machine),
            ],
          ),
          SuperTabDetailSection(
            title: 'Models',
            children: [
              Column(
                key: const ValueKey('glance-models'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final (model, count) in glance.models)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Text(
                        '$model · $count',
                        style: DesktopChrome.control(),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A warning, and the agents it is about folded beneath it: the first three, the rest a click away.
class _Warning extends StatefulWidget {
  const _Warning(this.warning);
  final SuperTabGlanceWarning warning;

  @override
  State<_Warning> createState() => _WarningState();
}

class _WarningState extends State<_Warning> {
  static const _shown = 3;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final names = widget.warning.names;
    final folded = !_expanded && names.length > _shown;
    final list = folded
        ? '${names.take(_shown).join(', ')} and ${names.length - _shown} more'
        : names.join(', ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(
              AppIcons.triangleAlert,
              size: grid.AppControl.iconSize,
              color: grid.AppPalette.warn,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(widget.warning.text, style: DesktopChrome.control()),
                if (names.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: folded
                        ? MouseRegion(
                            cursor: SystemMouseCursors.click,
                            child: GestureDetector(
                              onTap: () => setState(() => _expanded = true),
                              child: Semantics(
                                button: true,
                                hint: 'Shows every name',
                                child: Text(
                                  list,
                                  style: DesktopChrome.metadata(),
                                ),
                              ),
                            ),
                          )
                        : Text(list, style: DesktopChrome.metadata()),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A machine as the machine details read it: its name, its state and slots, then its agents grouped by what they
/// are doing, one label and value row per state.
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
  Widget build(BuildContext context) {
    final byState = <String, List<String>>{};
    for (final (name, agent) in machine.agents) {
      (byState[agent.label] ??= []).add(name);
    }
    return Padding(
      key: ValueKey('glance-machine-${machine.id}'),
      padding: const EdgeInsets.only(top: 8, bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.end,
            children: [
              Text(machine.name, style: DesktopChrome.control(medium: true)),
              Text(_summary, style: DesktopChrome.metadata()),
            ],
          ),
          if (byState.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('No agents', style: DesktopChrome.metadata()),
            )
          else
            for (final MapEntry(key: state, value: names) in byState.entries)
              SuperTabDetailRow(label: state, value: names.join(', ')),
        ],
      ),
    );
  }
}
