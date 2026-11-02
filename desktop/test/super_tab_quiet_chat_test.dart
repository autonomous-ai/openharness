import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/ship_row.dart';
import 'package:harness/super_tabs/unread_line.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

final at = DateTime.utc(2026, 11, 2, 9);

Map<String, dynamic> row(
  String id,
  int sequence,
  String text, {
  String? kind,
  Map<String, Object?> source = const {},
}) => {
  'id': id,
  'conversationId': 'lead',
  'sequence': sequence,
  'text': text,
  'createdAt': at.toIso8601String(),
  'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
  'source': {'kind': ?kind, ...source},
};

ConversationServer project(List<Map<String, dynamic>> rows, {int read = 0}) {
  final server = ConversationServer();
  server.state['projects'] = [
    {
      ...projectFixture('lead', 'openharness', 'lead'),
      'status': {
        'text': 'Three fixes are on main tonight.',
        'at': at.toIso8601String(),
        'by': 'kai',
      },
    },
  ];
  server.messages.addAll(rows);
  final lead = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((g) => g['id'] == 'lead');
  lead['lastMessageSequence'] = rows.length;
  if (read > 0) {
    server.state['readMarks'] = {
      'owner': {'lead': read},
    };
  }
  return server;
}

void main() {
  testWidgets('the PM\'s report no longer sits over a project\'s chat', (
    tester,
  ) async {
    await showView(tester, project([row('m1', 1, 'Hello')]));
    expect(find.text('Three fixes are on main tonight.'), findsNothing);
    expect(find.textContaining('Three fixes'), findsNothing);
  });

  Map<String, dynamic> shipped() => row(
    's1',
    1,
    'Shipped: Avatars',
    kind: 'ship',
    source: {'title': 'Avatars', 'conversationId': 'task-1'},
  );

  testWidgets('a Shipped card stays while no line says the task shipped', (
    tester,
  ) async {
    final c = await showView(tester, project([shipped()]));
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabShipRow), findsOneWidget);
  });

  testWidgets('a Shipped card leaves the chat once the task has its line', (
    tester,
  ) async {
    final c = await showView(
      tester,
      project([
        shipped(),
        row(
          'l1',
          2,
          'Avatars · shipped',
          kind: 'task-line',
          source: {'taskId': 'task-1', 'title': 'Avatars', 'state': 'shipped'},
        ),
      ]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabShipRow), findsNothing);
    expect(find.text('Avatars'), findsOneWidget);
  });

  for (final kind in [
    'work-stalled',
    'work-lost',
    'work-resumed',
    'idle',
    'idle-stop',
    'review-failed',
    'update-request',
    'digest-request',
    'overlap',
    'pair-loop',
    'notice-digest',
  ]) {
    testWidgets(
      'the PM\'s notice "$kind" never shows in the chat people read',
      (tester) async {
        final c = await showView(
          tester,
          project([
            row('m1', 1, 'A message'),
            row('n1', 2, 'This notice is for the PM', kind: kind),
          ]),
        );
        await c.loadMessages('lead');
        await tester.pumpAndSettle();
        expect(find.text('A message'), findsOneWidget);
        expect(find.text('This notice is for the PM'), findsNothing);
      },
    );
  }

  testWidgets('the New line stays, on the first message people see', (
    tester,
  ) async {
    final c = await showView(
      tester,
      project([
        row('m1', 1, 'Read already'),
        row('n1', 2, 'This notice is for the PM', kind: 'work-stalled'),
        row('m2', 3, 'New to the reader'),
      ], read: 1),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabNewMessagesLine), findsOneWidget);
    expect(
      tester.getTopLeft(find.byType(SuperTabNewMessagesLine)).dy,
      lessThan(tester.getTopLeft(find.text('New to the reader')).dy),
    );
    expect(find.text('While you were away'), findsNothing);
    expect(find.textContaining('While you'), findsNothing);
  });
}
