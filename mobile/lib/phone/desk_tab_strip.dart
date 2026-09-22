import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'desk_groups.dart';

/// The account's tabs as a row of names, with a bar under the one being shown.
///
/// ```
///  Desktop   Docker   Other
/// ━━━━━━━
/// ```
///
/// It lives at the top of the tabs popup — see [showDeskTabsPopup] — and picks
/// which tab's agents the row under it lists. Nothing here opens an agent: the
/// name changes what is offered, the card below is what is chosen.
///
/// ⚠️ **A tab with nothing this phone can open is drawn dim, but still picked.**
/// Its agents are on a machine that is asleep or wants its password. Dropping it
/// from the row would read as a tab somebody deleted, and refusing the tap would
/// leave the person tapping a name that never answers — picked, it says what is
/// wrong in the space below, where there is room for the sentence.
class DeskTabStrip extends StatelessWidget {
  const DeskTabStrip({
    super.key,
    required this.groups,
    required this.selectedId,
    required this.onPick,
  });

  /// Every tab, in the desk's own order, with the leftover group last — see
  /// [deskGroups]. Never empty.
  final List<DeskGroup> groups;

  /// [DeskGroup.id] of the tab whose agents are listed below. Null is a real
  /// value: it is the leftover group, and it wears the bar like any other.
  final String? selectedId;

  final void Function(DeskGroup group) onPick;

  /// The row's height, which the popup counts into its own.
  ///
  /// One 15pt line, the bar under it, and the air that keeps the names off the
  /// drag handle above and the cards below.
  static const double height = 40;

  /// The popup's own side inset — the measure [showPhoneSheet] gives its rows,
  /// so the first name starts on the same line as everything else in a sheet.
  static const double sideInset = 20;

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
        padding: const EdgeInsets.symmetric(horizontal: sideInset),
        itemCount: groups.length,
        separatorBuilder: (context, index) => const SizedBox(width: _gap),
        itemBuilder: (context, index) {
          final group = groups[index];
          return _DeskTabName(
            name: group.name,
            selected: group.id == selectedId,
            reachable: !group.isEmpty,
            onTap: () => onPick(group),
          );
        },
      ),
    );
  }
}

/// One name in the row, with the bar under it while it is the tab being shown.
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
    required this.reachable,
    required this.onTap,
  });

  final String name;
  final bool selected;

  /// False for a tab whose agents are all out of reach — drawn dim, and still
  /// pickable. See [DeskTabStrip].
  final bool reachable;

  final VoidCallback onTap;

  static const double _barHeight = 2;
  static const double _barGap = 5;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = switch ((reachable, selected)) {
      (false, _) => AppPalette.textFaint,
      (true, true) => AppPalette.textPrimary,
      (true, false) => AppPalette.textSecondary,
    };
    return GestureDetector(
      // Opaque, so the whole height of the row either side of the name takes
      // the tap — a 15pt word is a small thing to hit with a thumb.
      behavior: HitTestBehavior.opaque,
      onTap: _tapped,
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
                  // The tab being shown is a weight heavier as well as darker,
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
                    // The bar keeps the primary ink even under a dim name: it
                    // marks where you are, and a tab out of reach is still
                    // where you are while you are reading it.
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
