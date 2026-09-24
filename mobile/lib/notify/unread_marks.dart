import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'agent_unread.dart';

/// The mark on one agent's row: it finished while you were elsewhere.
///
/// The row's own unread dot, iOS Mail's — small and in the accent, before the
/// name, so it reads before the name does and never pushes anything else off.
class UnreadDot extends StatelessWidget {
  const UnreadDot({super.key});

  static const double diameter = 8;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('unread-dot'),
    width: diameter,
    height: diameter,
    margin: const EdgeInsets.only(right: 7),
    decoration: const BoxDecoration(
      color: AppPalette.accent,
      shape: BoxShape.circle,
    ),
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
              child: IgnorePointer(child: _CountPill(count: count)),
            ),
        ],
      );
    },
  );
}

class _CountPill extends StatelessWidget {
  const _CountPill({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('unread-count'),
    constraints: const BoxConstraints(minWidth: 18),
    height: 18,
    padding: const EdgeInsets.symmetric(horizontal: 5),
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: AppPalette.accent,
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
