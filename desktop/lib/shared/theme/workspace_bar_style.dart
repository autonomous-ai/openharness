import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../../terminal/terminal_typography.dart';

/// Compact workspace labels stay stable when terminal text is zoomed.
/// SF Mono on macOS, with the platform's monospace stack elsewhere.
const workspaceBarFontSize = 13.0;

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

Size workspaceBarTextSizeOf(BuildContext context, String text) {
  // Reserve both weights, including fallback glyphs, so hover never resizes a
  // control or moves a neighboring segment.
  var size = Size.zero;
  for (final emphasized in [false, true]) {
    final painter = TextPainter(
      text: TextSpan(
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
