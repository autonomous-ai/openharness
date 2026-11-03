import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/chat_edge.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_CHAT_EDGE_SHOTS'];

/// The chat's edge under the Buddy line on Desktop (support/chat_edge.dart).
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });
  chatEdgeTests(
    shot: shots == null
        ? null
        : (tester, picture, name) => tester.runAsync(() async {
            final boundary =
                picture.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = await boundary.toImage(pixelRatio: 1.5);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(shots!).create(recursive: true);
            await File('$shots/$name.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          }),
  );
}
