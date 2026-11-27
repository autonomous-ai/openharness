import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/box_glyphs.dart';
import 'package:xterm/xterm.dart';

/// A font's `┃` covers its ascent and descent, not the row: OpenCode's panel
/// sides and Claude Code's boxes showed a gap at every row (a PC at 125%: 19
/// of 20 device pixels). Box drawing is drawn from cell edge to cell edge.
void main() {
  setUpAll(() async {
    final face = File('assets/fonts/roboto-mono/RobotoMono.ttf');
    final loader = FontLoader('Roboto Mono')
      ..addFont(Future.value(ByteData.sublistView(face.readAsBytesSync())));
    await loader.load();
  });

  group('BoxGlyph', () {
    test('draws every light and heavy line, dash, arc and diagonal', () {
      for (var code = 0x2500; code <= 0x257F; code++) {
        final double = code >= 0x2550 && code <= 0x256C;
        expect(
          BoxGlyph.lookup(code) == null,
          double,
          reason: code.toRadixString(16),
        );
      }
      expect(BoxGlyph.lookup(0x24FF), isNull);
      expect(BoxGlyph.lookup(0x2580), isNull);
    });

    test('a vertical line spans the cell and a heavy one is thicker', () {
      const cell = Rect.fromLTWH(10, 20, 8.4, 16.8);
      final light = BoxGlyph.lookup(0x2502)!.rects(cell, 1.25);
      final heavy = BoxGlyph.lookup(0x2503)!.rects(cell, 1.25);
      double top(List<Rect> r) =>
          r.map((e) => e.top).reduce((a, b) => a < b ? a : b);
      double bottom(List<Rect> r) =>
          r.map((e) => e.bottom).reduce((a, b) => a > b ? a : b);
      for (final rects in [light, heavy]) {
        expect(top(rects) * 1.25, closeTo(25, 1e-9));
        expect(bottom(rects) * 1.25, closeTo(46, 1e-9));
      }
      expect(heavy.first.width, greaterThan(light.first.width));
    });

    test('a corner covers its joint: the arms overlap, no notch', () {
      const cell = Rect.fromLTWH(0, 0, 9, 18);
      final corner = BoxGlyph.lookup(0x250C)!.rects(cell, 2); // ┌
      final down = corner.firstWhere((r) => r.bottom == 18);
      final right = corner.firstWhere((r) => r.right == 9);
      expect(down.overlaps(right), isTrue);
      expect(down.left, right.left);
      expect(down.top, right.top);
    });
  });

  /// Device pixel rows down the centre of column 0, whose colour is the
  /// terminal's background, for [glyph] written on every row.
  Future<List<int>> gaps(
    WidgetTester tester,
    double ratio,
    String glyph, {
    bool across = false,
  }) async {
    tester.view.devicePixelRatio = ratio;
    tester.view.physicalSize = Size(400 * ratio, 400 * ratio);
    addTearDown(tester.view.reset);

    final terminal = Terminal(maxLines: 100);
    final boundary = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        home: RepaintBoundary(
          key: boundary,
          child: SizedBox(
            width: 400,
            height: 400,
            child: TerminalView(
              terminal,
              textStyle: const TerminalStyle(
                fontFamily: 'Roboto Mono',
                fontSize: 14,
                height: 1.2,
              ),
            ),
          ),
        ),
      ),
    );
    final rows = terminal.viewHeight;
    if (across) {
      terminal.write('\x1b[1;1H${glyph * terminal.viewWidth}');
    } else {
      for (var row = 1; row <= rows; row++) {
        terminal.write('\x1b[$row;1H$glyph');
      }
    }
    await tester.pump();

    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final bytes = (await tester.runAsync(() async {
      final image = await render.toImage(pixelRatio: ratio);
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      image.dispose();
      return data!;
    }))!;
    final width = (400 * ratio).round();
    final background = TerminalThemes.defaultTheme.background;
    bool isBackground(int x, int y) {
      final i = (y * width + x) * 4;
      return Color.fromARGB(
            255,
            bytes.getUint8(i),
            bytes.getUint8(i + 1),
            bytes.getUint8(i + 2),
          ) ==
          background;
    }

    final row = (17 * ratio).round();
    if (across) {
      // One row of `─` across every column (8.4 wide), along its stroke.
      final end = (terminal.viewWidth * 8.4 * ratio).floor() - 1;
      final strokeY = [
        for (var dy = 0; dy < row; dy++)
          if (!isBackground(4, dy)) dy,
      ].first;
      return [
        for (var x = 0; x < end; x++)
          if (isBackground(x, strokeY)) x,
      ];
    }
    // The stroke's column: the first non-background pixel across row 0, a
    // quarter of the way down (a two-dash `╎` leaves the middle empty).
    final strokeX = [
      for (var x = 0; x < (9 * ratio).round(); x++)
        if (!isBackground(x, row * 3 ~/ 10)) x,
    ].first;
    return [
      for (var y = 0; y < rows * row; y++)
        if (isBackground(strokeX, y)) y,
    ];
  }

  for (final ratio in [1.0, 1.25, 1.5, 1.75, 2.0]) {
    for (final glyph in ['┃', '│', '╎']) {
      final dashed = glyph == '╎';
      testWidgets(
        '$glyph down every row ${dashed ? 'keeps its dashes' : 'has no gap'} '
        'at ${ratio}x',
        (tester) async {
          final found = await gaps(tester, ratio, glyph);
          if (dashed) {
            expect(found, isNotEmpty);
          } else {
            expect(found, isEmpty);
          }
        },
      );
    }

    testWidgets('─ across every column has no gap at ${ratio}x', (
      tester,
    ) async {
      expect(await gaps(tester, ratio, '─', across: true), isEmpty);
    });
  }
}
