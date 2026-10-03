import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../../terminal/terminal_typography.dart';

/// Compact workspace labels stay stable when terminal text is zoomed.
/// SF Mono on macOS, with the platform's monospace stack elsewhere.
const workspaceBarFontSize = 13.0;

/// Slightly tighter spaces within components, two cells between components.
/// Neighboring controls already contribute one padded cell on either side.
const workspaceBarValueGapCells = 0.75;
const workspaceBarGroupGapCells = 2.0;

/// Text retains ordinary spaces; rendering measures gaps with the shared tokens.
const workspaceBarGroupSeparator = '   ';

TextSpan workspaceBarGroupTextSpan(
  String text, {
  required double cellWidth,
  TextStyle? style,
}) {
  final groups = text.split(workspaceBarGroupSeparator);
  return TextSpan(
    style: style,
    children: [
      for (var i = 0; i < groups.length; i++) ...[
        if (i > 0)
          TextSpan(
            text: workspaceBarGroupSeparator,
            style: TextStyle(
              letterSpacing:
                  cellWidth *
                  (workspaceBarGroupGapCells -
                      workspaceBarGroupSeparator.length) /
                  workspaceBarGroupSeparator.length,
            ),
          ),
        for (final (index, word) in groups[i].split(' ').indexed) ...[
          if (index > 0)
            TextSpan(
              text: ' ',
              style: TextStyle(
                letterSpacing: cellWidth * (workspaceBarValueGapCells - 1),
              ),
            ),
          TextSpan(text: word),
        ],
      ],
    ],
  );
}

TextStyle workspaceBarTextStyle({Color? color, bool emphasized = false}) =>
    TextStyle(
      fontFamily: terminalFontFamily,
      fontFamilyFallback: terminalFontFallback,
      fontSize: workspaceBarFontSize,
      fontWeight: emphasized ? FontWeight.bold : FontWeight.normal,
      height: 1.2,
      letterSpacing: 0,
      wordSpacing: 0,
      color: color,
    );

/// Measure bar padding and controls using their own character grid.
Size workspaceBarCellSizeOf(BuildContext context) {
  final size = workspaceBarTextSizeOf(context, 'mmmmmmmmmm');
  return Size(size.width / 10, size.height);
}

/// A common click target height, including whitespace above and below text.
double workspaceBarControlHeight(BuildContext context) =>
    math.max(28, workspaceBarCellSizeOf(context).height);

Size workspaceBarTextSizeOf(
  BuildContext context,
  String text, {
  bool grouped = false,
}) {
  // Reserve both weights, including fallback glyphs, so hover never resizes a
  // control or moves a neighboring segment.
  var size = Size.zero;
  for (final emphasized in [false, true]) {
    final painter = TextPainter(
      text: grouped
          ? workspaceBarGroupTextSpan(
              text,
              cellWidth: workspaceBarCellSizeOf(context).width,
              style: workspaceBarTextStyle(emphasized: emphasized),
            )
          : TextSpan(
              text: text,
              style: workspaceBarTextStyle(emphasized: emphasized),
            ),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    size = Size(
      math.max(size.width, painter.width),
      math.max(size.height, painter.height),
    );
    painter.dispose();
  }
  return size;
}
