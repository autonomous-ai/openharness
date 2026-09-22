import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

/// One mark in the terminal header's trailing row — the tabs grid, `⋮`,
/// and the Take control button's neighbours.
///
/// Its own file because [gap] is an invariant with arithmetic behind it and
/// a test that checks it (`terminal_header_action_test.dart`); a private class
/// inside a 2,500-line page could not be reached to check.
class TerminalHeaderAction extends StatelessWidget {
  const TerminalHeaderAction({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.size = 21,
    this.last = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;
  final double size;

  /// The rightmost action, whose trailing padding is dropped: [PhoneHeader]
  /// already insets the row's right edge, and keeping it here would push the
  /// last mark further from the edge than the others are from each other.
  final bool last;

  /// Half the gap between two marks — each neighbour contributes one, so the
  /// boxes end up 20 apart.
  ///
  /// ⚠️ **10, not 7, and the reason is the hit area rather than the look.**
  /// An action draws a 24pt box and [TouchTarget] reaches 44pt around it — 10
  /// past each edge. Two actions therefore need their centres 44 apart, and a
  /// centre-to-centre distance is `2 * gap + 24`. At the old 7 that came to 38,
  /// so the two reaches OVERLAPPED by 6pt — and a [Row] hit-tests in reverse
  /// paint order, so `⋯` was tested first and took that strip off the right
  /// edge of the tabs mark beside it. The tabs mark simply did not answer
  /// there. 10 makes it exactly 44: the targets meet and neither steals.
  ///
  /// This replaces an earlier rule that set the gap to half [PhoneHeader]'s own
  /// 14pt right inset so the marks and the screen edge read as evenly spaced.
  /// That is a nicer rhythm and it cost one of two buttons its right-hand
  /// sixth; a mark that does not respond is the worse of the two problems.
  static const double gap = 10;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(gap, 0, last ? 0 : gap, 0),
    child: AppIconButton(
      icon: icon,
      size: size,
      tooltip: tooltip,
      color: AppPalette.textSecondary,
      onPressed: onPressed,
    ),
  );
}
