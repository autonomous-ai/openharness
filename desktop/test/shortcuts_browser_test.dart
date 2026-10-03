import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/shortcuts_browser.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/key_cap.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show key;
import 'support/real_fonts.dart';

void main() {
  for (final (size, scale, brightness) in [
    (const Size(1000, 700), 1.0, Brightness.dark),
    (const Size(1000, 700), 1.0, Brightness.light),
    (const Size(480, 420), 1.8, Brightness.dark),
    (const Size(480, 420), 1.8, Brightness.light),
  ]) {
    testWidgets(
      'lazy shortcuts keep keyboard paging visible at $size/$scale/$brightness',
      (tester) async {
        await tester.runAsync(() async {
          if (Platform.isMacOS) {
            // Native key glyphs are absent from the cross-platform Arial
            // fixture. Load the system face for these visual keycap reviews.
            final sans = ByteData.sublistView(
              await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
            );
            for (final family in [grid.AppType.sansFamily, 'SF Pro Text']) {
              await (FontLoader(family)..addFont(Future.value(sans))).load();
            }
            final mono = ByteData.sublistView(
              await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
            );
            for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
              await (FontLoader(family)..addFont(Future.value(mono))).load();
            }
            await (FontLoader('Menlo')..addFont(
                  Future.value(
                    ByteData.sublistView(
                      await File('/System/Library/Fonts/Menlo.ttc')
                          .readAsBytes(),
                    ),
                  ),
                ))
                .load();
          } else {
            await loadRealFonts();
          }
          await (FontLoader('MaterialIcons')
                ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf')))
              .load();
        });
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final savedBrightness = grid.AppTheme.brightness.value;
        final savedFont = terminalFontStore.value;
        addTearDown(() {
          grid.AppTheme.brightness.value = savedBrightness;
          terminalFontStore.value = savedFont;
        });
        grid.AppTheme.brightness.value = brightness;
        terminalFontStore.value = const TerminalStyle(
          fontSize: 24,
          fontFamily: 'Courier New',
        );
        final map = AppKeymap();
        final boundary = GlobalKey();
        addTearDown(map.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                textScaler: TextScaler.linear(scale),
                highContrast: brightness == Brightness.light && scale > 1,
                disableAnimations: scale > 1,
              ),
              child: child!,
            ),
            home: KeymapProvider(
              keymap: map,
              child: RepaintBoundary(
                key: boundary,
                child: const Scaffold(body: ShortcutsBrowser(autofocus: true)),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('shortcuts-search')))
              .style!
              .fontFamily,
          grid.AppType.sansFamily,
        );
        for (final cap in tester.widgetList<KeyCap>(find.byType(KeyCap))) {
          expect(cap.textStyle!.fontFamily, grid.AppType.sansFamily);
        }
        final title = find.text('Keyboard shortcuts').first;
        final titleRect = tester.getRect(title);
        terminalFontStore.value = const TerminalStyle(
          fontSize: 10,
          fontFamily: 'Menlo',
        );
        await tester.pump();
        expect(tester.getRect(title), titleRect);
        final captureDir =
            Platform.environment['HARNESS_SHORTCUTS_CAPTURE_DIR'];
        if (captureDir != null) {
          await tester.runAsync(() async {
            final image =
                await (boundary.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage();
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            Directory(captureDir).createSync(recursive: true);
            File(
              '$captureDir/shortcuts-${brightness.name}-${size.width.toInt()}.png',
            ).writeAsBytesSync(data!.buffer.asUint8List());
            image.dispose();
          });
        }
        final rows = find.byWidgetPredicate(
          (widget) =>
              widget is Semantics &&
              widget.properties.label?.endsWith('Practice shortcut') == true,
        );
        expect(rows.evaluate().length, lessThan(keyboardLessons(map).length));
        final selected = find.byWidgetPredicate(
          (widget) => widget is Semantics && widget.properties.selected == true,
        );
        // Cross every group in both directions, including rows not built yet.
        for (final direction in [
          LogicalKeyboardKey.pageDown,
          LogicalKeyboardKey.pageUp,
        ]) {
          for (var page = 0; page < 20; page++) {
            await key(tester, direction);
            await tester.pumpAndSettle();
            expect(selected, findsOneWidget);
            final viewport = tester.getRect(find.byType(ListView));
            expect(viewport.contains(tester.getCenter(selected)), isTrue);
            expect(tester.takeException(), isNull);
          }
        }
        await tester.enterText(
          find.byKey(const ValueKey('shortcuts-search')),
          'clone',
        );
        await tester.pumpAndSettle();
        expect(find.text('Clone Harness'), findsOneWidget);
        final semantics = tester.ensureSemantics();
        try {
          await tester.pump();
          final node = tester.getSemantics(rows).getSemanticsData();
          expect(node.label, contains('Clone Harness'));
          expect(node.hasAction(ui.SemanticsAction.tap), isTrue);
        } finally {
          semantics.dispose();
        }
        await key(tester, LogicalKeyboardKey.arrowDown);
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(find.byType(KeyboardPractice), findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('shortcuts-search')))
              .focusNode!
              .hasFocus,
          isTrue,
        );
        await tester.tap(find.text('Clone Harness'));
        await tester.pumpAndSettle();
        expect(find.byType(KeyboardPractice), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
