import 'package:flutter_test/flutter_test.dart';
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
  testWidgets('the New line stays, on the first message people see', (
    tester,
  ) async {
    final c = await showView(
      tester,
      project([
        row('m1', 1, 'Read already'),
        row(
          'n1',
          2,
          'What was typed into the terminal',
          kind: 'native',
          source: {'phase': 'prompt'},
        ),
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
