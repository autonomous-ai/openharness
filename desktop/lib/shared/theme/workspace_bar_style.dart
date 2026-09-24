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
  final painter = TextPainter(
    text: TextSpan(text: 'mmmmmmmmmm', style: workspaceBarTextStyle()),
    textDirection: TextDirection.ltr,
    textScaler: MediaQuery.textScalerOf(context),
  )..layout();
  final size = Size(painter.width / 10, painter.height);
  painter.dispose();
  return size;
}
