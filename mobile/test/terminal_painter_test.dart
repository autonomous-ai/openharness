import 'dart:ui';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
// The painter is xterm's own, vendored and patched here (third_party/xterm,
// README.autonomous.md) — not API the package offers.
// ignore: implementation_imports
import 'package:xterm/src/ui/painter.dart';

/// A canvas that counts the glyphs it is asked to draw.
class _GlyphCounter implements Canvas {
  int glyphs = 0;

  @override
  void drawParagraph(Paragraph paragraph, Offset offset) => glyphs++;

  @override
  void drawRect(Rect rect, Paint paint) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Every frame paints every cell on screen, so what a cell costs is paid ~2,000
/// times a frame on a phone.
void main() {
  int glyphsDrawnFor(String output) {
    final terminal = Terminal()..write(output);
    final canvas = _GlyphCounter();
    TerminalPainter(
      theme: TerminalThemes.defaultTheme,
      textStyle: const TerminalStyle(),
      textScaler: TextScaler.noScaling,
    ).paintLine(canvas, Offset.zero, terminal.buffer.lines[0]);
    return canvas.glyphs;
  }

  test('a space costs no glyph', () {
    expect(glyphsDrawnFor('a  b    '), 2);
  });

  test('an underlined space still draws its underline', () {
    expect(glyphsDrawnFor('\x1b[4m \x1b[0m'), 1);
  });
}
