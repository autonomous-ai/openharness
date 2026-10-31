import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_code_block.dart';
import 'package:harness_mobile/swarm/swarm_instructions_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// The phone's read-only page of a project's instructions and the
/// coordinator's notes (project instructions, phase 5, task 10).
void main() {
  const path = '/api/super-tabs/$tab/projects/$project/instructions';

  Map<String, dynamic> head(int revision, {int notes = 1}) => headData(
    projects: [
      {
        ...(headData()['projects'] as List).first as Map<String, dynamic>,
        'coordinatorName': 'Product Manager',
        'instructionsRevision': revision,
        'notesRevision': notes,
      },
    ],
  );

  Map<String, dynamic> doc(
    int revision,
    String text, {
    List<Map<String, dynamic>> notes = const [],
  }) => {
    'projectId': project,
    'revision': revision,
    'hash': 'h$revision',
    'text': text,
    'template': false,
    'coordinatorName': 'Product Manager',
    'notesRevision': 1,
    'notes': notes,
  };

  Map<String, dynamic> note(
    String id,
    String text,
    String at, {
    String askedBy = me,
    String? expiresAt,
  }) => {
    'id': id,
    'text': text,
    'askedBy': askedBy,
    'at': at,
    'expiresAt': expiresAt,
  };

  Future<({FakeSwarm fake, SwarmReader reader})> open(
    WidgetTester tester, {
    required Object? Function(Map<String, dynamic>? body) route,
    int revision = 3,
  }) async {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final load = firstLoad(head: head(revision));
      // The member's username differs from their id.
      load['members'] = [
        part(me, 1, {...person(me), 'username': 'ken'}),
      ];
      return load;
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes[path] = route;
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: fake.request,
    );
    addTearDown(reader.dispose);
    await reader.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmInstructionsPage(reader: reader, projectId: project),
      ),
    );
    await tester.pumpAndSettle();
    return (fake: fake, reader: reader);
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  int reads(FakeSwarm fake) => fake.paths.where((p) => p == path).length;

  testWidgets('shows the document and the notes, read only', (tester) async {
    final (:fake, reader: _) = await open(
      tester,
      route: (_) => doc(
        3,
        '## Roles\n### PM\n- Talks with people\n\n```sh\nmake test\n```',
        notes: [
          note('n1', 'Older note', '2026-10-29T01:00:00.000Z'),
          note('n2', 'Newer note', '2026-10-29T02:00:00.000Z'),
          note('n3', 'Third note', '2026-10-29T00:00:00.000Z', askedBy: 'gone'),
        ],
      ),
    );
    expect(reads(fake), 1);
    expect(find.textContaining('revision 3'), findsOneWidget);
    expect(
      find.descendant(
        of: key('swarm-instructions-text'),
        matching: find.textContaining('Talks with people', findRichText: true),
      ),
      findsOneWidget,
    );
    expect(find.byType(SwarmCodeBlock), findsOneWidget);
    expect(find.text('Product Manager’s notes'), findsOneWidget);
    expect(
      tester.getTopLeft(key('swarm-instructions-note-n2')).dy,
      lessThan(tester.getTopLeft(key('swarm-instructions-note-n1')).dy),
    );
    expect(find.textContaining('asked by ken'), findsNWidgets(2));
    expect(find.textContaining('asked by a member'), findsOneWidget);
    expect(find.textContaining(me), findsNothing);
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(EditableText), findsNothing);
    expect(find.text('Save'), findsNothing);
    expect(find.text('Delete'), findsNothing);
    expect(find.text('Restore'), findsNothing);
  });

  testWidgets('says No notes. with none', (tester) async {
    await open(tester, route: (_) => doc(3, 'Text'));
    expect(find.text('No notes.'), findsOneWidget);
  });

  testWidgets('shows the revision a member saved from Desktop', (tester) async {
    var revision = 3;
    final (:fake, :reader) = await open(
      tester,
      route: (_) => doc(revision, 'Text of revision $revision'),
    );
    expect(find.textContaining('Text of revision 3'), findsOneWidget);
    expect(reads(fake), 1);

    revision = 4;
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c3'),
      'head': part('head', 2, head(4)),
    };
    await reader.refresh();
    await tester.pumpAndSettle();

    expect(find.textContaining('Text of revision 4'), findsOneWidget);
    expect(find.textContaining('revision 4'), findsWidgets);
    expect(reads(fake), 2);
  });

  testWidgets('a backend without instructions says so', (tester) async {
    await open(
      tester,
      route: (_) => throw const SuperTabFailure(
        'BACKEND_UNAVAILABLE',
        'No such route',
        statusCode: 404,
      ),
    );
    expect(
      find.text('This Swarm has no project instructions yet.'),
      findsOneWidget,
    );
    expect(find.text('Try again'), findsNothing);
  });

  testWidgets('a failed read says why and tries again', (tester) async {
    var fail = true;
    final (:fake, reader: _) = await open(
      tester,
      route: (_) {
        if (fail) {
          throw const SuperTabFailure(
            'BACKEND_UNAVAILABLE',
            'The server is busy.',
            statusCode: 503,
          );
        }
        return doc(3, 'Back again');
      },
    );
    expect(find.text('The server is busy.'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Back again'), findsOneWidget);
    expect(reads(fake), 2);
  });

  testWidgets('a note ends at a time today, else a date', (tester) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day, 23, 59);
    final later = DateTime(now.year + 1, 3, 4, 18, 0);
    await open(
      tester,
      route: (_) => doc(
        3,
        'Text',
        notes: [
          note(
            'n1',
            'Today',
            now.toUtc().toIso8601String(),
            expiresAt: today.toUtc().toIso8601String(),
          ),
          note(
            'n2',
            'Later',
            now.toUtc().toIso8601String(),
            expiresAt: later.toUtc().toIso8601String(),
          ),
        ],
      ),
    );
    expect(find.textContaining('until 23:59'), findsOneWidget);
    expect(
      find.textContaining('until 4 Mar ${now.year + 1}, 18:00'),
      findsOneWidget,
    );
  });

  testWidgets('a failed re-read shows its error above the document', (
    tester,
  ) async {
    var fail = false;
    final (:fake, :reader) = await open(
      tester,
      route: (_) {
        if (fail) {
          throw const SuperTabFailure(
            'BACKEND_UNAVAILABLE',
            'The server is busy.',
            statusCode: 503,
          );
        }
        return doc(3, 'Kept text');
      },
    );
    fail = true;
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c3'),
      'head': part('head', 2, head(4)),
    };
    await reader.refresh();
    await tester.pumpAndSettle();
    expect(find.text('The server is busy.'), findsOneWidget);
    expect(find.textContaining('Kept text'), findsOneWidget);
  });
}
