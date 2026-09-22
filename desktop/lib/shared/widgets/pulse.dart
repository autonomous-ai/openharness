import 'package:flutter/material.dart';

/// Static activity styling. Skeletons and status dots do not need a ticker:
/// real data changes redraw them, and indeterminate progress controls convey
/// work in flight. Retaining the builder keeps their shared peak appearance.
class Pulse extends StatelessWidget {
  const Pulse({super.key, required this.builder, this.child});

  final Widget Function(BuildContext context, double t, Widget? child) builder;
  final Widget? child;

  @override
  Widget build(BuildContext context) =>
      RepaintBoundary(child: builder(context, 1, child));
}

/// A steady status dot for a running session.
class PulseDot extends StatelessWidget {
  const PulseDot({super.key, required this.color, this.size = 6});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Pulse(
      builder: (context, t, _) {
        final opacity = 0.4 + 0.6 * t;
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: opacity),
            boxShadow: [
              BoxShadow(
                color: color.withValues(alpha: 0.5 * opacity),
                blurRadius: size * 0.85,
              ),
            ],
          ),
        );
      },
    );
  }
}
