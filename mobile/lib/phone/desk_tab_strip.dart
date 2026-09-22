import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

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
///
/// ⚠️ **It scrolls, and the tab being shown is scrolled TO.** A desk of a dozen
/// tabs is wider than a phone, and the one you are in is as likely to be the
/// tenth as the first — opened at the left-hand end, the panel would say
/// nothing about where you are until a thumb went looking. See
/// [_DeskTabStripState._reveal].
class DeskTabStrip extends StatefulWidget {
  const DeskTabStrip({
    super.key,
    required this.groups,
    required this.selectedId,
    required this.onPick,
    this.onAddTab,
  });

  /// Every tab, in the desk's own order, with the leftover group last — see
  /// [deskGroups]. Never empty.
  final List<DeskGroup> groups;

  /// [DeskGroup.id] of the tab whose agents are listed below. Null is a real
  /// value: it is the leftover group, and it wears the bar like any other.
  final String? selectedId;

  final void Function(DeskGroup group) onPick;

  /// A tab of its own for an agent picked or made now. Null leaves the `+`
  /// undrawn — a desk that cannot be written to has nothing for it to do; see
  /// [AppNotifier.deskWritable].
  final VoidCallback? onAddTab;

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
  State<DeskTabStrip> createState() => _DeskTabStripState();
}

class _DeskTabStripState extends State<DeskTabStrip> {
  /// Rides whichever name is the selected one, so the row can be scrolled to
  /// it without knowing how wide any of the others are — names keep their own
  /// widths here, so there is no index-times-extent to jump to.
  final _selected = GlobalKey();

  @override
  void initState() {
    super.initState();
    // The panel is on its way up as this runs: no animation, because there is
    // nothing yet for a scroll to be seen moving against.
    WidgetsBinding.instance.addPostFrameCallback((_) => _reveal(Duration.zero));
  }

  @override
  void didUpdateWidget(DeskTabStrip old) {
    super.didUpdateWidget(old);
    // A tab picked by hand is already under the thumb; this is for the ones
    // picked by something else — a tab made by the `+`, which lands at the far
    // right of a row that was not scrolled there.
    if (old.selectedId != widget.selectedId) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _reveal(const Duration(milliseconds: 220)),
      );
    }
  }

  void _reveal(Duration duration) {
    final context = _selected.currentContext;
    if (context == null || !mounted) return;
    unawaited(
      Scrollable.ensureVisible(
        context,
        // Centred rather than merely brought inside the edge: a name flush
        // against the right-hand end reads as the last tab there is.
        alignment: 0.5,
        duration: duration,
        curve: Curves.easeOutCubic,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final groups = widget.groups;
    final selectedId = widget.selectedId;
    final onPick = widget.onPick;
    final onAddTab = widget.onAddTab;
    const sideInset = DeskTabStrip.sideInset;
    const height = DeskTabStrip.height;
    const gap = DeskTabStrip._gap;
    return SizedBox(
      height: height,
      child: Row(
        children: [
          Expanded(
            // Scrolls, because a desk can carry more tabs than a phone is wide.
            // The names keep their own widths — nothing is squeezed to make a
            // row fit, which is what turns tab names into `Deskt…`, `Dock…`.
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: EdgeInsets.only(
                left: sideInset,
                // A full inset only where the row ends in nothing. Beside the
                // `+`, the button's own margin is the gap, and a name stopping
                // an inset short of it as well reads as a row that ran out
                // rather than one that scrolls.
                right: onAddTab == null ? sideInset : 4,
              ),
              itemCount: groups.length,
              separatorBuilder: (context, index) => const SizedBox(width: gap),
              itemBuilder: (context, index) {
                final group = groups[index];
                final selected = group.id == selectedId;
                return _DeskTabName(
                  key: selected ? _selected : null,
                  name: group.name,
                  selected: selected,
                  reachable: !group.isEmpty,
                  onTap: () => onPick(group),
                );
              },
            ),
          ),
          // ⚠️ **Pinned beside the names, not carried at the end of them.** The
          // row scrolls, and a `+` that scrolls with it is a control that goes
          // away exactly when the desk is big enough to want another tab. Out
          // here it is always the rightmost thing on the row — which is also
          // what says it belongs to the row rather than to the list below.
          if (onAddTab != null) _AddTabButton(onTap: onAddTab),
        ],
      ),
    );
  }
}

/// The `+` that opens a tab, at the right-hand end of the names.
///
/// ⚠️ **An icon alone, and it can be, because of where it stands.** The other
/// `+` on this panel — the one that adds an agent to the tab being read — is a
/// full-width row down in the list, carrying the words. Two bare `+`s would be
/// a guess; a mark on the tab row and a labelled row in the agent list are two
/// different things before either is read. See [showDeskTabsPopup].
class _AddTabButton extends StatelessWidget {
  const _AddTabButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'New tab',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: Padding(
          // A thumb's worth of row either side of a 20pt glyph, and the strip's
          // own inset on the outside so it lines up with `⋯` in the header.
          padding: const EdgeInsets.only(
            left: 10,
            right: DeskTabStrip.sideInset,
          ),
          child: Center(
            child: Icon(
              LucideIcons.plus300,
              size: 20,
              color: AppPalette.textSecondary,
            ),
          ),
        ),
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
    super.key,
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
