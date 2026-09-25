import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../../terminal/terminal_typography.dart';

/// Compact workspace labels stay stable when terminal text is zoomed.
/// SF Mono on macOS, with the platform's monospace stack elsewhere.
const workspaceBarFontSize = 13.0;

TextStyle workspaceBarTextStyle({Color? color}) => TextStyle(
  fontFamily: terminalFontFamily,
  fontFamilyFallback: terminalFontFallback,
  fontSize: workspaceBarFontSize,
  fontWeight: FontWeight.normal,
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

/// A common highlight height, including the whitespace above and below text.
double workspaceBarControlHeight(BuildContext context) =>
    math.max(28, workspaceBarCellSizeOf(context).height);

Size workspaceBarTextSizeOf(BuildContext context, String text) {
  final painter = TextPainter(
    text: TextSpan(text: text, style: workspaceBarTextStyle()),
    textDirection: TextDirection.ltr,
    textScaler: MediaQuery.textScalerOf(context),
  )..layout();
  final size = painter.size;
  painter.dispose();
  return size;
}
