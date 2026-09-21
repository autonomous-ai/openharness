import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'desk_groups.dart';
import 'phone_navigation.dart';
import 'terminal_header.dart';

/// The account's tabs as a rail of names under the terminal's header — the
/// browser's own tab strip, one name per tab with a bar under the one you are
/// in.
///
/// ```
///  Desktop   Docker   Other
/// ━━━━━━━
/// ```
///
/// ⚠️ **It is not on screen by default, and that is what pays for it.** The
/// terminal IS the screen here: every permanent line of chrome above it is a
/// line of somebody's session that is not being shown, and the tab is chosen a
/// few times a day. So the mark beside `⋯` opens the rail, the rail closes
/// again the moment a tab is picked, and the terminal keeps its rows the rest
/// of the time — see [TerminalPage].
///
/// ⚠️ **A tab with nothing this phone can open is drawn, dimmed and inert.**
/// Its agents are on a machine that is asleep or wants its password. Dropping
/// it from the rail would read as a tab somebody deleted — see [DeskGroup].
class DeskTabStrip extends StatelessWidget {
  const DeskTabStrip({
    super.key,
    required this.groups,
    required this.activeId,
    required this.onPick,
  });

  /// Every tab, in the desk's own order, with the leftover group last — see
  /// [deskGroups]. Never empty.
  final List<DeskGroup> groups;

  /// [DeskGroup.id] of the tab the phone is in — see [activeDeskGroup]. Null is
  /// a real value: it is the leftover group, and it wears the bar like any
  /// other.
  final String? activeId;

  final void Function(DeskGroup group) onPick;

  /// The rail's height, which is what the header's reveal animates open to.
  ///
  /// One 15pt line, the bar under it, and the air either side that keeps the
  /// names off the header above and the output below.
  static const double height = 40;

  /// The gap between two names. Wide enough that two short tabs — `All`, `adu`
  /// — read as two, narrow enough that four fit on a phone without scrolling.
  static const double _gap = 22;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SizedBox(
      height: height,
      // Scrolls, because a desk can carry more tabs than a phone is wide. The
      // names keep their own widths — nothing is squeezed to make a row fit,
      // which is what turns tab names into `Deskt…`, `Dock…`.
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(
          horizontal: TerminalHeader.sideInset,
        ),
        itemCount: groups.length,
        separatorBuilder: (context, index) => const SizedBox(width: _gap),
        itemBuilder: (context, index) {
          final group = groups[index];
          return _DeskTabName(
            name: group.name,
            selected: group.id == activeId,
            enabled: !group.isEmpty,
            onTap: () => onPick(group),
          );
        },
      ),
    );
  }
}

/// One name in the rail, with the bar under it while it is the tab you are in.
///
/// ⚠️ **The bar is drawn in a [Stack] rather than under the text in a column.**
/// It has to be exactly as wide as the name it belongs to, and a column in a
/// horizontally scrolling list is laid out against an infinite width — there is
/// no cross-axis measure for a `stretch`ed bar to take. Stacked, the text is
/// the non-positioned child that sizes the whole thing, and the bar spans it.
class _DeskTabName extends StatelessWidget {
  const _DeskTabName({
    required this.name,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final String name;
  final bool selected;

  /// False for a tab whose agents are all out of reach: drawn dim, and it does
  /// not answer a tap.
  final bool enabled;

  final VoidCallback onTap;

  static const double _barHeight = 2;
  static const double _barGap = 5;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = switch ((enabled, selected)) {
      (false, _) => AppPalette.textFaint,
      (true, true) => AppPalette.textPrimary,
      (true, false) => AppPalette.textSecondary,
    };
    return GestureDetector(
      // Opaque, so the whole height of the rail either side of the name takes
      // the tap — a 15pt word is a small thing to hit with a thumb.
      behavior: HitTestBehavior.opaque,
      onTap: enabled ? _tapped : null,
      child: Center(
        child: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: _barGap + _barHeight),
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color,
                  fontSize: 15,
                  // The tab you are in is a weight heavier as well as darker,
                  // which is what carries it to someone who cannot see the bar
                  // — the same pairing [PhoneTabBar] uses below.
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                  height: 1.2,
                ),
              ),
            ),
            if (selected)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Container(
                  height: _barHeight,
                  decoration: BoxDecoration(
                    color: AppPalette.textPrimary,
                    borderRadius: BorderRadius.circular(_barHeight / 2),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _tapped() {
    HapticFeedback.selectionClick();
    onTap();
  }
}

/// Switch to [group]: the phone is in that tab from here, and the agent it
/// opens is the one this phone was last on in it — its first, the first time.
///
/// ⚠️ The order matters. [AppNotifier.selectDeskTab] is what settles which tab
/// an agent that sits on TWO of them belongs to (see [activeDeskGroup]); set
/// after the open, it would be read a frame too late and the rail would bar the
/// tab that was left.
void openDeskGroup(
  BuildContext context,
  AppNotifier notifier,
  DeskGroup group,
) {
  if (group.isEmpty) return;
  notifier.selectDeskTab(group.id);
  final remembered = notifier.deskLastAgentIn(group.id);
  final target = remembered != null && group.holds(remembered)
      ? remembered
      : (
          machineId: group.entries.first.machineId,
          agentId: group.entries.first.agent.id,
        );
  openAgent(context, notifier, target.machineId, target.agentId);
}
