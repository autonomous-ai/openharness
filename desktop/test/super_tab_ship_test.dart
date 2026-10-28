import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/ship_row.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

final now = DateTime.utc(2026, 10, 27, 9);

Map<String, dynamic> shipRow({
  DateTime? at,
  Map<String, Object?> source = const {},
}) => {
  'id': 'ship-1',
  'conversationId': 'lead',
  'sequence': 5,
  'text': '🎉 Shipped: Avatars, requested by owner, built by Kai, reviewed by Ivy. https://github.com/example/app/pull/7',
  'createdAt': (at ?? now).toIso8601String(),
  'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
  'source': {
    'kind': 'ship',
    'conversationId': 'group-1',
    'title': 'Avatars',
    'pullRequests': ['https://github.com/example/app/pull/7'],
    'requesterId': 'owner',
    'builderIds': ['kai'],
    'reviewerIds': ['ivy'],
    ...source,
  },
};

ConversationServer shipServer({
  DateTime? at,
  Map<String, Object?> source = const {},
}) {
  final server = ConversationServer();
  server.state['agents'] = [
    for (final (id, name) in [('kai', 'Kai'), ('ivy', 'Ivy')])
      {
        'id': id,
        'name': name,
        'machineId': 'm',
        'harnessId': id,
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
  ];
  server.messages.add(shipRow(at: at, source: source));
  (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] =
      5;
  return server;
}

Future<void> show(
  WidgetTester tester,
  ConversationServer server, {
  bool reduceMotion = false,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await c.loadMessages('lead');
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: child!,
      ),
      home: Scaffold(
        body: SuperTabShipRow(
          message: c.messages('lead').single,
          controller: c,
          now: () => now,
        ),
      ),
    ),
  );
}

void main() {
  setUp(SuperTabShipRow.resetPlayed);

  testWidgets(
    'a ship line names who asked, built and reviewed, each with an avatar',
    (tester) async {
      await show(tester, shipServer());
      expect(find.text('Shipped: Avatars'), findsOneWidget);
      for (final words in [
        'Requested by',
        'owner',
        'Built by',
        'Kai',
        'Reviewed by',
        'Ivy',
      ]) {
        expect(find.text(words), findsOneWidget, reason: words);
      }
      expect(find.byType(SuperTabAvatar), findsNWidgets(3));
      expect(find.text('app · PR #7'), findsOneWidget);
      await tester.pumpAndSettle();
    },
  );

  testWidgets('a fresh celebration throws confetti once, then it is gone', (
    tester,
  ) async {
    await show(tester, shipServer());
    expect(find.byKey(const ValueKey('super-confetti')), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.byKey(const ValueKey('super-confetti')), findsNothing);
    await show(tester, shipServer());
    expect(find.byKey(const ValueKey('super-confetti')), findsNothing);
  });

  testWidgets('a rebuild during the burst does not cut it short', (tester) async {
    final server = shipServer();
    await show(tester, server);
    await tester.pump(const Duration(milliseconds: 500));
    await show(tester, server);
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.byKey(const ValueKey('super-confetti')), findsOneWidget);
    await tester.pumpAndSettle();
  });

  testWidgets('reduced motion keeps the line still', (tester) async {
    await show(tester, shipServer(), reduceMotion: true);
    expect(find.byKey(const ValueKey('super-confetti')), findsNothing);
    expect(find.text('Shipped: Avatars'), findsOneWidget);
  });

  testWidgets('an old celebration in the history throws none', (tester) async {
    await show(tester, shipServer(at: now.subtract(const Duration(hours: 3))));
    expect(find.byKey(const ValueKey('super-confetti')), findsNothing);
  });

  testWidgets('without who asked, that credit is left out', (tester) async {
    await show(tester, shipServer(source: {'requesterId': null}));
    expect(find.text('Requested by'), findsNothing);
    expect(find.byType(SuperTabAvatar), findsNWidgets(2));
    await tester.pumpAndSettle();
  });

  testWidgets('the conversation draws a ship message as the celebration', (
    tester,
  ) async {
    await showView(tester, shipServer(at: DateTime.now().toUtc()));
    expect(find.byType(SuperTabShipRow), findsOneWidget);
    await tester.pumpAndSettle();
  });
}
