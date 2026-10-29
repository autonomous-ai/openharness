import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';

/// The leaderboard's three lists (Dee, 2026-10-29): people, the permanent
/// agents (the PM and Buddies), and the temporary workers by model.
enum LeaderboardTab { humans, agents, models }

extension LeaderboardTabLabel on LeaderboardTab {
  String get label => switch (this) {
    LeaderboardTab.humans => 'Humans',
    LeaderboardTab.agents => 'Agents',
    LeaderboardTab.models => 'Models',
  };
}

/// The board's heading: Humans, Agents and Models as scope pills, the
/// chosen one selected (the design system's scope selector), then [actions]
/// (the week, Invite people) at the trailing edge. In a pane too narrow for
/// one line the actions take the next one.
class LeaderboardHeader extends StatelessWidget {
  const LeaderboardHeader({
    super.key,
    required this.selected,
    required this.onSelect,
    this.actions = const [],
  });
  final LeaderboardTab selected;
  final ValueChanged<LeaderboardTab> onSelect;
  final List<Widget> actions;

  static const _gap = grid.AppDesktop.controlGap;

  @override
  Widget build(BuildContext context) => Padding(
    // The section headings' insets: the spacing scale's 16, 12 and 4.
    padding: const EdgeInsets.fromLTRB(
      DesktopChrome.groupGap,
      0,
      _gap + _gap / 2,
      _gap / 2,
    ),
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: DesktopChrome.controlHeight),
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: _gap,
        runSpacing: _gap / 2,
        children: [
          // Enlarged text in a narrow pane scrolls the pills rather than
          // cutting a name short.
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final tab in LeaderboardTab.values) ...[
                  if (tab != LeaderboardTab.values.first)
                    const SizedBox(width: _gap / 2),
                  DesktopPill(
                    key: ValueKey('leaderboard-tab-${tab.name}'),
                    label: tab.label,
                    compact: true,
                    selected: tab == selected,
                    onPressed: () => onSelect(tab),
                  ),
                ],
              ],
            ),
          ),
          if (actions.isNotEmpty)
            Row(mainAxisSize: MainAxisSize.min, children: actions),
        ],
      ),
    ),
  );
}
