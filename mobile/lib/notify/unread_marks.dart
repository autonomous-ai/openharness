import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'agent_notice.dart';
import 'agent_unread.dart';

/// A mark's colour says what the news is: amber for an agent waiting on you —
/// the phone's "Waiting for you" tone — and red for one that finished.
///
/// ⚠️ **Red rather than the accent, which is what this used to be.** The accent
/// is the app's ordinary indigo: it is on the selected tab, the send button, the
/// links in the output — so a dot wearing it was the same blue as half the
/// furniture around it, and it read as decoration rather than as news.
///
/// ⚠️ **[AppPalette.dangerFill] and not the theme's error ink, though this is a
/// mark and not a fill.** It is both: [UnreadCountBadge] paints the same colour
/// as a pill UNDER white lettering, and `dangerFill` is the app's one red
/// measured for exactly that (5.38:1 in dark, 6.54:1 in light — see its note).
/// `colorScheme.error` is tuned as ink on a dark surface and leaves white on it
/// at 3.42:1, so a count pill in it would fail where the dot would pass.
///
/// The name is about where that red came from, not about what it means here:
/// nothing on this row is destructive.
Color unreadColor(NoticeKind kind) => switch (kind) {
  NoticeKind.question => AppPalette.warn,
  NoticeKind.done => AppPalette.dangerFill,
};

/// The mark on one agent's row: it finished, or asked something, while you
/// were elsewhere.
///
/// ⚠️ **Where it sits is the CALLER's, and the two callers differ.** A tab chip
/// keeps it in front of the label, iOS Mail's placement: the strip is a row of
/// pills, and a mark inside one belongs to that pill wherever it is put.
///
/// An agent row does not. It used to lead the title there too, which pushed
/// every name 15pt right and broke the left edge the name shared with the two
/// lines under it — a column gone ragged for a mark that is usually absent. The
/// dot now takes the slot at the row's far end, the one that spins while the
/// agent works (`SheetAgentStatus`): a place the eye already checks for what a
/// row is doing, and the only place on the row where nothing else moves when a
/// mark appears.
///
/// So the dot carries no margin of its own — each caller spaces it — and no
/// single size: see [leading] and [trailing].
class UnreadDot extends StatelessWidget {
  const UnreadDot({super.key, required this.kind, this.diameter = leading});

  final NoticeKind kind;

  final double diameter;

  /// In front of a tab chip's label, where it has the pill to itself.
  static const double leading = 8;

  /// After an agent row's title.
  ///
  /// ⚠️ Larger than [leading], and it has to be: a dot that LEADS is found by
  /// scanning a column of them, where 8pt is plenty. This one sits at the end of
  /// a line already carrying a name, a separator and an age — at 8pt it read as
  /// punctuation after the time rather than as a mark of its own.
  static const double trailing = 11;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('unread-dot'),
    width: diameter,
    height: diameter,
    decoration: BoxDecoration(color: unreadColor(kind), shape: BoxShape.circle),
  );
}

/// [child] with the count of agents carrying news in its top-right corner —
/// the dial's bell pill. Nothing is drawn while the count is zero.
///
/// Listens to [unread] alone, so a mark appearing redraws this badge and not
/// the page it sits on.
class UnreadCountBadge extends StatelessWidget {
  const UnreadCountBadge({
    super.key,
    required this.unread,
    required this.child,
  });

  final AgentUnread unread;
  final Widget child;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: unread,
    child: child,
    builder: (context, child) {
      final count = unread.count;
      return Stack(
        clipBehavior: Clip.none,
        children: [
          child!,
          if (count > 0)
            Positioned(
              top: -4,
              right: -4,
              child: IgnorePointer(
                child: _CountPill(
                  count: count,
                  // Amber as soon as ONE of them is waiting on you: that is
                  // the one the count is there to send you to.
                  color: unreadColor(
                    unread.anyQuestion ? NoticeKind.question : NoticeKind.done,
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
}

class _CountPill extends StatelessWidget {
  const _CountPill({required this.count, required this.color});

  final int count;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('unread-count'),
    constraints: const BoxConstraints(minWidth: 18),
    height: 18,
    padding: const EdgeInsets.symmetric(horizontal: 5),
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(9),
    ),
    child: Text(
      count > 9 ? '9+' : '$count',
      style: const TextStyle(
        color: Colors.white,
        fontSize: 11,
        fontWeight: FontWeight.w700,
        height: 1,
      ),
    ),
  );
}
