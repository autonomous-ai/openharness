import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/shortcuts_browser.dart';

import 'keymap_host_test.dart' show key;
import 'support/real_fonts.dart';

void main() {
  for (final (size, scale) in [
    (const Size(1000, 700), 1.0),
    (const Size(480, 420), 1.8),
  ]) {
    testWidgets('lazy shortcuts keep keyboard paging visible at $size/$scale', (
      tester,
    ) async {
      await tester.runAsync(loadRealFonts);
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final map = AppKeymap();
      addTearDown(map.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: KeymapProvider(
            keymap: map,
            child: const Scaffold(body: ShortcutsBrowser(autofocus: true)),
          ),
        ),
      );
      await tester.pumpAndSettle();
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
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(KeyboardPractice), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
