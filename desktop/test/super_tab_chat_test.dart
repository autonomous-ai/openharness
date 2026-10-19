import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
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

  testWidgets(
    'an existing lead named after a greeting is Lead in messages, replies and participants',
    (tester) async {
      final server = ConversationServer();
      (server.state['agents'] as List).add({
        'id': 'lead-agent',
        'name': 'hi',
        'machineId': 'm',
        'harnessId': 'native-lead',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      });
      (server.state['conversations'] as List)[0]
        ..['leadId'] = 'lead-agent'
        ..['agentIds'] = ['lead-agent'];
      server.append('What should we build?');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'lead-agent',
        'name': 'hi',
      };
      final c = await show(tester, server);
      final row = find.byKey(const ValueKey('super-message-message-1'));
      expect(
        find.descendant(of: row, matching: find.text('Lead')),
        findsOneWidget,
      );
      expect(find.text('hi'), findsNothing);
      tester
          .widget<Focus>(
            find.descendant(of: row, matching: find.byType(Focus)).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.pump();
      expect(find.text('Replying to Lead'), findsOneWidget);
      final composer = find.byKey(const ValueKey('super-message-composer'));
      await tester.enterText(composer, 'Let’s discuss the plan.');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await c.refresh();
      await tester.pumpAndSettle();
      final reply = find.byKey(const ValueKey('super-message-message-2'));
      expect(
        find.descendant(of: reply, matching: find.text('Lead')),
        findsOneWidget,
      );
      await tester.tap(find.text('1 agent · 1 person'));
      await tester.pumpAndSettle();
      expect(find.text('hi'), findsNothing);
      expect(find.text('Lead'), findsWidgets);
      expect(find.text('Open terminal'), findsOneWidget);
    },
  );

  testWidgets(
    'a keyboard reply keeps its quoted context after sending and refreshing',
    (tester) async {
      final server = ConversationServer()
        ..append('Should edits survive restarting the app?');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'builder',
        'name': 'Builder',
      };
      final c = await show(tester, server);
      final row = find.byKey(const ValueKey('super-message-message-1'));
      tester
          .widget<Focus>(
            find.descendant(of: row, matching: find.byType(Focus)).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.pump();
      expect(find.text('Replying to Builder'), findsOneWidget);
      final composer = find.byKey(const ValueKey('super-message-composer'));
      expect(tester.widget<TextField>(composer).focusNode!.hasFocus, isTrue);
      await tester.enterText(composer, 'Yes, persist the local queue.');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect((server.posts.single['command'] as Map)['replyTo'], 'message-1');
      await c.refresh();
      await tester.pumpAndSettle();
      final reply = find.byKey(const ValueKey('super-message-message-2'));
      expect(
        find.descendant(of: reply, matching: find.byType(SuperTabReplyPreview)),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: reply,
          matching: find.text('Should edits survive restarting the app?'),
        ),
        findsOneWidget,
      );
      expect(find.text('Replying to Builder'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'incoming agent traffic preserves history and offers a scoped catch-up action',
    (tester) async {
      final server = ConversationServer();
      for (var i = 0; i < 35; i++) {
        server.append(
          'Agent update $i: checking the offline queue and reconnect behavior.',
        );
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'builder-$i',
          'name': 'Builder $i',
        };
      }
      final c = await show(tester, server);
      ScrollController scroll() => tester
          .widget<ListView>(
            find.byKey(const PageStorageKey('super-messages-tab-lead')),
          )
          .controller!;
      scroll().jumpTo(0);
      await tester.pumpAndSettle();
      final reading = scroll().offset;
      server.append('The reconnect check passed.');
      server.append('The restart check passed too.');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(scroll().offset, reading);
      expect(find.text('2 new messages'), findsOneWidget);
      expect(c.unread(c.selected!), isTrue);
      await tester.tap(find.byKey(const ValueKey('super-new-messages')));
      await tester.pumpAndSettle();
      expect(find.text('2 new messages'), findsNothing);
      expect(scroll().position.extentAfter, lessThan(40));
      expect(c.unread(c.selected!), isFalse);
      expect(find.text('The restart check passed too.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'revocation removes the quoted original as well as the transcript',
    (tester) async {
      final server = ConversationServer()..append('A private question');
      final c = await show(tester, server);
      await tester.tap(find.byTooltip('Reply'));
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabReplyPreview), findsOneWidget);
      c.revokeAccess('Access removed.');
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabReplyPreview), findsNothing);
      expect(find.text('A private question'), findsNothing);
      expect(
        tester
            .widget<TextField>(
              find.byKey(const ValueKey('super-message-composer')),
            )
            .controller!
            .text,
        isEmpty,
      );
    },
  );

  testWidgets(
    'a human request belongs only to its group and clears with the recorded state',
    (tester) async {
      final server = ConversationServer();
      final group = (server.state['conversations'] as List)[1] as Map;
      group['assignment'] = {
        'id': 'attempt',
        'agentId': 'builder',
        'status': 'needs_human',
        'result': 'Which device should I test?',
      };
      final c = await show(tester, server);
      expect(find.text('Needs a human'), findsNothing);
      c.select('offline');
      await tester.pumpAndSettle();
      expect(find.text('Needs a human'), findsOneWidget);
      group['assignment']['status'] = 'working';
      server.revision++;
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('Needs a human'), findsNothing);
    },
  );

  testWidgets(
    'Markdown preserves readable code and never loads message images',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 400,
              child: const SuperTabMessageText(
                '## Checked\n\n**Restart** preserves the queue.\n\n'
                '\u0060\u0060\u0060dart\nawait queue.flush();\n\u0060\u0060\u0060\n\n'
                '![Local image](file:///private/example.png)\n\n'
                '![Remote image](https://example.com/tracking.png)',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(MarkdownBody), findsOneWidget);
      expect(find.text('Checked'), findsOneWidget);
      expect(
        find.textContaining('queue.flush()', findRichText: true),
        findsWidgets,
      );
      expect(find.text('Image: Local image'), findsOneWidget);
      expect(find.text('Image: Remote image'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  test('message links permit only explicit http and https destinations', () {
    for (final href in [
      null,
      '',
      '/tmp/code',
      'file:///tmp/code',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'https:///',
    ]) {
      expect(SuperTabMessageText.webLink(href), isNull);
    }
    expect(
      SuperTabMessageText.webLink('https://example.com/check#result')?.host,
      'example.com',
    );
    expect(SuperTabMessageText.webLink('http://localhost:3000')?.port, 3000);
  });

  test(
    'grouping preserves author, day, reply and native source boundaries',
    () {
      final server = ConversationServer()
        ..append('First update')
        ..append('Second update');
      SuperTabMessage message(int i) =>
          SuperTabMessage.fromJson(server.messages[i]);
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isTrue);
      server.append('Third update');
      server.append('Fourth update');
      expect(
        SuperTabMessageRow.consecutiveUpdates(
          server.messages.map(SuperTabMessage.fromJson).toList(),
        ),
        {'message-2', 'message-3'},
      );
      server.messages[1]['text'] = 'Should edits survive sign-out?';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      expect(SuperTabMessageRow.groupsWith(message(2), message(1)), isFalse);
      server.messages[1]['text'] = '保留修改？';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1]['text'] = 'Second update';
      server.messages[1]['author'] = {
        'kind': 'agent',
        'id': 'owner',
        'name': 'owner@example.com',
      };
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1]['author'] = server.messages[0]['author'];
      server.messages[1]['createdAt'] = '2026-10-19T00:00:00Z';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1]['createdAt'] = server.messages[0]['createdAt'];
      server.messages[1]['replyTo'] = 'message-1';
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
      server.messages[1].remove('replyTo');
      server.messages[1]['source'] = {'kind': 'native', 'phase': 'prompt'};
      expect(SuperTabMessageRow.groupsWith(message(1), message(0)), isFalse);
    },
  );

  test(
    'reading loaded messages cannot mark an unfetched tail as read',
    () async {
      final server = ConversationServer()..append('Visible');
      final c = server.controller();
      await c.refresh();
      server.append('Not loaded');
      c.snapshot = SuperTabSnapshot.fromJson(server.state);
      c.markRead('lead', through: c.messages('lead').last.sequence);
      expect(c.unread(c.selected!), isTrue);
      await c.loadMessages('lead');
      c.markRead('lead', through: c.messages('lead').last.sequence);
      expect(c.unread(c.selected!), isFalse);
      await c.flush();
      c.dispose();
    },
  );
}
