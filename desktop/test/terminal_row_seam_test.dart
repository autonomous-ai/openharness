import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// A full-screen program (OpenCode, any TUI) paints a panel colour on every
/// row. At 125%, 150% or 175% display scaling a row edge used to fall inside a
/// device pixel; the rows on either side each covered part of it, and the
/// terminal's own background showed through as a dark stripe every few rows.
/// The grid now sits on whole device pixels, so nothing drawn row by row (a
/// background, a selection) leaves a stripe.
void main() {
  setUpAll(() async {
    // The test font's cells are 16 pixels tall, a whole device pixel at every
    // scale tried here. The bundled face at 14 x 1.2 is 17 tall, as on a PC.
    final face = File('assets/fonts/roboto-mono/RobotoMono.ttf');
    final loader = FontLoader('Roboto Mono')
      ..addFont(Future.value(ByteData.sublistView(face.readAsBytesSync())));
    await loader.load();
  });

  /// The device pixel rows, down one column of the grid, whose colour differs
  /// from the middle of the first row.
  Future<List<int>> stripes(
    WidgetTester tester,
    double ratio, {
    double top = 0,
    bool selected = false,
  }) async {
    tester.view.devicePixelRatio = ratio;
    tester.view.physicalSize = Size(400 * ratio, 400 * ratio);
    addTearDown(tester.view.reset);

    final terminal = Terminal(maxLines: 100);
    final controller = TerminalController();
    final boundary = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        home: RepaintBoundary(
          key: boundary,
          child: Padding(
            padding: EdgeInsets.only(top: top),
            child: SizedBox(
              width: 400,
              height: 400 - top,
              child: TerminalView(
                terminal,
                controller: controller,
                textStyle: const TerminalStyle(
                  fontFamily: 'Roboto Mono',
                  fontSize: 14,
                  height: 1.2,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    final rows = terminal.viewHeight;
    final fill = ' ' * terminal.viewWidth;
    if (!selected) terminal.write('\x1b[48;2;32;80;160m');
    for (var row = 1; row <= rows; row++) {
      terminal.write('\x1b[$row;1H$fill');
    }
    if (selected) {
      // The theme's selection is translucent: an overlap shows as much as a gap.
      controller.setSelection(
        terminal.buffer.createAnchor(0, 0),
        terminal.buffer.createAnchor(terminal.viewWidth - 1, rows - 1),
      );
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

    // The grid starts on the device pixel nearest the pane's top, and a row is
    // 17 logical pixels rounded to whole device pixels (21 at 125%).
    final width = (400 * ratio).round();
    final x = (10 * ratio).round();
    final row = (17 * ratio).round();
    final start = (top * ratio).round();
    final end = start + rows * row;
    int pixel(int y) => bytes.getUint32((y * width + x) * 4);
    final expected = pixel(start + row ~/ 2);
    return [
      for (var y = start; y < end; y++)
        if (pixel(y) != expected) y,
    ];
  }

  for (final ratio in [1.0, 1.25, 1.5, 1.75, 2.0]) {
    testWidgets('rows of one background join without a stripe at ${ratio}x', (
      tester,
    ) async {
      expect(await stripes(tester, ratio), isEmpty);
    });

    testWidgets('a selection over many rows has no stripe at ${ratio}x', (
      tester,
    ) async {
      expect(await stripes(tester, ratio, selected: true), isEmpty);
    });
  }

  // A pane can start part way into a device pixel (measured on a PC at 125%:
  // a 1.25x pitch with every edge on a half pixel). Every row edge lands there.
  for (final ratio in [1.25, 1.5]) {
    testWidgets('a terminal placed between device pixels at ${ratio}x', (
      tester,
    ) async {
      expect(await stripes(tester, ratio, top: 0.4), isEmpty);
    });
  }
}
