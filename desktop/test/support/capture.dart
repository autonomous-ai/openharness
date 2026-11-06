import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'real_fonts.dart';

/// Fonts for a test that can also write what it draws.
///
/// Captures load the app's icon faces alongside the actual Mac system face
/// or the shared metric-compatible text faces on Windows and Linux.
Future<void> loadCaptureFonts(String? captureDir) async {
  if (captureDir == null) return loadRealFonts();
  if (Platform.isMacOS) {
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      final bytes = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
  } else {
    await loadRealFonts();
  }
  // Widget tests omit icon faces unless loaded explicitly on every platform.
  final manifest =
      jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
  for (final entry in manifest.cast<Map<String, dynamic>>()) {
    final loader = FontLoader(entry['family'] as String);
    for (final font in (entry['fonts'] as List).cast<Map>()) {
      loader.addFont(rootBundle.load(font['asset'] as String));
    }
    await loader.load();
  }
}

/// Writes [boundary] to `<captureDir>/<name>.png`, shadows included. Does
/// nothing without a [captureDir].
Future<void> captureBoundary(
  WidgetTester tester,
  RenderRepaintBoundary boundary,
  String? captureDir,
  String name,
) => _capture(
  tester,
  boundary,
  captureDir,
  name,
  () => boundary.toImage(pixelRatio: 2),
);

/// The same for the whole window, every route in it: a menu or a dialog is a
/// route of its own, outside the boundary of the screen under it.
Future<void> captureWindow(
  WidgetTester tester,
  String? captureDir,
  String name,
) {
  final view = tester.binding.renderViews.first;
  // The view's own layer already scales by the display's pixel ratio, and its
  // bounds are in those pixels: on a 2x display, asking for logical bounds at
  // 2x drew the top-left quarter of the window twice as large.
  final ratio = view.configuration.devicePixelRatio;
  return _capture(
    tester,
    view,
    captureDir,
    name,
    () => (view.debugLayer! as OffsetLayer).toImage(
      Offset.zero & (view.size * ratio),
      pixelRatio: 2 / ratio,
    ),
  );
}

Future<void> _capture(
  WidgetTester tester,
  RenderObject root,
  String? captureDir,
  String name,
  Future<ui.Image> Function() draw,
) async {
  if (captureDir == null) return;
  final oldShadows = debugDisableShadows;
  void repaint(RenderObject object) {
    object.markNeedsPaint();
    object.visitChildren(repaint);
  }

  try {
    debugDisableShadows = false;
    repaint(root);
    await tester.pump();
    await tester.runAsync(() async {
      final picture = await draw();
      final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
      await Directory(captureDir).create(recursive: true);
      await File('$captureDir/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      picture.dispose();
    });
  } finally {
    debugDisableShadows = oldShadows;
    repaint(root);
    await tester.pump();
  }
}
