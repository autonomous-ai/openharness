import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/composer_newline.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// The Swarm chat box: Enter sends, Shift+Enter and Alt/Option+Enter start another line and keep
/// the cursor in the box. The newline is written by the box itself, because a widget test's raw
/// key events never reach the platform text-input channel and macOS gives Option+Return no line.
void main() {
  final desktops = TargetPlatformVariant({
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  });
  final composer = find.byKey(const ValueKey('super-message-composer'));
  TextEditingController controller(WidgetTester tester) =>
      tester.widget<TextField>(composer).controller!;

  late SuperTabController shown;
  String draft() => shown.draft(shown.selectedId);

  Future<ConversationServer> show(WidgetTester tester) async {
    final server = ConversationServer()..append('Which build?');
    final c = shown = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return server;
  }

  Future<void> type(WidgetTester tester, String text) async {
    await tester.tap(composer);
    await tester.enterText(composer, text);
    await tester.pump();
  }

  Future<void> press(
    WidgetTester tester,
    LogicalKeyboardKey key, {
    LogicalKeyboardKey? holding,
  }) async {
    if (holding != null) await tester.sendKeyDownEvent(holding);
    await tester.sendKeyEvent(key);
    if (holding != null) await tester.sendKeyUpEvent(holding);
    await tester.pump();
  }

  for (final (name, modifier) in [
    ('Shift', LogicalKeyboardKey.shiftLeft),
    ('Alt/Option', LogicalKeyboardKey.altLeft),
  ]) {
    testWidgets('$name+Enter adds a line at the cursor and does not send', (
      tester,
    ) async {
      final server = await show(tester);
      await type(tester, 'firstsecond');
      controller(tester).selection = const TextSelection.collapsed(offset: 5);

      await press(tester, LogicalKeyboardKey.enter, holding: modifier);

      expect(controller(tester).text, 'first\nsecond');
      // The saved draft follows the box, so switching chats keeps the line.
      expect(draft(), 'first\nsecond');
      expect(
        controller(tester).selection,
        const TextSelection.collapsed(offset: 6),
      );
      expect(server.posts, isEmpty);
      // The cursor stays in the box, so the next key goes on the new line.
      expect(
        tester.widget<TextField>(composer).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      await tester.pump(const Duration(seconds: 1));
    }, variant: desktops);

    testWidgets('$name+Enter replaces the selection with the line', (
      tester,
    ) async {
      final server = await show(tester);
      await type(tester, 'one two three');
      controller(tester).selection = const TextSelection(
        baseOffset: 3,
        extentOffset: 8,
      );

      await press(tester, LogicalKeyboardKey.enter, holding: modifier);

      expect(controller(tester).text, 'one\nthree');
      expect(draft(), 'one\nthree');
      expect(
        controller(tester).selection,
        const TextSelection.collapsed(offset: 4),
      );
      expect(server.posts, isEmpty);
      await tester.pump(const Duration(seconds: 1));
    }, variant: desktops);

    testWidgets('$name+Enter during composition neither inserts nor sends', (
      tester,
    ) async {
      final server = await show(tester);
      await type(tester, 'xin chào');
      controller(tester).value = const TextEditingValue(
        text: 'xin chao',
        selection: TextSelection.collapsed(offset: 8),
        composing: TextRange(start: 4, end: 8),
      );

      await press(tester, LogicalKeyboardKey.enter, holding: modifier);

      expect(controller(tester).text, 'xin chao');
      expect(server.posts, isEmpty);
      await tester.pump(const Duration(seconds: 1));
    }, variant: desktops);
  }

  testWidgets('Enter alone sends and clears the box', (tester) async {
    final server = await show(tester);
    await type(tester, 'The arm64 one');

    await press(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(server.posts, hasLength(1));
    expect(controller(tester).text, isEmpty);
    await tester.pump(const Duration(seconds: 1));
  }, variant: desktops);

  testWidgets('Enter during composition commits it and does not send', (
    tester,
  ) async {
    final server = await show(tester);
    await type(tester, 'xin chào');
    controller(tester).value = const TextEditingValue(
      text: 'xin chao',
      selection: TextSelection.collapsed(offset: 8),
      composing: TextRange(start: 4, end: 8),
    );

    await press(tester, LogicalKeyboardKey.enter);

    expect(server.posts, isEmpty);
    expect(controller(tester).text, 'xin chao');
    await tester.pump(const Duration(seconds: 1));
  }, variant: desktops);

  testWidgets('a full box takes no further line', (tester) async {
    final server = await show(tester);
    final full = 'a' * kComposerMaxLength;
    await type(tester, full);
    controller(tester).selection = TextSelection.collapsed(
      offset: kComposerMaxLength,
    );

    await press(
      tester,
      LogicalKeyboardKey.enter,
      holding: LogicalKeyboardKey.shiftLeft,
    );

    expect(controller(tester).text, full);
    expect(server.posts, isEmpty);
    await tester.pump(const Duration(seconds: 1));
  });

  group('withNewline', () {
    test('a box that was never placed in appends the line', () {
      final value = withNewline(const TextEditingValue(text: 'hi'));
      expect(value!.text, 'hi\n');
      expect(value.selection, const TextSelection.collapsed(offset: 3));
    });

    test('a selection that makes room lets the line in at the limit', () {
      final value = withNewline(
        TextEditingValue(
          text: 'a' * kComposerMaxLength,
          selection: const TextSelection(baseOffset: 0, extentOffset: 1),
        ),
      );
      expect(value!.text.length, kComposerMaxLength);
      expect(value.text.startsWith('\n'), isTrue);
    });
  });
}
