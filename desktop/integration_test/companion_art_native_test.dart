import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/daemons/illustrated_art.dart';
import 'package:harness/daemons/illustrated_image.dart';
import 'package:harness/daemons/individuals.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/widgets/daemon_illustration.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

// Real native decoding/painting: headless tests passed while Impeller on Intel
// produced transparent images. Use the release renderer for the test host:
// FLUTTER_TEST=1 flutter test -d macos --no-pub \
//   integration_test/companion_art_native_test.dart
// Add --no-enable-impeller on Intel. COMPANION_ART_CAPTURE_DIR optionally saves
// the rendered grids. Only synthetic companions are mounted; no CLI or zoo IO.
void main() {
  if (!kUnderTest) {
    throw StateError('Companion fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1200, 920));
    await windowManager.setAlwaysOnTop(true);
    await windowManager.show();
    await windowManager.focus();
  });
  tearDownAll(() => windowManager.setAlwaysOnTop(false));

  for (final version in ['0.1', '1.0', '2.0']) {
    testWidgets('all companions at $version paint on the native renderer', (
      tester,
    ) async {
      final page = GlobalKey();
      final shots = <String, GlobalKey>{};
      final art = <String, IllustratedArt>{
        for (final id in IllustratedArt.species) ...{
          '$id original': IllustratedArt.daemon(id, version: version),
          '$id individual': IllustratedArt.daemon(
            id,
            version: version,
            traits: rollTraits(daemonRoster, id, 42),
          ),
        },
      };
      await tester.pumpWidget(
        RepaintBoundary(
          key: page,
          child: MaterialApp(
            theme: ThemeData.dark(),
            debugShowCheckedModeBanner: false,
            home: Scaffold(
              backgroundColor: const Color(0xff202020),
              body: Wrap(
                children: [
                  for (final entry in art.entries)
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(entry.key),
                        RepaintBoundary(
                          key: shots[entry.key] = GlobalKey(),
                          child: DaemonIllustration(
                            art: entry.value,
                            size: 180,
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      );
      for (final entry in art.entries) {
        final a = entry.value;
        final ImageProvider provider = a.styled
            ? IllustratedImage(a.asset(0), a.colour, a.mark)
            : AssetImage(a.asset(0));
        await precacheImage(
          provider,
          shots[entry.key]!.currentContext!,
        ).timeout(const Duration(seconds: 15));
      }
      await tester.pumpAndSettle();
      for (final entry in shots.entries) {
        final boundary =
            entry.value.currentContext!.findRenderObject()
                as RenderRepaintBoundary;
        final shot = await boundary.toImage();
        try {
          final pixels = (await shot.toByteData(
            format: ui.ImageByteFormat.rawRgba,
          ))!.buffer.asUint8List();
          var opaque = 0;
          for (var i = 3; i < pixels.length; i += 4) {
            if (pixels[i] > 200) opaque++;
          }
          expect(
            opaque,
            greaterThan(500),
            reason: '${entry.key} at $version must paint visible artwork',
          );
        } finally {
          shot.dispose();
        }
      }
      final captureDir = Platform.environment['COMPANION_ART_CAPTURE_DIR'];
      if (captureDir != null) {
        final shot =
            await (page.currentContext!.findRenderObject()
                    as RenderRepaintBoundary)
                .toImage();
        try {
          final png = await shot.toByteData(format: ui.ImageByteFormat.png);
          final file = File('$captureDir/companion-art-$version.png');
          await file.parent.create(recursive: true);
          await file.writeAsBytes(png!.buffer.asUint8List());
        } finally {
          shot.dispose();
        }
      }
      expect(tester.takeException(), isNull);
    });
  }
}
