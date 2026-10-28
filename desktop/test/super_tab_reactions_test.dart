import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/reading.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// What the web build reads with: full reads only now and then once quiet.
const _web = SuperTabReading(quietPoll: Duration(seconds: 15));

/// Someone else's reaction, as the backend records it.
void reactAsPeer(ConversationServer server, String messageId) {
  server.messages.firstWhere((m) => m['id'] == messageId)['reactions'] = [
    {
      'emoji': 'tada',
      'count': 1,
      'by': [
        {'kind': 'person', 'id': 'peer'},
      ],
    },
  ];
  final group = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((g) => g['id'] == 'lead');
  group['reactionSeq'] = ((group['reactionSeq'] as int?) ?? 0) + 1;
}

void main() {
  test('another person’s reaction shows within one quiet poll', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Shipped');
      final paths = <String>[];
      final c = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        request: (method, path, {body}) {
          if (method == 'GET') paths.add(path);
          return server.request(method, path, body: body);
        },
        save: server.save,
        reading: _web,
      )..start();
      // Quiet: the polls between full reads ask only for new messages.
      async.elapse(const Duration(seconds: 61));
      expect(c.messages('lead').single.reactions, isEmpty);
      reactAsPeer(server, 'message-1');
      paths.clear();
      async.elapse(const Duration(seconds: 3));
      expect(paths.where((p) => p.contains('/changes')), isEmpty);
      expect(c.messages('lead').single.reactions.single.count, 1);
      // Nothing moved since: the next poll reads only what is new.
      paths.clear();
      async.elapse(const Duration(seconds: 3));
      expect(paths.where((p) => p.contains('messages?before=')), isEmpty);
      c.dispose();
    });
  });
  test('a reaction and a new message in the same quiet poll both show', () {
    fakeAsync((async) {
      final server = ConversationServer()..append('Shipped');
      var failPage = false;
      final c = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        request: (method, path, {body}) {
          final page =
              path.endsWith('/messages') || path.contains('messages?before=');
          if (failPage && method == 'GET' && page) {
            failPage = false;
            return Future.error(
              const SuperTabFailure('UNAVAILABLE', 'Try again.'),
            );
          }
          return server.request(method, path, body: body);
        },
        save: server.save,
        reading: _web,
      )..start();
      async.elapse(const Duration(seconds: 61));
      reactAsPeer(server, 'message-1');
      server.append('And the docs');
      async.elapse(const Duration(seconds: 3));
      expect(c.messages('lead').map((m) => m.text), [
        'Shipped',
        'And the docs',
      ]);
      expect(c.messages('lead').first.reactions.single.count, 1);
      // A refresh that fails leaves the change to the next poll.
      server.messages.first['reactions'] = [
        {
          'emoji': 'tada',
          'count': 2,
          'by': [
            {'kind': 'person', 'id': 'peer'},
            {'kind': 'person', 'id': 'sam'},
          ],
        },
      ];
      final group = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'lead');
      group['reactionSeq'] = (group['reactionSeq'] as int) + 1;
      failPage = true;
      async.elapse(const Duration(seconds: 3));
      expect(c.messages('lead').first.reactions.single.count, 1);
      async.elapse(const Duration(seconds: 3));
      expect(c.messages('lead').first.reactions.single.count, 2);
      c.dispose();
    });
  });

  reactionWidgetTests();

  testWidgets('reacting in the conversation sends it and shows the count', (
    tester,
  ) async {
    final server = ConversationServer()..append('Shipped');
    final c = await showView(tester, server);
    await tester.tap(find.byTooltip('Add reaction'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('🚀'));
    await tester.pumpAndSettle();
    expect(server.posts.last['command'], {
      'type': 'message.react',
      'conversationId': 'lead',
      'messageId': 'message-1',
      'emoji': 'rocket',
      'on': true,
    });
    expect(
      find.byKey(const ValueKey('super-reaction-message-1-rocket')),
      findsOneWidget,
    );
    expect(c.messages('lead').single.reactions.single.count, 1);
  });
}

SuperTabMessage reacted({List<Map<String, dynamic>> reactions = const []}) =>
    SuperTabMessage.fromJson({
      'id': 'm1',
      'conversationId': 'lead',
      'text': 'Shipped the fix',
      'sequence': 1,
      'author': {'kind': 'person', 'id': 'peer', 'name': 'ivy@example.com'},
      'reactions': reactions,
    });

Future<List<SuperTabReactionEmoji>> showRow(
  WidgetTester tester,
  SuperTabMessage message, {
  bool canReact = true,
}) async {
  final picked = <SuperTabReactionEmoji>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabMessageRow(
          message: message,
          author: 'ivy',
          receipts: const [],
          onReturnToComposer: () {},
          readerId: 'owner',
          reactorName: (kind, id) => {'owner': 'dee', 'peer': 'ivy'}[id] ?? id,
          onReact: canReact ? picked.add : null,
        ),
      ),
    ),
  );
  return picked;
}

void reactionWidgetTests() {
  testWidgets('counts show under the message, the reader’s own marked', (
    tester,
  ) async {
    final picked = await showRow(
      tester,
      reacted(
        reactions: [
          {
            'emoji': 'thumbs_up',
            'count': 1,
            'by': [
              {'kind': 'person', 'id': 'peer'},
            ],
          },
          {
            'emoji': 'tada',
            'count': 2,
            'by': [
              {'kind': 'person', 'id': 'owner'},
              {'kind': 'person', 'id': 'peer'},
            ],
          },
        ],
      ),
    );
    final tada = find.byKey(const ValueKey('super-reaction-m1-tada'));
    expect(
      find.descendant(of: tada, matching: find.text('🎉')),
      findsOneWidget,
    );
    expect(find.descendant(of: tada, matching: find.text('2')), findsOneWidget);
    final label = find.bySemanticsLabel('🎉 2, dee and ivy');
    expect(
      tester.getSemantics(label),
      matchesSemantics(
        label: '🎉 2, dee and ivy',
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        hasSelectedState: true,
        isSelected: true,
        hasTapAction: true,
        isFocusable: true,
        hasFocusAction: true,
      ),
    );
    await tester.tap(tada);
    expect(picked, [SuperTabReactionEmoji.tada]);
  });

  testWidgets('a reaction is added from the message’s actions', (tester) async {
    final picked = await showRow(tester, reacted());
    expect(find.byKey(const ValueKey('super-reaction-m1-tada')), findsNothing);
    await tester.tap(find.byTooltip('Add reaction'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('👀'));
    await tester.pumpAndSettle();
    expect(picked, [SuperTabReactionEmoji.eyes]);
  });

  testWidgets('a reader who cannot write sees counts and cannot react', (
    tester,
  ) async {
    await showRow(
      tester,
      canReact: false,
      reacted(
        reactions: [
          {
            'emoji': 'heart',
            'count': 1,
            'by': [
              {'kind': 'person', 'id': 'peer'},
            ],
          },
        ],
      ),
    );
    expect(find.text('❤️'), findsOneWidget);
    expect(find.byTooltip('Add reaction'), findsNothing);
    final chip = tester.widget<InkWell>(
      find.descendant(
        of: find.byKey(const ValueKey('super-reaction-m1-heart')),
        matching: find.byType(InkWell),
      ),
    );
    expect(chip.onTap, isNull);
  });
}
