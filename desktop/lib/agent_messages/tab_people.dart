import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart' show Agent, ConnectionStatus;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'shared_tab_dialogs.dart';
import 'shared_tab_people.dart'
    show PeopleRow, PeopleRowAction, toggleLeaderReportingError;
import 'shared_tab_placement.dart' show shortSharedText;

/// People in a tab that is not shared: this account's harnesses in it
/// (engine, computer, whether it works), Make Leader / Remove Leader, and
/// Invite People…, which shares the tab. Repo and branch come from the
/// daemon's `who`, which answers for shared tabs only, so they are left out
/// here.
class TabPeople extends StatefulWidget {
  const TabPeople({super.key, required this.app, required this.deskTabId});

  final AppNotifier app;
  final String deskTabId;

  @override
  State<TabPeople> createState() => _TabPeopleState();
}

class _TabPeopleState extends State<TabPeople> {
  bool _busy = false;
  String? _error;
  late final _listenable = Listenable.merge([
    widget.app,
    widget.app.agentMessages,
    widget.app.experimentalFeatures,
  ]);

  Future<void> _toggle(String machineId, String agentId) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final error = await toggleLeaderReportingError(
        widget.app,
        machineId,
        agentId,
      );
      if (mounted && error != null) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: _listenable,
      builder: (context, _) => _content(context),
    );
  }

  Widget _content(BuildContext context) {
    final app = widget.app;
    final swarm = app.swarms.where((s) => s.id == widget.deskTabId).firstOrNull;
    final seen = <String>{};
    final rows = <Widget>[];
    var waiting = 0;
    for (final pane in swarm?.panes ?? const []) {
      final agentId = pane.agentId;
      if (agentId == null || !seen.add('${pane.machineId}\u0000$agentId')) {
        continue;
      }
      final state = app.machineStates[pane.machineId];
      // Only this account's computers: nothing here is another account's.
      if (state == null || state.belongsToOtherAccount) continue;
      // Its harnesses are not known yet: the shape of a row, not a name.
      if (state.agentLoadStatus != AgentLoadStatus.loaded) {
        waiting++;
        continue;
      }
      rows.add(_row(pane.machineId, agentId, state));
    }
    return ListView(
      key: const ValueKey('tab-people'),
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      children: [
        if (_error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
            child: Text(
              _error!,
              key: const ValueKey('people-error'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(
                color: Theme.of(context).colorScheme.error,
              ),
            ),
          ),
        if (waiting > 0)
          SkeletonList(
            key: const ValueKey('tab-people-loading'),
            rows: waiting,
            semanticsLabel: 'Loading harnesses',
          ),
        if (rows.isEmpty && waiting == 0)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Text(
              'No harnesses in this tab yet.',
              key: const ValueKey('tab-people-empty'),
              textAlign: TextAlign.center,
              style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
            ),
          ),
        ...rows,
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              DesktopPill(
                key: const ValueKey('people-invite'),
                label: 'Invite People…',
                compact: true,
                onPressed: () =>
                    unawaited(showInvitePeople(context, app, widget.deskTabId)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _row(String machineId, String agentId, MachineState state) {
    final app = widget.app;
    final Agent? agent = state.agents.where((a) => a.id == agentId).firstOrNull;
    final name = shortSharedText(agent?.displayName ?? '', 40);
    final engine = shortSharedText(agent?.engine ?? '', 24);
    final machine = shortSharedText(state.machine.displayName, 24);
    final working = state.processingAgentIds.contains(agentId);
    // Idle only when the machine is known and connected; otherwise no claim.
    final known =
        !state.isOffline &&
        (state.nodeOnline == true ||
            state.connectionStatus == ConnectionStatus.connected);
    final leader = app.tabLeader(widget.deskTabId);
    final isLeader =
        leader?.machineId == machineId && leader?.agentId == agentId;
    final action = app.leaderActionFor(machineId, agentId);
    final details = [
      if (engine.isNotEmpty) engine,
      if (machine.isNotEmpty) machine,
      if (working) 'working' else if (known) 'idle',
    ].join(' · ');
    return PeopleRow(
      key: ValueKey('people-harness:$machineId/$agentId'),
      title: name.isEmpty ? agentId : name,
      badge: isLeader ? 'leader' : null,
      detail: details,
      trailing: [
        if (action != null)
          PeopleRowAction(
            key: ValueKey('people-leader:$machineId/$agentId'),
            label: action == 'remove' ? 'Remove Leader' : 'Make Leader',
            onPressed: () => unawaited(_toggle(machineId, agentId)),
          ),
      ],
    );
  }
}
