import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/ship_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/thread_panel.dart';
import 'package:harness/super_tabs/unread_line.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_mentions_test.dart' show showView, shot;
import 'support/super_tab_fixture.dart';

const _legacyProposal =
    "Proposal from Dee's Buddy, on Dee's behalf.\n\n"
    'Goal: Save offline drafts.\nScope: Desktop and phone\nPriority: high';

Map<String, dynamic> _root(String kind, {bool legacy = false}) => {
  'id': 'root',
  'conversationId': 'lead',
  'thread': 'root',
  'sequence': 1,
  'text': legacy
      ? kind == 'task-line'
            ? 'Save offline drafts · in review'
            : _legacyProposal
      : "Let's build: Offline drafts",
  'createdAt': '2026-11-03T09:00:00Z',
  'author': legacy
      ? {'kind': 'agent', 'id': 'buddy', 'name': 'Draft Buddy'}
      : {'kind': 'person', 'id': 'requester', 'name': 'dee@example.com'},
  'source': {
    'kind': kind,
    if (kind == 'task-line') ...{
      'taskId': 'offline',
      'title': 'Save offline drafts',
      'state': 'review',
    } else
      'personId': 'requester',
  },
  'reactions': [
    {
      'emoji': 'heart',
      'count': 1,
      'by': [
        {'kind': 'agent', 'id': 'buddy'},
      ],
    },
  ],
};

ConversationServer _server(String kind, {bool legacy = false}) {
  final server = ConversationServer()..threads = true;
  (server.state['people'] as List).add({
    'id': 'requester',
    'email': 'dee@example.com',
    'username': 'dee',
    'role': 'member',
  });
  server.state['agents'] = [
    {
      'id': 'buddy',
      'name': 'Draft Buddy',
      'machineId': 'mac',
      'harnessId': 'buddy',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  server.messages.addAll([
    _root(kind, legacy: legacy),
    {
      'id': 'details',
      'conversationId': 'lead',
      'thread': 'root',
      'replyTo': 'root',
      'sequence': 2,
      'text': 'Goal: Save offline drafts.\nScope: Desktop and phone\nPriority: high',
      'createdAt': '2026-11-03T09:01:00Z',
      'author': {'kind': 'agent', 'id': 'buddy', 'name': 'Draft Buddy'},
    },
  ]);
  (server.state['conversations'] as List).first['lastMessageSequence'] = 2;
  return server;
}

Finder _row(String id, {bool thread = false}) => find.byKey(
  ValueKey('${thread ? 'super-thread-message' : 'super-message'}-$id'),
);

void main() {
  // A source-based compact row, title substitution, or task-conversation
  // navigation loses message content/actions; these exercise the real view.
  for (final kind in ['task-line', 'buddy-proposal']) {
    testWidgets('$kind root keeps the requester identity and message actions', (
      tester,
    ) async {
      final server = _server(kind);
      await showView(tester, server);
      final row = _row('root');
      expect(tester.widget(row), isA<SuperTabMessageRow>());
      expect(
        find.descendant(of: row, matching: find.text('dee')),
        findsOneWidget,
      );
      final avatar = tester.widget<SuperTabAvatar>(
        find.descendant(of: row, matching: find.byType(SuperTabAvatar)).first,
      );
      expect(avatar.identity, 'person:requester');
      expect(
        find.descendant(of: row, matching: find.text('Offline drafts')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('super-proposal-label')), findsNothing);
      expect(find.textContaining('Scope:'), findsNothing);
      expect(
        find.byKey(const ValueKey('super-thread-count-root')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.byTooltip('Reply')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.byTooltip('Add reaction')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('super-reaction-root-heart')));
      await tester.pumpAndSettle();
      final sent =
          server.posts.lastWhere(
                (p) => (p['command'] as Map?)?['type'] == 'message.react',
              )['command']
              as Map;
      expect(sent['messageId'], 'root');
      expect(sent['emoji'], 'heart');
      expect(sent['on'], isTrue);
      expect(
        find.descendant(of: row, matching: find.text('2')),
        findsOneWidget,
      );
    });

    testWidgets(
      'legacy $kind keeps its complete text and ordinary thread at narrow width',
      (tester) async {
        final c = await showView(tester, _server(kind, legacy: true));
        await tester.binding.setSurfaceSize(const Size(800, 800));
        await tester.pumpAndSettle();
        final row = _row('root');
        expect(tester.widget(row), isA<SuperTabMessageRow>());
        expect(
          find.descendant(of: row, matching: find.text('Draft Buddy')),
          findsOneWidget,
        );
        final text = tester.widget<SuperTabMessageText>(
          find.descendant(of: row, matching: find.byType(SuperTabMessageText)),
        );
        expect(
          text.text,
          kind == 'task-line'
              ? 'Save offline drafts · in review'
              : _legacyProposal,
        );
        if (kind == 'buddy-proposal') {
          expect(
            find.descendant(
              of: row,
              matching: find.textContaining("on Dee's behalf."),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: row,
              matching: find.textContaining('Priority: high'),
            ),
            findsOneWidget,
          );
        } else {
          expect(
            find.descendant(
              of: row,
              matching: find.text('Save offline drafts · in review'),
            ),
            findsOneWidget,
          );
        }
        await tester.tap(find.byKey(const ValueKey('super-thread-line-root')));
        await tester.pumpAndSettle();
        expect(c.openedThread?.root, 'root');
        expect(c.selectedId, 'lead');
        expect(find.byType(SuperTabThreadPanel), findsOneWidget);
        expect(find.textContaining('Scope: Desktop and phone'), findsWidgets);
        expect(tester.takeException(), isNull);
        await tester.tap(find.byKey(const ValueKey('super-thread-close')));
        await tester.pumpAndSettle();
        expect(c.openedThread, isNull);
      },
    );
  }

  testWidgets('a legacy task root keeps its recorded ship message visible', (
    tester,
  ) async {
    final server = _server('task-line', legacy: true);
    server.messages.add({
      'id': 'ship',
      'conversationId': 'lead',
      'thread': 'ship',
      'sequence': 3,
      'text': 'Shipped: Offline drafts',
      'createdAt': '2026-11-03T09:02:00Z',
      'author': {'kind': 'agent', 'id': 'buddy', 'name': 'Draft Buddy'},
      'source': {
        'kind': 'ship',
        'conversationId': 'offline',
        'title': 'Offline drafts',
        'requesterId': 'requester',
        'builderIds': ['buddy'],
      },
    });
    (server.state['conversations'] as List).first['lastMessageSequence'] = 3;
    await showView(tester, server);
    expect(find.text('Save offline drafts · in review'), findsOneWidget);
    expect(find.byType(SuperTabShipRow), findsOneWidget);
    expect(find.text('Offline drafts'), findsOneWidget);
    await tester.tap(find.text('What changed'));
    await tester.pumpAndSettle();
    expect(find.text('Built by'), findsOneWidget);
  });

  // Dee, 2026-11-04 (#2552): an ask's row reads as its title alone, with where
  // it stands after the time; older rows still carry the old prefix.
  group('an ask row', () {
    // Anh Dee, 11-04 ('bot messages'): a task's agent reacts 👀 and ✅ on
    // the message that asked; the row draws no On it or Shipped, even from a
    // server that still sends them.

    testWidgets('has no tag at the head of its own thread', (tester) async {
      final server = _server('task-line')..threadAsks['root'] = 'proposal';
      final c = await showView(tester, server);
      c.openThread('root');
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: _row('root', thread: true),
          matching: find.text('✋ Proposal'),
        ),
        findsNothing,
      );
    });
  });

  testWidgets('plain proposal and task thread screenshot fixture', (
    tester,
  ) async {
    await loadPreviewFonts();
    final server = _server('buddy-proposal');
    server.messages.first['reactions'] = <dynamic>[];
    final c = await showView(tester, server, brightness: Brightness.light);
    await shot(tester, 'desktop-plain-chat');
    c.openThread('root');
    await tester.pumpAndSettle();
    expect(find.textContaining('Scope: Desktop and phone'), findsOneWidget);
    await shot(tester, 'desktop-plain-chat-thread');
  });

  test("a root the server posted in the reader's name is not their own "
      'writing, so it reads nothing before it (plain chat, #2294)', () {
    final c = ConversationServer().controller();
    addTearDown(c.dispose);
    SuperTabMessage row(
      int sequence,
      Map<String, Object> author, [
      String? kind,
    ]) => SuperTabMessage.fromJson({
      'id': 'm$sequence',
      'conversationId': 'lead',
      'sequence': sequence,
      'text': 'Message $sequence',
      'createdAt': '2026-11-03T09:00:00Z',
      'author': author,
      'source': ?(kind == null ? null : {'kind': kind}),
    });
    final reader = {
      'kind': 'person',
      'id': c.accountId,
      'name': 'owner@example.com',
    };
    final river = {'kind': 'agent', 'id': 'lead-agent', 'name': 'River'};
    for (final kind in ['task-line', 'buddy-proposal']) {
      final root = row(3, reader, kind);
      expect(root.postedForAuthor, isTrue);
      expect(c.isOwn(root), isFalse);
      expect(
        superTabFirstUnread(
          [row(1, river), row(2, river), root],
          1,
          own: c.isOwn,
        ),
        'm2',
      );
    }
    expect(c.isOwn(row(4, reader)), isTrue);
  });
}
