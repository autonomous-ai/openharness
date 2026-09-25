import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/unread_marks.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'desk_groups.dart';
import 'sheet_list.dart';

/// The account's tabs as a row of pills, the one being shown filled in.
///
/// ```
///  (▓Desktop▓)  ( Docker )  ( Other )   (＋)
/// ```
///
/// It lives at the top of the tabs panel — see [DeskTabsPanel] — and picks
/// which tab's agents the list under it holds. Nothing here opens an agent: the
/// pill changes what is offered, the row below is what is chosen.
///
/// ⚠️ **Pills, not names over an underline.** The sheet around this is drawn
/// the way iOS draws its own — a filled search bar, an inset-grouped list —
/// and a bar under a word is Material's tab. A filled pill says "this one" at
/// the weight of the list it picks, rather than in a 2pt line under it.
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
    this.onRename,
    this.unreadFor,
  });

  /// Every tab, in the desk's own order — see [deskGroups]. Never empty.
  final List<DeskGroup> groups;

  /// [DeskGroup.id] of the tab whose agents are listed below. Null is the
  /// single group of a phone with no desk.
  final String? selectedId;

  final void Function(DeskGroup group) onPick;

  /// A tab of its own for an agent picked or made now. Null leaves the `+`
  /// undrawn — a desk that cannot be written to has nothing for it to do; see
  /// [AppNotifier.deskWritable].
  final VoidCallback? onAddTab;

  /// A name double-tapped. Called only for the groups that are real tabs on a
  /// desk this phone may write to.
  final void Function(DeskGroup group)? onRename;

  /// The news the agents of a tab carry that nobody has gone to yet — see
  /// `AgentUnread.mostUrgentOf`. Drawn as the rows' own [UnreadDot] before the
  /// tab's name: an agent finishing in a tab you are not reading has to say
  /// which tab it is in, or the dot is only found by opening every one of them.
  /// Null draws no marks.
  final NoticeKind? Function(DeskGroup group)? unreadFor;

  /// The row's height: a 32pt pill with 6pt either side of it, which a tap
  /// still lands in — a pill is short for a thumb, the row around it is not.
  static const double height = 44;

  /// The sheet's one side inset — see [kSheetInset] — so the first pill starts
  /// on the field's edge and the group's.
  static const double sideInset = kSheetInset;

  /// The gap between two pills: their outlines already part them, so this
  /// only has to keep two of them from reading as one wide one.
  static const double _gap = 8;

  @override
  State<DeskTabStrip> createState() => _DeskTabStripState();
}

class _DeskTabStripState extends State<DeskTabStrip> {
  /// Rides whichever pill is the selected one, so the row can be scrolled to
  /// it without knowing how wide any of the others are — pills keep their
  /// names' own widths, so there is no index-times-extent to jump to.
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

  /// Scrolls the row until the selected name sits in its middle.
  ///
  /// ⚠️ **The row's own scroll, and nothing above it.** `Scrollable.ensureVisible`
  /// walks every scrollable the name sits in, and this row sits inside the
  /// terminal page now — inside the pager that swipes between agents (see
  /// [DeskTabsPanel]). Centring a name there would drag the pager part of a
  /// page sideways, off the agent on screen.
  void _reveal(Duration duration) {
    final context = _selected.currentContext;
    if (context == null || !mounted) return;
    final name = context.findRenderObject();
    final row = Scrollable.maybeOf(context);
    if (name == null || !name.attached || row == null) return;
    unawaited(
      row.position.ensureVisible(
        name,
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
    final onRename = widget.onRename;
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
                // `+`, the button's own margin is the gap, and a pill stopping
                // an inset short of it as well reads as a row that ran out
                // rather than one that scrolls.
                right: onAddTab == null ? sideInset : 0,
              ),
              itemCount: groups.length,
              separatorBuilder: (context, index) => const SizedBox(width: gap),
              itemBuilder: (context, index) {
                final group = groups[index];
                final selected = group.id == selectedId;
                return _DeskTabPill(
                  key: selected ? _selected : null,
                  name: group.name,
                  selected: selected,
                  reachable: !group.isEmpty,
                  unread: widget.unreadFor?.call(group),
                  onTap: () => onPick(group),
                  // ⚠️ **Only the tab being SHOWN can be double-tapped, and
                  // that is a decision about the other tabs rather than about
                  // this one.** A name that has to wait and see whether a
                  // second tap is coming answers the first one 300ms late —
                  // and on every other name that first tap is the switch
                  // itself, which is the one thing on this row that has to
                  // feel immediate. On the tab already open the tap does
                  // nothing anyway, so the wait costs nothing.
                  //
                  // Null too for the no-desk group and on a desk with no
                  // writes — see [DeskTabStrip.onRename].
                  onRename: onRename == null || group.id == null || !selected
                      ? null
                      : () => onRename(group),
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

/// The `+` that opens a tab: a round pill of its own at the end of the row.
///
/// ⚠️ **An icon alone, and it can be, because of where it stands.** The other
/// `+` on this panel — the one that adds an agent to the tab being read — is a
/// row down in the list, carrying the words. Two bare `+`s would be a guess; a
/// pill among the tab pills and a labelled row in the agent list are two
/// different things before either is read. See [DeskTabsPanel].
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
          // The gap to the last pill on the inside and the strip's inset on the
          // outside are both the button's: a 32pt circle is a small target,
          // and the row around it is what the thumb actually lands in.
          padding: const EdgeInsets.only(
            left: DeskTabStrip._gap,
            right: DeskTabStrip.sideInset,
          ),
          child: Center(
            child: Container(
              width: _DeskTabPill.height,
              height: _DeskTabPill.height,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: AppGlass.hair),
              ),
              child: Icon(
                LucideIcons.plus,
                size: 16,
                color: AppPalette.textSecondary,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One tab in the row: an outlined pill, filled in while it is the tab being
/// shown.
class _DeskTabPill extends StatelessWidget {
  const _DeskTabPill({
    super.key,
    required this.name,
    required this.selected,
    required this.reachable,
    required this.unread,
    required this.onTap,
    required this.onRename,
  });

  final String name;
  final bool selected;

  /// What its agents are carrying — see [DeskTabStrip.unreadFor].
  final NoticeKind? unread;

  /// False for a tab whose agents are all out of reach — drawn dim, and still
  /// pickable. See [DeskTabStrip].
  final bool reachable;

  final VoidCallback onTap;

  /// A double tap on the pill. Null on the groups that cannot be renamed, and
  /// that is worth more than a dead callback would be: a pill with no
  /// double-tap recognizer answers a SINGLE tap at once, while one that has to
  /// wait and see whether a second is coming answers it 300ms later. So the
  /// tabs that cannot be renamed keep the snappier tap.
  final VoidCallback? onRename;

  static const double height = 32;

  /// The longest a name is drawn before it ellipsises. Far wider than any
  /// name a tab is usually given — the row scrolls, and names keep their own
  /// widths — but a name pasted in whole must not make one pill wider than
  /// the phone.
  static const double _maxLabelWidth = 220;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // The tab being shown is filled in the ink the names are written in, with
    // its name cut out of it in the sheet's own colour. One out of reach keeps
    // that shape a step dimmer: it is still the tab you are in while you read
    // why it is empty.
    final fill = !selected
        ? const Color(0x00000000)
        : reachable
        ? AppPalette.textPrimary
        : AppPalette.textSecondary;
    final ink = selected
        ? sheetFill
        : reachable
        ? AppPalette.textSecondary
        : AppPalette.textFaint;
    return Semantics(
      button: true,
      selected: selected,
      child: GestureDetector(
        // Opaque, so the whole height of the row either side of the pill takes
        // the tap — see [DeskTabStrip.height].
        behavior: HitTestBehavior.opaque,
        onTap: _tapped,
        onDoubleTap: onRename == null ? null : _renamed,
        child: Center(
          child: AnimatedContainer(
            duration: AppMotion.swap,
            curve: AppMotion.curve,
            height: height,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: fill,
              borderRadius: BorderRadius.circular(height / 2),
              border: Border.all(color: selected ? fill : AppGlass.hair),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // ⚠️ Before the name here, where the agent rows below put it at
                // their far end — see [UnreadDot]. A pill is read as one thing,
                // so the mark belongs to it wherever it sits; a column of rows
                // is not, and a leading dot there moved every name.
                //
                // The gap is the caller's: the dot carries no margin, because
                // the two placements need it on opposite sides.
                if (unread case final kind?)
                  Padding(
                    padding: const EdgeInsets.only(right: 7),
                    child: UnreadDot(kind: kind),
                  ),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: _maxLabelWidth),
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: ink,
                      fontSize: 14.5,
                      // The tab being shown is a weight heavier as well as
                      // filled, which is what carries it to someone who cannot
                      // see the fill — the same pairing [PhoneTabBar] uses
                      // below.
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _tapped() {
    HapticFeedback.selectionClick();
    onTap();
  }

  void _renamed() {
    HapticFeedback.selectionClick();
    onRename?.call();
  }
}
