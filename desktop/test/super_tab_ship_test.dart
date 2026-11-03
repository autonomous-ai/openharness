import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/pull_requests.dart';
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

  group('pull request chips', () {
    const own = 'https://github.com/autonomous-ai/openharness/pull/2527';
    const wrongOwner = 'https://github.com/openharness/openharness/pull/2527';

    test('two links for one pull request are one link, whatever their case', () {
      final links = superTabPullRequestLinks(
        '$own https://github.com/Autonomous-AI/OpenHarness/pull/2527 $own '
        'https://github.com/autonomous-ai/openharness/pull/2528',
      );
      expect([for (final l in links) l.pathSegments[3]], ['2527', '2528']);
    });

    test('a pull request elsewhere than the project\'s repository names it', () {
      final links = superTabPullRequestLinks('$own $wrongOwner');
      expect(
        superTabPullRequestLabels(
          links,
          repositoryUrl: 'git@github.com:autonomous-ai/openharness.git',
        ),
        ['openharness · PR #2527', 'openharness/openharness · PR #2527'],
      );
    });

    test('the project\'s repository is read in every form git writes it', () {
      final links = superTabPullRequestLinks('$own $wrongOwner');
      for (final address in [
        'ssh://git@github.com:22/autonomous-ai/openharness.git',
        'ssh://git@ssh.github.com:443/Autonomous-AI/OpenHarness.git',
        'git://github.com/autonomous-ai/openharness',
        'https://github.com/autonomous-ai/openharness.git/',
      ]) {
        expect(
          superTabPullRequestLabels(links, repositoryUrl: address),
          ['openharness · PR #2527', 'openharness/openharness · PR #2527'],
          reason: address,
        );
      }
    });

    test('without the project\'s repository, owners sharing a name show', () {
      final both = superTabPullRequestLinks('$own $wrongOwner');
      expect(superTabPullRequestLabels(both), [
        'autonomous-ai/openharness · PR #2527',
        'openharness/openharness · PR #2527',
      ]);
      expect(superTabPullRequestLabels(both.take(1).toList()), [
        'openharness · PR #2527',
      ]);
    });

    testWidgets('a ship line with two links for one pull request has one chip', (
      tester,
    ) async {
      await show(
        tester,
        shipServer(
          source: {
            'pullRequests': [
              own,
              'https://github.com/Autonomous-AI/openharness/pull/2527',
              'https://github.com/autonomous-ai/openharness/pull/2528',
            ],
          },
        )..state['project'] = {
          'machineId': 'm',
          'cwd': '/work',
          'repositoryUrl': 'https://github.com/autonomous-ai/openharness',
        },
      );
      expect(find.text('openharness · PR #2527'), findsOneWidget);
      expect(find.text('openharness · PR #2528'), findsOneWidget);
      expect(find.byType(OutlinedButton), findsNWidgets(2));
      await tester.pumpAndSettle();
    });

    testWidgets('a link in another repository shows owner and repository', (
      tester,
    ) async {
      await show(
        tester,
        shipServer(
          source: {
            'pullRequests': [own, wrongOwner],
          },
        )..state['project'] = {
          'machineId': 'm',
          'cwd': '/work',
          'repositoryUrl': 'https://github.com/autonomous-ai/openharness',
        },
      );
      expect(find.text('openharness · PR #2527'), findsOneWidget);
      expect(find.text('openharness/openharness · PR #2527'), findsOneWidget);
      await tester.pumpAndSettle();
    });
  });

  testWidgets('the conversation draws a ship message as the celebration', (
    tester,
  ) async {
    await showView(tester, shipServer(at: DateTime.now().toUtc()));
    expect(find.byType(SuperTabShipRow), findsOneWidget);
    await tester.pumpAndSettle();
  });
}
