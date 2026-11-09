import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3820 (Phase 2 of the Board, spec "A Needs you bar at the top lists everything waiting on the reader in this
/// project", "Answer a question or decision asked of them"): the bar over a switched project's Board, a click opening
/// the card's chat, and the answer sent there (#3817's `proposal.answer`).

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

Map<String, dynamic> _asked(String id, String title, String personId) => {
  ...conversationFixture(id, title),
  'projectId': 'lead',
  'agentIds': <String>[],
  'proposal': {
    'version': 1,
    'text': title,
    'createdAt': 1,
    'senders': [
      {'personId': 'owner', 'generation': 'g1'},
    ],
    'questions': [
      {
        'id': 'q-$id',
        'personId': personId,
        'question': 'Which screen first?',
        'defaultAnswer': 'Desktop',
        'deadline': DateTime.now()
            .add(const Duration(hours: 2))
            .millisecondsSinceEpoch,
        'requiresConsent': false,
      },
    ],
  },
};

void main() {
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    bool boardMode = true,
    List<Map<String, dynamic>> cards = const [],
  }) async {
    await tester.binding.setSurfaceSize(const Size(1600, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    (server.state['people'] as List).add({
      'id': 'tuan',
      'email': 'tuan@example.com',
      'role': 'collaborator',
    });
    final project = (server.state['projects'] as List).first as Map;
    if (boardMode) project['boardMode'] = true;
    (server.state['conversations'] as List).addAll(cards);
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await _settle(tester);
    // A project's Board opens from the Projects grid (task #4466).
    await tester.tap(find.byKey(const ValueKey('super-projects')));
    await tester.pump();
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  testWidgets('the bar lists what waits on the reader, and a click opens that '
      "card's chat", (tester) async {
    final (c, _) = await show(
      tester,
      cards: [
        _asked('first', 'Pin a card', 'owner'),
        _asked('second', 'Dark board', 'owner'),
        _asked('theirs', 'Asked of Tuan', 'tuan'),
      ],
    );
    expect(_key('super-board-needs-you'), findsOneWidget);
    expect(
      find.descendant(
        of: _key('super-board-needs-you'),
        matching: find.text('Needs you · 2'),
      ),
      findsOneWidget,
    );
    expect(_key('super-board-needs-you-first'), findsOneWidget);
    expect(_key('super-board-needs-you-second'), findsOneWidget);
    expect(_key('super-board-needs-you-theirs'), findsNothing);
    await tester.tap(_key('super-board-needs-you-second'));
    await _settle(tester);
    expect(c.selectedId, 'second');
    expect(_key('super-board-chat'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("the card's chat asks the reader its question, and the answer "
      'is sent', (tester) async {
    final (c, server) = await show(
      tester,
      cards: [_asked('first', 'Pin a card', 'owner')],
    );
    await tester.tap(_key('super-board-needs-you-first'));
    await _settle(tester);
    expect(
      find.descendant(
        of: _key('super-board-question'),
        matching: find.textContaining('Which screen first?'),
      ),
      findsOneWidget,
    );
    await tester.enterText(_key('super-board-answer'), 'Phone');
    await tester.tap(_key('super-board-answer-send'));
    await _settle(tester);
    expect(_commands(server, 'proposal.answer'), [
      {
        'type': 'proposal.answer',
        'conversationId': 'first',
        'questionId': 'q-first',
        'text': 'Phone',
      },
    ]);
    // Answered: nothing waits on the reader any more.
    expect(_key('super-board-question'), findsNothing);
    expect(_key('super-board-needs-you'), findsNothing);
    await end(tester, c);
  });

  testWidgets("a question to someone else isn't the reader's to answer", (
    tester,
  ) async {
    final (c, _) = await show(
      tester,
      cards: [_asked('theirs', 'Asked of Tuan', 'tuan')],
    );
    expect(_key('super-board-needs-you'), findsNothing);
    await tester.tap(_key('super-task-card-theirs'));
    await _settle(tester);
    expect(_key('super-board-answer'), findsNothing);
    await end(tester, c);
  });

  testWidgets('a project not on the Board has no bar', (tester) async {
    final (c, _) = await show(
      tester,
      boardMode: false,
      cards: [_asked('first', 'Pin a card', 'owner')],
    );
    expect(_key('super-board-needs-you'), findsNothing);
    await end(tester, c);
  });
}
