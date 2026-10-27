import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'agent_details.dart';
import 'controller.dart';
import 'identity.dart';
import 'office_map.dart';
import 'team_glance.dart';

/// The office map, opened from the header: a floor of tables, one per conversation with work moving or people in it
/// lately (office_map.dart). Clicking a table opens its conversation.
class SuperTabOfficeView extends StatelessWidget {
  const SuperTabOfficeView({
    super.key,
    required this.controller,
    required this.app,
    required this.onOpen,
    this.now,
  });
  final SuperTabController controller;
  final AppNotifier? app;
  final ValueChanged<String> onOpen;

  /// Fixed in tests; the clock otherwise.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final snapshot = controller.snapshot;
    final tables = snapshot == null
        ? const <SuperTabOfficeTable>[]
        : superTabOfficeMap(
            snapshot,
            now: now ?? DateTime.now(),
            stateOf: (agent) => superTabSeatState(
              superTabAgentGlance(SuperTabAgentInfo(controller, app, agent))
                  .state,
            ),
            machineOf: (agent) {
              final name = SuperTabAgentInfo(controller, app, agent).machine;
              return name == null ? null : superTabMachineName(name);
            },
          );
    if (tables.isEmpty) {
      return Center(
        child: Text(
          'Nobody is at a table right now.',
          key: const ValueKey('super-office-empty'),
          style: DesktopChrome.metadata(),
        ),
      );
    }
    return SingleChildScrollView(
      key: const ValueKey('super-office'),
      padding: const EdgeInsets.all(24),
      child: Wrap(
        spacing: 20,
        runSpacing: 20,
        children: [
          for (final table in tables)
            _Table(table: table, onOpen: () => onOpen(table.conversationId)),
        ],
      ),
    );
  }
}

class _Table extends StatelessWidget {
  const _Table({required this.table, required this.onOpen});
  final SuperTabOfficeTable table;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    // Seats go around the table: the first half along the top, the rest along the bottom.
    final half = (table.seats.length + 1) ~/ 2;
    Widget row(Iterable<SuperTabOfficeSeat> seats) => Wrap(
      alignment: WrapAlignment.center,
      spacing: 10,
      runSpacing: 8,
      children: [for (final seat in seats) _Seat(seat: seat)],
    );
    return Semantics(
      button: true,
      label: 'Open ${table.title}',
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: ValueKey('super-office-table-${table.conversationId}'),
          borderRadius: BorderRadius.circular(12),
          onTap: onOpen,
          child: Container(
            width: 260,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: DesktopChrome.rim),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                row(table.seats.take(half)),
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 14,
                  ),
                  decoration: BoxDecoration(
                    color: grid.AppSurface.recess,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Column(
                    children: [
                      Text(
                        table.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: DesktopChrome.text(medium: true),
                      ),
                      if (table.projectName != table.title)
                        Text(
                          table.projectName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                    ],
                  ),
                ),
                if (table.seats.length > half) ...[
                  const SizedBox(height: 10),
                  row(table.seats.skip(half)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Seat extends StatelessWidget {
  const _Seat({required this.seat});
  final SuperTabOfficeSeat seat;

  @override
  Widget build(BuildContext context) {
    final state = seat.state;
    final (color, word) = switch (state) {
      SuperTabSeatState.working => (grid.AppPalette.online, 'Working'),
      SuperTabSeatState.waiting => (grid.AppPalette.warn, 'Waiting'),
      SuperTabSeatState.idle => (grid.AppPalette.offline, 'Idle'),
      null => (null, null),
    };
    return Tooltip(
      message: [seat.name, ?word, ?seat.machine].join(' · '),
      child: SizedBox(
        width: 64,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Stack(
              clipBehavior: Clip.none,
              children: [
                SuperTabAvatar(
                  identity: '${seat.isAgent ? 'agent' : 'person'}:${seat.id}',
                  name: seat.name,
                  size: 32,
                ),
                if (color != null)
                  Positioned(
                    right: -1,
                    bottom: -1,
                    child: Container(
                      key: ValueKey(
                        'super-office-dot-${seat.id}-${state!.name}',
                      ),
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: color,
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: grid.AppPalette.panelBg,
                          width: 2,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              seat.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.control(),
            ),
            if (seat.machine case final machine?)
              Text(
                machine,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
          ],
        ),
      ),
    );
  }
}
