import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../state/app_state.dart';
import 'shared_tab_placement.dart' show plainSharedText;
import 'shared_tabs_model.dart';

/// What a pane's header says about its place in a shared tab.
typedef SharedPaneChipState = ({
  bool leader,
  SharedTabPending? joining,
  SharedTab? tab,
});

SharedPaneChipState sharedPaneChipState(
  AppNotifier app,
  String machineId,
  String agentId,
) {
  final leader = app.isTabLeader(machineId, agentId);
  final tab = app.sharedTabHolding(machineId, agentId);
  if (tab == null) return (leader: leader, joining: null, tab: null);
  final joining = app.sharedTabs.snapshot.pending
      .where(
        (p) =>
            p.op == 'add' &&
            p.sharedTabId == tab.sharedTabId &&
            p.machineId == machineId &&
            p.agentId == agentId,
      )
      .firstOrNull;
  return (leader: leader, joining: joining, tab: tab);
}

/// `Leader` (in every tab), `Make Leader` on the focused pane, `Joining…` and
/// Remove from Tab (shared tabs), beside the title of a pane. Another
/// account's strings are plain text on one ellipsized line.
class PaneSharedChips extends StatelessWidget {
  const PaneSharedChips({
    super.key,
    required this.app,
    required this.machineId,
    required this.agentId,
    required this.style,
  });

  final AppNotifier app;
  final String machineId, agentId;
  final TextStyle style;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([
      app.sharedTabs,
      app.agentMessages,
      app.experimentalFeatures,
      app,
    ]),
    builder: (context, _) {
      final state = sharedPaneChipState(app, machineId, agentId);
      final tab = state.tab;
      final focused = app.focusedPane;
      final isFocused =
          focused?.machineId == machineId && focused?.agentId == agentId;
      final leaderAction = isFocused
          ? app.leaderActionFor(machineId, agentId)
          : null;
      final makeLeader = leaderAction == 'make';
      final removeLeader = leaderAction == 'remove';
      if (tab == null && !state.leader && !makeLeader && !removeLeader) {
        return const SizedBox.shrink();
      }
      final ink = style.color ?? grid.AppPalette.textPrimary;
      final quiet = style.copyWith(color: ink.withValues(alpha: .7));
      final gap = workspaceBarCellSizeOf(context).width;
      // The Leader chip is never cut: it keeps its own width and the links
      // beside it give way first.
      Widget line(String text, TextStyle s, {String? tip, Key? key}) {
        final chip = Padding(
          padding: EdgeInsets.only(left: gap),
          child: Tooltip(
            message: tip ?? text,
            child: Text(
              text,
              key: key,
              maxLines: 1,
              softWrap: false,
              overflow: text == 'Leader'
                  ? TextOverflow.visible
                  : TextOverflow.ellipsis,
              style: s,
            ),
          ),
        );
        return text == 'Leader' ? chip : Flexible(child: chip);
      }

      final owner = plainSharedText(tab?.ownerEmail ?? '');
      final joining = state.joining;
      // A link takes what the Leader chip leaves: it shortens with an
      // ellipsis, and below [_minLink] it is not drawn at all (its gap would
      // overflow). The tooltip and the menu keep the action.
      final minLink = gap + 28;
      Widget yielding(Widget link) => Flexible(
        child: LayoutBuilder(
          builder: (context, box) =>
              box.maxWidth < minLink ? const SizedBox.shrink() : link,
        ),
      );
      Widget leaderLink(String label, Key key) => yielding(
        Padding(
          padding: EdgeInsets.only(left: gap),
          child: Tooltip(
            message: label,
            child: Semantics(
              button: true,
              label: label,
              excludeSemantics: true,
              child: InkWell(
                key: key,
                onTap: () => unawaited(app.toggleLeaderOf(machineId, agentId)),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: quiet,
                ),
              ),
            ),
          ),
        ),
      );
      final remove =
          app.canRemoveFromSharedTab(machineId, agentId) && isFocused;
      // More than the old equal share: the chips and the title (flex 4) split
      // what the header leaves.
      return Flexible(
        flex: 3,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (state.leader)
              line('Leader', quiet, key: const ValueKey('pane-chip-leader')),
            if (joining != null)
              line(
                'Joining…',
                quiet.copyWith(fontStyle: FontStyle.italic),
                key: const ValueKey('pane-chip-joining'),
                tip: owner.isEmpty
                    ? 'Waiting for the owner\'s computer'
                    : 'Waiting for $owner\'s computer',
              ),
            if (makeLeader)
              leaderLink(
                'Make Leader',
                const ValueKey('pane-chip-make-leader'),
              ),
            if (removeLeader)
              leaderLink(
                'Remove Leader',
                const ValueKey('pane-chip-remove-leader'),
              ),
            if (remove)
              yielding(
                Padding(
                  padding: EdgeInsets.only(left: gap),
                  child: InkWell(
                    key: const ValueKey('pane-chip-remove-from-tab'),
                    onTap: () => app.removeFromSharedTab(machineId, agentId),
                    child: Text(
                      'Remove from Tab',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: quiet,
                    ),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}
