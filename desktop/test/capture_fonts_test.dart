import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';

import 'support/capture.dart';

void main() {
  setUpAll(() => loadCaptureFonts('capture-enabled'));
  testWidgets('capture fonts draw the plus action instead of a missing glyph', (
    tester,
  ) async {
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Center(
          child: RepaintBoundary(
            key: boundaryKey,
            child: const SizedBox(
              width: 32,
              height: 32,
              child: Icon(AppIcons.plus, size: 32, color: Colors.white),
            ),
          ),
        ),
      ),
    );
    final boundary =
        boundaryKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    await tester.runAsync(() async {
      final image = await boundary.toImage();
      try {
        final pixels = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
        // The plus paints its center; a missing-glyph box leaves it empty.
        expect(pixels!.getUint8((16 * 32 + 16) * 4 + 3), greaterThan(128));
      } finally {
        image.dispose();
      }
    });
  });
}
