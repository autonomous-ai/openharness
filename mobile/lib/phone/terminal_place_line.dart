import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The header's second line: *machine · folder ⑂ branch*, the desktop pane
/// header's order (`PromptContextView`), each behind its mark.
///
/// Each name is laid out at the width it asks for, and only the overflow is
/// shared out — see [placeWidths].
///
/// ⚠️ **A `flex` here would ellipsis a name with the room to spare beside it.**
/// `Flexible`s split the line in their own fixed ratio whatever they hold, so a
/// short folder hands its slack back to the empty end of the row rather than to
/// the branch, and `worktree-command-box` is cut next to a gap.
class TerminalPlaceLine extends StatelessWidget {
  const TerminalPlaceLine({
    super.key,
    required this.machine,
    required this.folder,
    required this.branch,
    required this.style,
  });

  /// Null or empty leaves that part, and its mark, out.
  final String? machine, folder, branch;

  final TextStyle style;

  static const double _markSize = 12;
  static const double _gapAfterMark = 3;
  static const double _gapBetween = 8;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final places = [
      if (machine case final text? when text.isNotEmpty)
        (icon: LucideIcons.monitor300, text: text, givesWay: 1),
      if (folder case final text? when text.isNotEmpty)
        (icon: LucideIcons.folder300, text: text, givesWay: 2),
      if (branch case final text? when text.isNotEmpty)
        (icon: LucideIcons.gitBranch300, text: text, givesWay: 0),
    ];
    if (places.isEmpty) return const SizedBox.shrink();
    return LayoutBuilder(
      builder: (context, constraints) {
        final line = constraints.maxWidth;
        // The marks and the gaps are spent before any name gets a say.
        final free = math.max(
          0.0,
          line -
              places.length * (_markSize + _gapAfterMark) -
              (places.length - 1) * _gapBetween,
        );
        final widths = placeWidths(
          wanted: [
            for (final place in places) _measure(context, place.text, line),
          ],
          givesWay: [for (final place in places) place.givesWay],
          free: free,
        );
        return Row(
          children: [
            for (final (i, place) in places.indexed) ...[
              if (i > 0) const SizedBox(width: _gapBetween),
              Icon(place.icon, size: _markSize, color: AppPalette.textFaint),
              const SizedBox(width: _gapAfterMark),
              SizedBox(
                width: widths[i],
                child: Text(
                  place.text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: style,
                ),
              ),
            ],
          ],
        );
      },
    );
  }

  /// How wide [text] wants to be on one line, capped at [limit] so a very long
  /// name does not measure out to something the arithmetic cannot use.
  double _measure(BuildContext context, String text, double limit) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      maxLines: 1,
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return math.min(width, limit);
  }
}

/// What a name is never cut below while another can still give, so it keeps
/// enough characters to be told from its neighbours rather than becoming `…`.
const double kPlaceFloor = 54;

/// The widths [wanted] get on a line with [free] room: whole where they fit,
/// and otherwise cut in [givesWay] order — lowest first — each down to
/// [kPlaceFloor] before the next is touched, and below the floors only once
/// every name is at its own.
///
/// ⚠️ **The branch gives way first, then the machine; the folder is the one
/// kept whole.** The folder is what tells two of an owner's agents apart; the
/// machine is one of a handful, recognisable from its first letters, and a
/// branch is read to its end least often of all.
List<double> placeWidths({
  required List<double> wanted,
  required List<int> givesWay,
  required double free,
}) {
  final widths = [...wanted];
  var over = wanted.fold(0.0, (sum, width) => sum + width) - free;
  final order = [for (var i = 0; i < wanted.length; i++) i]
    ..sort((a, b) => givesWay[a].compareTo(givesWay[b]));
  for (final floor in [kPlaceFloor, 0.0]) {
    for (final i in order) {
      if (over <= 0) return widths;
      final give = math.min(over, widths[i] - math.min(floor, widths[i]));
      if (give <= 0) continue;
      widths[i] -= give;
      over -= give;
    }
  }
  return widths;
}
