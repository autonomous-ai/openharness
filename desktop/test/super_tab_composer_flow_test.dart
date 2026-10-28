import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = server.controller();
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
    return c;
  }

  final composer = find.byKey(const ValueKey('super-message-composer'));
  FocusNode composerFocus(WidgetTester tester) =>
      tester.widget<TextField>(composer).focusNode!;
  String composerText(WidgetTester tester) =>
      tester.widget<TextField>(composer).controller!.text;

  for (final chat in ['a workgroup', 'the chat with the PM']) {
    testWidgets(
      'Reply in $chat puts the cursor in the composer, reply attached',
      (tester) async {
        final server = ConversationServer();
        if (chat == 'the chat with the PM') {
          // The reader's own chat: its audience is the reader alone.
          final pm = (server.state['conversations'] as List)[1] as Map;
          pm['audience'] = {
            'people': [
              {'id': 'owner', 'generation': 'fixture'},
            ],
          };
          server.append(
            'Which build should I test?',
            conversationId: pm['id'] as String,
          );
        } else {
          server.append('Which build should I test?');
        }
        final c = await show(tester, server);
        if (chat == 'the chat with the PM') {
          c.select('offline');
          await tester.pumpAndSettle();
          expect(c.pmChat(c.selected!.projectId)?.id, 'offline');
        }
        // Reading the transcript first: the composer has given up focus.
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        expect(composerFocus(tester).hasFocus, isFalse);

        // Ken's path: the mouse rests on the message, its toolbar shows, and
        // the reply arrow is clicked.
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);
        await mouse.moveTo(
          tester.getCenter(find.text('Which build should I test?')),
        );
        await tester.pumpAndSettle();
        final reply = tester.getCenter(find.byTooltip('Reply'));
        await mouse.moveTo(reply);
        await tester.pumpAndSettle();
        await mouse.down(reply);
        await tester.pump(const Duration(milliseconds: 40));
        await mouse.up();
        await tester.pump();
        void typesInComposer() {
          expect(find.byType(SuperTabReplyPreview), findsOneWidget);
          expect(composerFocus(tester).hasPrimaryFocus, isTrue);
          // Focus alone is not typing: the keyboard reaches the field only
          // over its text input connection.
          expect(tester.testTextInput.hasAnyClients, isTrue);
        }

        typesInComposer();
        await tester.pumpAndSettle();
        typesInComposer();
        // The pointer leaves the message and its toolbar goes.
        await mouse.moveTo(tester.getCenter(composer));
        await tester.pumpAndSettle();
        typesInComposer();
        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: 'The arm64 one',
            selection: TextSelection.collapsed(offset: 13),
          ),
        );
        await tester.pump();
        expect(composerText(tester), 'The arm64 one');
        await tester.pump(const Duration(seconds: 1));
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

  ConversationServer withBuilder() {
    final server = ConversationServer();
    server.state['agents'] = [
      {
        'id': 'builder',
        'name': 'Builder',
        'machineId': 'host',
        'harnessId': 'session',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
    ];
    for (final group in server.state['conversations'] as List) {
      (group as Map)['agentIds'] = ['builder'];
    }
    return server;
  }

  Future<void> tagBuilder(WidgetTester tester, String before) async {
    await tester.tap(composer);
    await tester.enterText(composer, '$before@Bu');
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Backspace right after a tag removes the whole tag and its agent',
    (tester) async {
      final c = await show(tester, withBuilder());
      await tagBuilder(tester, 'Please check ');
      expect(composerText(tester), 'Please check @Builder ');
      expect(c.mentions(c.selectedId), {'builder': '@Builder'});
      // The list of agents came and went above the field; the keyboard still
      // reaches it.
      expect(tester.testTextInput.hasAnyClients, isTrue);

      // The space the tag brought goes first, as any character does.
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pumpAndSettle();
      expect(composerText(tester), 'Please check @Builder');
      expect(c.mentions(c.selectedId), {'builder': '@Builder'});

      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pumpAndSettle();
      expect(composerText(tester), 'Please check ');
      expect(
        tester.widget<TextField>(composer).controller!.selection,
        const TextSelection.collapsed(offset: 13),
      );
      expect(c.mentions(c.selectedId), isEmpty);
      // No list of agents springs up in its place.
      expect(
        find.byKey(const ValueKey('super-composer-completions')),
        findsNothing,
      );
      await tester.pump(const Duration(seconds: 1));
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}
