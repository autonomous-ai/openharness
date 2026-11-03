import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  final composer = find.byKey(const ValueKey('super-message-composer'));
  final picker = find.byKey(const ValueKey('super-composer-completions'));

  Future<(ConversationServer, SuperTabController)> show(
    WidgetTester tester, {
    Brightness brightness = Brightness.dark,
    double scale = 1,
  }) async {
    final server = ConversationServer();
    (server.state['conversations'] as List)[1]['number'] = 12;
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      {...conversationFixture('sync', 'Sync reliability'), 'number': 13},
      {
        ...conversationFixture('done', 'Offline prototype'),
        'number': 2,
        'archived': true,
      },
    ]);
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
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
    return (server, c);
  }

  testWidgets(
    'workgroups filter by name and number, insert without sending, then send normally',
    (tester) async {
      final (server, c) = await show(tester);
      await tester.enterText(composer, 'Please review #off');
      await tester.pump();
      expect(
        find.descendant(of: picker, matching: find.text('#12 Offline editing')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: picker,
          matching: find.text('#13 Sync reliability'),
        ),
        findsNothing,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.draft('lead'), 'Please review #12 ');
      expect(server.posts, isEmpty);
      expect(picker, findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        (server.posts.single['command'] as Map)['text'],
        'Please review #12',
      );
      await tester.enterText(composer, '#13');
      await tester.pump();
      await tester.tap(
        find.descendant(
          of: picker,
          matching: find.text('#13 Sync reliability'),
        ),
      );
      await tester.pumpAndSettle();
      expect(c.draft('lead'), '#13 ');
    },
  );

  testWidgets('arrow keys and Tab select while Escape dismisses the picker', (
    tester,
  ) async {
    final (server, c) = await show(tester);
    await tester.enterText(composer, '#');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pumpAndSettle();
    expect(c.draft('lead'), '#13 ');
    expect(server.posts, isEmpty);
    await tester.enterText(composer, '#12');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(picker, findsNothing);
    expect(c.draft('lead'), '#12');
    await tester.pump(const Duration(milliseconds: 250));
  });

  testWidgets(
    'moving the caret into a reference preserves the following text',
    (tester) async {
      final (server, c) = await show(tester);
      for (final punctuation in ['', ',']) {
        await tester.enterText(
          composer,
          'Review #offline$punctuation then reply.',
        );
        await tester.pump();
        expect(picker, findsNothing);
        final controller = tester.widget<TextField>(composer).controller!;
        controller.selection = const TextSelection.collapsed(offset: 11);
        await tester.pump();
        expect(picker, findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pumpAndSettle();
        expect(c.draft('lead'), 'Review #12$punctuation then reply.');
        expect(controller.selection.baseOffset, 10);
        expect(picker, findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(
          (server.posts.last['command'] as Map)['text'],
          'Review #12$punctuation then reply.',
        );
      }
      await tester.pump(const Duration(milliseconds: 250));
    },
  );

  testWidgets('Shift Enter keeps the draft instead of accepting a reference', (
    tester,
  ) async {
    final (server, c) = await show(tester);
    await tester.enterText(composer, '#off');
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump(const Duration(milliseconds: 250));
    // The box writes the line itself; the open reference is not accepted.
    expect(c.draft('lead'), '#off\n');
    expect(server.posts, isEmpty);
    // A newline the native text-input client delivers is another edit the
    // completion handler must leave untouched.
    await tester.showKeyboard(composer);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: '#off\nmore',
        selection: TextSelection.collapsed(offset: 9),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    expect(c.draft('lead'), '#off\nmore');
    expect(server.posts, isEmpty);
    expect(picker, findsNothing);
  });

  testWidgets(
    'code, URL fragments, IME and selections do not trigger references',
    (tester) async {
      await show(tester);
      for (final text in [
        'https://example.com/#12',
        '`use #12',
        '```text\n#12',
        '~~~\n#12',
      ]) {
        await tester.enterText(composer, text);
        await tester.pump();
        expect(picker, findsNothing, reason: text);
      }
      final controller = tester.widget<TextField>(composer).controller!;
      controller.value = const TextEditingValue(
        text: '#12',
        selection: TextSelection.collapsed(offset: 3),
        composing: TextRange(start: 1, end: 3),
      );
      await tester.pump();
      expect(picker, findsNothing);
      controller.value = const TextEditingValue(
        text: '#12',
        selection: TextSelection(baseOffset: 0, extentOffset: 3),
      );
      await tester.pump();
      expect(picker, findsNothing);
      await tester.pump(const Duration(milliseconds: 250));
    },
  );

  testWidgets('access revocation removes open suggestions', (tester) async {
    final (_, c) = await show(tester);
    await tester.enterText(composer, '#');
    await tester.pump();
    expect(picker, findsOneWidget);
    c.revokeAccess('Access removed');
    await tester.pumpAndSettle();
    expect(picker, findsNothing);
    expect(tester.widget<TextField>(composer).enabled, isFalse);
  });

  for (final brightness in Brightness.values) {
    testWidgets('reference picker stays bounded at 2x in ${brightness.name}', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(660, 480));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await show(tester, brightness: brightness, scale: 2);
      await tester.enterText(composer, '#');
      await tester.pumpAndSettle();
      expect(picker, findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(
        tester.getRect(picker).bottom,
        lessThanOrEqualTo(tester.getRect(composer).top),
      );
    });
  }
}
