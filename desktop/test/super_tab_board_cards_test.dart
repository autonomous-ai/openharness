import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3820 (Phase 2 of the Board, spec "On each card a person can see"): on a project on the Board a card says the
/// PM's decision and its reason, an open question with its default and time, and is marked when it waits on the
/// reader; a paused task says so. The proposal record is #3817's (Fir), on the card's conversation.

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

// Today at 15:00, whatever today is: the card writes a deadline of another day with its date.
final _deadline = () {
  final today = DateTime.now();
  return DateTime(today.year, today.month, today.day, 15);
}();

Map<String, dynamic> _proposal({
  Map<String, dynamic>? decision,
  List<Map<String, dynamic>> questions = const [],
}) => {
  'version': 1,
  'text': 'Let people pin a card',
  'goal': 'Pinned cards stay on top',
  'why': 'Long boards hide what matters',
  'doneWhen': 'A pinned card sits first in its column',
  'evidence': <String>[],
  'createdAt': DateTime(2026, 11, 6, 9).millisecondsSinceEpoch,
  'senders': [
    {'personId': 'tuan', 'generation': 'g1', 'buddyId': 'buddy-tuan'},
  ],
  'decision': ?decision,
  'questions': questions,
};

Map<String, dynamic> _question(String personId, {Map? answer}) => {
  'id': 'q1',
  'personId': personId,
  'question': 'Pin per person or for everyone?',
  'defaultAnswer': 'For everyone',
  'deadline': _deadline.millisecondsSinceEpoch,
  'requiresConsent': false,
  'answer': ?answer,
};

void main() {
  Future<SuperTabController> show(
    WidgetTester tester, {
    bool boardMode = true,
    required List<Map<String, dynamic>> cards,
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
    final conversations = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    for (final card in cards) {
      conversations.add({
        ...conversationFixture(card['id'] as String, card['title'] as String),
        'projectId': 'lead',
        'agentIds': <String>[],
        ...card,
      });
    }
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
    return c;
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Finder inColumn(String column, String card) => find.descendant(
    of: _key('super-tasks-column-$column'),
    matching: _key('super-task-card-$card'),
  );

  String? note(WidgetTester tester, String card) {
    final found = _key('super-task-card-note-$card');
    return found.evaluate().isEmpty ? null : tester.widget<Text>(found).data;
  }

  testWidgets('an undecided proposal sits in Proposals, by who proposed it', (
    tester,
  ) async {
    final c = await show(
      tester,
      cards: [
        {'id': 'pin', 'title': 'Pin a card', 'proposal': _proposal()},
      ],
    );
    expect(inColumn('proposals', 'pin'), findsOneWidget);
    // Who proposed it is the card's requester avatar, as a tile names no one in text (#3869).
    final proposer = find.descendant(
      of: _key('super-task-card-pin'),
      matching: _key('super-card-requester'),
    );
    expect(proposer, findsOneWidget);
    expect(tester.widget<SuperTabAvatar>(proposer).identity, 'person:tuan');
    expect(note(tester, 'pin'), isNull);
    await end(tester, c);
  });

  testWidgets("the PM's decision shows with its reason: Later until its date "
      'and No stay in Proposals; Accepted goes on as a task', (tester) async {
    final c = await show(
      tester,
      cards: [
        {
          'id': 'later',
          'title': 'Later card',
          'proposal': _proposal(
            decision: {
              'kind': 'later',
              'reason': 'After the release',
              'at': 1,
              'by': 'lead',
              'revisitAt': DateTime(2026, 12, 4).millisecondsSinceEpoch,
            },
          ),
        },
        {
          'id': 'no',
          'title': 'Declined card',
          'proposal': _proposal(
            decision: {
              'kind': 'no',
              'reason': 'Out of scope',
              'at': 1,
              'by': 'lead',
            },
          ),
        },
        {
          'id': 'yes',
          'title': 'Accepted card',
          'number': 77,
          'proposal': _proposal(
            decision: {
              'kind': 'accept',
              'reason': 'Small and clear',
              'at': 1,
              'by': 'lead',
            },
          ),
        },
      ],
    );
    expect(inColumn('proposals', 'later'), findsOneWidget);
    expect(note(tester, 'later'), 'Later, Dec 4: After the release');
    expect(inColumn('proposals', 'no'), findsOneWidget);
    expect(note(tester, 'no'), 'No: Out of scope');
    expect(inColumn('nextUp', 'yes'), findsOneWidget);
    expect(note(tester, 'yes'), 'Accepted: Small and clear');
    await end(tester, c);
  });

  testWidgets('a question to the reader marks the card Needs you with its '
      "default and time; one to someone else names them and isn't the "
      "reader's", (tester) async {
    final c = await show(
      tester,
      cards: [
        {
          'id': 'mine',
          'title': 'Asked of me',
          'proposal': _proposal(questions: [_question('owner')]),
        },
        {
          'id': 'theirs',
          'title': 'Asked of Tuan',
          'proposal': _proposal(questions: [_question('tuan')]),
        },
        {
          'id': 'answered',
          'title': 'Answered',
          'proposal': _proposal(
            questions: [
              _question(
                'owner',
                answer: {'text': 'Per person', 'at': 1, 'by': 'owner'},
              ),
            ],
          ),
        },
      ],
    );
    expect(
      note(tester, 'mine'),
      'Asks you: Pin per person or for everyone? '
      'If no answer by 15:00: For everyone',
    );
    expect(
      find.descendant(
        of: _key('super-task-card-mine'),
        matching: find.textContaining('Needs you'),
      ),
      findsOneWidget,
    );
    expect(
      note(tester, 'theirs'),
      'Asks tuan: Pin per person or for everyone? '
      'If no answer by 15:00: For everyone',
    );
    expect(
      find.descendant(
        of: _key('super-task-card-theirs'),
        matching: find.textContaining('Needs you'),
      ),
      findsNothing,
    );
    expect(note(tester, 'answered'), isNull);
    await end(tester, c);
  });

  testWidgets('a paused task says who paused it', (tester) async {
    final c = await show(
      tester,
      cards: [
        {
          'id': 'held',
          'title': 'Held task',
          'number': 80,
          'paused': {'by': 'tuan', 'at': 1, 'reason': 'Waiting for 1.3.84'},
        },
      ],
    );
    expect(note(tester, 'held'), 'Paused by tuan: Waiting for 1.3.84');
    await end(tester, c);
  });

  testWidgets('a project not on the Board draws its cards as today', (
    tester,
  ) async {
    final c = await show(
      tester,
      boardMode: false,
      cards: [
        {
          'id': 'pin',
          'title': 'Pin a card',
          'proposal': _proposal(questions: [_question('owner')]),
        },
        {
          'id': 'held',
          'title': 'Held task',
          'number': 80,
          'paused': {'by': 'tuan', 'at': 1},
        },
      ],
    );
    expect(note(tester, 'pin'), isNull);
    expect(note(tester, 'held'), isNull);
    expect(inColumn('proposals', 'pin'), findsNothing);
    await end(tester, c);
  });
}
