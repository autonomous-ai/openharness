import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';

/// The gap between two cards in a phone list.
const double kPhoneCardGap = 10;

/// A phone card row's height: a 44pt glyph plus its padding. The skeleton is drawn at exactly
/// this, so a list that answers does not jump.
const double kPhoneCardHeight = 70;

/// An agent card's height. Taller than [kPhoneCardHeight] by one line, because an agent row carries
/// a third: its name, what it is doing, and — [AgentContextLine] — where it is. The alternative was
/// folding the folder and the machine into the status line, which is what the Agents tab did while
/// it had two lines, and at that width the status was the part that truncated.
const double kPhoneAgentCardHeight = 88;

/// A phone list's padding: clear of the screen edges, and of the home indicator at the bottom.
EdgeInsets phoneListPadding(BuildContext context) =>
    EdgeInsets.fromLTRB(16, 4, 16, MediaQuery.paddingOf(context).bottom + 24);

/// A tappable row on the phone: a glass card that sinks a little under the finger. Without an
/// [onTap] it is drawn dimmed and does not move.
class PhoneCard extends StatefulWidget {
  const PhoneCard({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.border,
    this.height = kPhoneCardHeight,
  });

  final Widget child;
  final VoidCallback? onTap;

  /// The row's own `⋯` menu — a phone has no right-click, and a list row has nowhere to put a
  /// button without crowding what the row is for.
  ///
  /// ⚠️ Deliberately independent of [onTap]: a row that cannot be OPENED can still be acted on,
  /// and an agent whose terminal is gone is exactly the one somebody wants to delete. The dimming
  /// below stays tied to [onTap] alone, because it says "this will not open", not "inert".
  final VoidCallback? onLongPress;

  /// Overrides the card's hairline rim. Used to mark a row that needs attention — a waiting agent —
  /// so it is findable in a long list before a word of it is read. Null keeps the ordinary rim.
  final BoxBorder? border;

  /// The row's height. [kPhoneAgentCardHeight] for the three-line agent rows; the two-line default
  /// for everything else. Fixed either way, so a list of cards stays a regular column rather than
  /// a ladder of uneven rungs.
  final double height;

  @override
  State<PhoneCard> createState() => _PhoneCardState();
}

class _PhoneCardState extends State<PhoneCard> {
  bool _pressed = false;

  bool get _interactive => widget.onTap != null || widget.onLongPress != null;

  void _press(bool pressed) {
    if (!_interactive || _pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => _press(true),
      onTapUp: (_) => _press(false),
      onTapCancel: () => _press(false),
      onTap: widget.onTap,
      // Released here as well as in `onTapCancel`: the card must not stay sunk under the sheet
      // this opens, which outlives the gesture that opened it.
      onLongPress: widget.onLongPress == null
          ? null
          : () {
              _press(false);
              widget.onLongPress!();
            },
      child: AnimatedScale(
        scale: _pressed ? 0.975 : 1,
        duration: AppMotion.press,
        curve: AppMotion.curve,
        child: AnimatedContainer(
          duration: AppMotion.press,
          curve: AppMotion.curve,
          height: widget.height,
          padding: const EdgeInsets.symmetric(horizontal: 13),
          decoration: BoxDecoration(
            color: _pressed ? AppGlass.rowHoverFill : AppGlass.rowFill,
            borderRadius: BorderRadius.circular(AppCard.radius),
            border: widget.border ?? Border.all(color: AppGlass.hair),
          ),
          child: Opacity(
            opacity: widget.onTap == null ? 0.55 : 1,
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

/// The square glyph at the head of a card — a machine's screen, an agent's engine mark.
class PhoneCardGlyph extends StatelessWidget {
  const PhoneCardGlyph({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: AppSurface.recess,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Center(child: child),
    );
  }
}

/// A pull-to-refresh list of cards, laid out the one way every phone list is.
class PhoneCardList extends StatelessWidget {
  const PhoneCardList({
    super.key,
    required this.onRefresh,
    required this.itemCount,
    required this.itemBuilder,
  });

  final Future<void> Function() onRefresh;
  final int itemCount;
  final IndexedWidgetBuilder itemBuilder;

  @override
  Widget build(BuildContext context) => RefreshIndicator(
    onRefresh: onRefresh,
    child: ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: phoneListPadding(context),
      itemCount: itemCount,
      separatorBuilder: (_, _) => const SizedBox(height: kPhoneCardGap),
      itemBuilder: itemBuilder,
    ),
  );
}

/// A list of cards that has not answered yet: the same cards, empty, at a real row's height.
class PhoneListSkeleton extends StatelessWidget {
  const PhoneListSkeleton({
    super.key,
    this.rows = 3,
    this.height = kPhoneCardHeight,
  });

  final int rows;

  /// The height of the cards this list is standing in for — pass [kPhoneAgentCardHeight] where
  /// agents will land, so the list does not jump a row taller the moment they arrive.
  final double height;

  @override
  Widget build(BuildContext context) => ListView.separated(
    physics: const NeverScrollableScrollPhysics(),
    padding: phoneListPadding(context),
    itemCount: rows,
    separatorBuilder: (_, _) => const SizedBox(height: kPhoneCardGap),
    itemBuilder: (_, _) => Skeleton(
      width: double.infinity,
      height: height,
      radius: AppCard.radius,
    ),
  );
}
