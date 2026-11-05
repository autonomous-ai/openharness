import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Review screenshots of what Change agent says when a Swarm Product
/// Manager's machine refuses to save and stop it: the CLI's sentence for
/// LEAD_PROTECTED and LEAD_SWITCHING, never the bare code, on the snackbar
/// the terminal page shows it on (`terminal_page.dart` `_changeAgent`). On a
/// 390-point phone in both phone themes, to the folder
/// `CHANGE_AGENT_SHOTS` names. Skipped otherwise.
final shots = Platform.environment['CHANGE_AGENT_SHOTS'];

void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    // Every name the app's text asks for; one left out draws as blocks.
    for (final family in {
      '.AppleSystemUIFont',
      'Roboto',
      AppFont.sans,
      ...AppFont.sansFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in {
      '.AppleSystemUIFontMonospaced',
      'monospace',
      AppFont.mono,
      ...AppFont.monoFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  testWidgets('a PM machine refusing Change agent, in both phone themes', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    debugDisableShadows = false;
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      const size = Size(390, 844);
      tester.view
        ..physicalSize = size * 3
        ..devicePixelRatio = 3;
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final boundary = GlobalKey();
      final messenger = GlobalKey<ScaffoldMessengerState>();
      final theme = buildAppTheme(brightness: brightness);
      // The theme's snackbar style names no family: a phone draws it in its
      // system face, which is AppFont.sans; `flutter test` would draw its own
      // test face instead.
      final snackBar = theme.snackBarTheme;
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme.copyWith(
              snackBarTheme: snackBar.copyWith(
                contentTextStyle: snackBar.contentTextStyle?.copyWith(
                  fontFamily: AppFont.sans,
                  fontFamilyFallback: AppFont.sansFallback,
                ),
              ),
            ),
            scaffoldMessengerKey: messenger,
            home: const Scaffold(body: SizedBox.expand()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final (name, code) in [
        ('lead-protected', 'LEAD_PROTECTED'),
        ('lead-switching', 'LEAD_SWITCHING'),
      ]) {
        final said = AppNotifier.closeRefusalMessage(code, null);
        expect(said, isNot(contains(code)), reason: 'a sentence, not a code');
        // As terminal_page.dart says a refused switch.
        messenger.currentState!
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(said)));
        await tester.pumpAndSettle();
        expect(find.text(said), findsOneWidget);
        await tester.runAsync(() async {
          expect(tester.takeException(), isNull);
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File(
            '$shots/phone-change-agent-$name-${brightness.name}-390.png',
          ).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.pumpWidget(const SizedBox());
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}
