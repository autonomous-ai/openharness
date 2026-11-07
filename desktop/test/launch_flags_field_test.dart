import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddy_card.dart';
import 'package:harness/super_tabs/launch_flags_field.dart';

import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

/// The Buddy card's launch flags as chips (spec 2026-11-06-board-buddy-card).
void main() {
  final input = find.byKey(const ValueKey('launch-flag-input'));

  Future<List<List<String>>> show(
    WidgetTester tester, {
    List<String> words = const ['--chrome'],
    bool readOnly = false,
    String? marked,
  }) async {
    final changes = <List<String>>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 360,
              child: LaunchFlagsField(
                words: words,
                readOnly: readOnly,
                marked: marked,
                onChanged: changes.add,
              ),
            ),
          ),
        ),
      ),
    );
    return changes;
  }

  testWidgets('a saved word is a chip, and the input has a hint', (
    tester,
  ) async {
    await show(tester);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('launch-flag-chip-0')),
        matching: find.text('--chrome'),
      ),
      findsOneWidget,
    );
    expect(find.text('add a flag…'), findsOneWidget);
  });

  testWidgets('Enter adds the typed flag and clears the input', (tester) async {
    final changes = await show(tester);
    await tester.enterText(input, '--foo');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(changes.single, ['--chrome', '--foo']);
    expect(tester.widget<TextField>(input).controller!.text, isEmpty);
  });

  testWidgets('a space adds the typed flag', (tester) async {
    final changes = await show(tester);
    await tester.enterText(input, '--bar ');
    await tester.pump();
    expect(changes.single, ['--chrome', '--bar']);
    expect(tester.widget<TextField>(input).controller!.text, isEmpty);
  });

  testWidgets('a quoted flag becomes chips as a shell would split it', (
    tester,
  ) async {
    final changes = await show(tester);
    await tester.enterText(input, '--add-dir "a b"');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(changes.single, ['--chrome', '--add-dir', 'a b']);
  });

  testWidgets('a space inside an unclosed quote adds nothing', (tester) async {
    final changes = await show(tester);
    await tester.enterText(input, '--x "a ');
    await tester.pump();
    expect(changes, isEmpty);
    expect(tester.widget<TextField>(input).controller!.text, '--x "a ');
    // Enter on it keeps the text too.
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(changes, isEmpty);
    expect(tester.widget<TextField>(input).controller!.text, '--x "a ');
    expect(tester.takeException(), isNull);
  });

  testWidgets('an escaped trailing space stays inside the word', (
    tester,
  ) async {
    final changes = await show(tester);
    await tester.enterText(input, r'--add-dir a\ ');
    await tester.pump();
    expect(changes, isEmpty);
    await tester.enterText(input, r'--add-dir a\ b ');
    await tester.pump();
    expect(changes.single, ['--chrome', '--add-dir', 'a b']);
  });

  testWidgets('the focus callback ends when the field goes away', (
    tester,
  ) async {
    final focus = <bool>[];
    Widget app(bool shown) => MaterialApp(
      theme: grid.buildAppTheme(),
      home: Scaffold(
        body: shown
            ? LaunchFlagsField(
                words: const [],
                onChanged: (_) {},
                onFocusChanged: focus.add,
              )
            : const SizedBox(),
      ),
    );
    await tester.pumpWidget(app(true));
    await tester.tap(input);
    await tester.pump();
    expect(focus.last, isTrue);
    await tester.pumpWidget(app(false));
    await tester.pump();
    expect(focus.last, isFalse);
  });

  testWidgets('Backspace in the empty input removes the last chip', (
    tester,
  ) async {
    final changes = await show(tester);
    await tester.tap(input);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(changes.single, <String>[]);
  });

  testWidgets('the × removes its chip', (tester) async {
    final changes = await show(tester);
    await tester.tap(find.byKey(const ValueKey('launch-flag-remove-0')));
    await tester.pump();
    expect(changes.single, <String>[]);
  });

  testWidgets('read only disables the input and the ×', (tester) async {
    final changes = await show(tester, readOnly: true);
    expect(tester.widget<TextField>(input).enabled, isFalse);
    await tester.tap(
      find.byKey(const ValueKey('launch-flag-remove-0')),
      warnIfMissed: false,
    );
    await tester.pump();
    expect(changes, isEmpty);
  });

  testWidgets('a marked chip is drawn in the danger style', (tester) async {
    await show(tester, words: ['--chrome', '--model'], marked: '--model');
    Color? rim(int i) {
      final box = tester.widget<DecoratedBox>(
        find
            .descendant(
              of: find.byKey(ValueKey('launch-flag-chip-$i')),
              matching: find.byType(DecoratedBox),
            )
            .first,
      );
      return ((box.decoration as BoxDecoration).border! as Border).top.color;
    }

    expect(rim(1), grid.AppPalette.dangerFill);
    expect(rim(0), isNot(grid.AppPalette.dangerFill));
  });

  group('a long flag in the Buddy card (#4444)', () {
    setUpAll(() => loadCaptureFonts(shots));

    testWidgets('ends in … inside the field, whole in a tooltip, and its × '
        'removes it', (tester) async {
      final word = '--add-dir=/Users/${'a' * 300}'.substring(0, 200);
      final changes = <List<String>>[];
      for (final (brightness, mode) in [
        (Brightness.light, 'light'),
        (Brightness.dark, 'dark'),
      ]) {
        // The design tokens follow the app's brightness, which main.dart sets from the theme.
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        await tester.binding.setSurfaceSize(
          const Size(BuddyCardButton.cardWidth, 160),
        );
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: Padding(
                // The card's inner width: its padding on both sides.
                padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
                child: LaunchFlagsField(
                  words: ['--chrome', word],
                  onChanged: changes.add,
                ),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull);
        final field = tester.getRect(find.byType(LaunchFlagsField));
        final remove = tester.getRect(
          find.byKey(const ValueKey('launch-flag-remove-1')),
        );
        expect(
          field.left <= remove.left && remove.right <= field.right,
          isTrue,
          reason: 'the × $remove is outside the field $field',
        );
        expect(
          tester
              .renderObject<RenderParagraph>(
                find.descendant(
                  of: find.text(word),
                  matching: find.byType(RichText),
                ),
              )
              .didExceedMaxLines,
          isTrue,
          reason: 'the flag has no …',
        );
        expect(
          find.byWidgetPredicate((w) => w is Tooltip && w.message == word),
          findsOneWidget,
        );
        await captureWindow(tester, shots, '07-long-launch-flag-$mode');
      }
      await tester.tap(find.byKey(const ValueKey('launch-flag-remove-1')));
      await tester.pump();
      expect(changes.single, ['--chrome']);
    });
  });
}
