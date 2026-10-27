import 'package:flutter/material.dart';

import '../../widgets/desktop_chrome.dart';

/// A thin rounded bar that glides to its new length when the board refreshes.
class LeaderboardProgressBar extends StatelessWidget {
  const LeaderboardProgressBar({
    super.key,
    required this.fraction,
    this.height = 6,
  });
  final double fraction;
  final double height;

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(height),
    child: SizedBox(
      height: height,
      child: ColoredBox(
        color: DesktopChrome.rim,
        child: Align(
          alignment: Alignment.centerLeft,
          child: TweenAnimationBuilder<double>(
            tween: Tween(end: fraction.clamp(0, 1).toDouble()),
            duration: const Duration(milliseconds: 450),
            curve: Curves.easeOutCubic,
            builder: (context, value, _) => FractionallySizedBox(
              widthFactor: value,
              heightFactor: 1,
              child: ColoredBox(color: DesktopChrome.accent),
            ),
          ),
        ),
      ),
    ),
  );
}
