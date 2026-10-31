import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/live_card.dart';
import 'package:harness/super_tabs/live_card_model.dart';
import 'package:harness/super_tabs/pull_request_facts.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

const pr = 'https://github.com/example/app/pull/7';
const other = 'https://github.com/example/app/pull/8';

Map<String, dynamic> found(
  String url, {
  String state = 'Open',
  int passed = 12,
  int pending = 0,
  int total = 12,
}) => {
  'url': url,
  'status': 'found',
  'title': 'Round avatars',
  'state': state,
  'checks': {'passed': passed, 'failed': 0, 'pending': pending, 'total': total},
};

/// #14, a task linked to "work" whose one check passed.
final linkedReview = {
  ...conversationFixture('review', 'Review avatars'),
  'number': 14,
  'reviewOf': 'work',
  'agentIds': ['ivy'],
  'checks': [
    {'id': 'r', 'description': 'Reviewed', 'evidence': 'ok', 'passedBy': 'ivy'},
  ],
};

/// A workgroup with a builder, a reviewer whose verdict is in the chat, and the
/// two cards the backend names: its brief is the task card, its first link of
/// [pr] the PR card. With [linked], the tasks linked to it.
ConversationServer cardServer({
  int? mergedAt,
  List<Map<String, dynamic>> linked = const [],
}) {
  final server = ConversationServer();
  server.state['agents'] = [
    for (final (id, name, role) in [
      ('kai', 'Kai', null),
      ('ivy', 'Ivy', 'reviewer'),
    ])
      {
        'id': id,
        'name': name,
        'machineId': 'm',
        'harnessId': id,
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
        'role': ?role,
      },
  ];
  (server.state['conversations'] as List).add({
    ...conversationFixture('work', 'Avatars'),
    'number': 12,
    'agentIds': ['kai', 'ivy'],
    'brief': 'Add avatars.',
    'checks': [
      {
        'id': 'a',
        'description': 'Tests pass',
        'evidence': 'ok',
        'passedBy': 'agent:kai',
      },
      {'id': 'b', 'description': 'Screens', 'evidence': null},
    ],
    'assignment': {'id': 'w', 'agentId': 'kai', 'status': 'working'},
    'pullRequestUrls': [pr],
    'cards': {
      'task': 'message-1',
      'pullRequests': [
        {'url': pr, 'messageId': 'message-2', 'mergedAt': ?mergedAt},
      ],
    },
  });
  (server.state['conversations'] as List).addAll(linked);
  server.append('Add avatars.', conversationId: 'work');
  server.append('Opened $pr', conversationId: 'work');
  server.append('Ready: yes on 1a2b3c4d5', conversationId: 'work');
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'ivy',
    'name': 'Ivy',
  };
  server.append('CI is running on $pr', conversationId: 'work');
  return server;
}

Future<SuperTabController> show(
  WidgetTester tester,
  ConversationServer server,
  SuperTabPullRequestFacts facts,
  String messageId,
) async {
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await c.loadMessages('work');
  final group = c.snapshot!.conversation('work')!;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabLiveCard(
          group: group,
          card: group.cards.of(messageId)!,
          controller: c,
          facts: facts,
        ),
      ),
    ),
  );
  await tester.pump();
  return c;
}

SuperTabPullRequestFacts reading(
  List<Map<String, dynamic>> Function() answer, {
  void Function(List<String>)? onRead,
}) => SuperTabPullRequestFacts((urls) async {
  onRead?.call(urls);
  return {'account': 'ada', 'rows': answer()};
});

void main() {
  test('a group names which of its messages are cards', () {
    final cards = SuperTabCards.fromJson({
      'task': 'm1',
      'pullRequests': [
        {'url': pr, 'messageId': 'm2'},
        {'url': other, 'messageId': 'm2', 'mergedAt': 5},
        {'url': 'https://example.com/x', 'messageId': 'm3'},
      ],
    });
    expect(cards.of('m1')!.task, isTrue);
    expect(cards.of('m1')!.pullRequests, isEmpty);
    expect(cards.of('m2')!.task, isFalse);
    expect(cards.of('m2')!.pullRequests.map((p) => p.url), [pr, other]);
    expect(cards.of('m2')!.pullRequests.last.merged, isTrue);
    expect(cards.of('m3'), isNull);
    expect(SuperTabCards.fromJson(null).of('m1'), isNull);
  });

  testWidgets('a PR card shows its title, state, checks and the linked tasks', (
    tester,
  ) async {
    final facts = reading(() => [found(pr)]);
    addTearDown(facts.dispose);
    await show(tester, cardServer(linked: [linkedReview]), facts, 'message-2');
    expect(find.text('Round avatars'), findsOneWidget);
    expect(find.text('app · PR #7'), findsOneWidget);
    expect(find.text('Open'), findsOneWidget);
    expect(find.text('12 checks passed'), findsOneWidget);
    expect(find.text('#14 Review avatars: passed'), findsOneWidget);
    // The reviewer's `Ready: yes` in the chat is not read.
    expect(find.textContaining('Reviewer: '), findsNothing);
  });

  testWidgets('without GitHub on this computer, CI is left out quietly', (
    tester,
  ) async {
    final facts = SuperTabPullRequestFacts(
      (_) async => {'error': 'GH_SIGNED_OUT'},
    );
    addTearDown(facts.dispose);
    await show(tester, cardServer(mergedAt: 5), facts, 'message-2');
    expect(find.text('app · PR #7'), findsOneWidget);
    expect(find.text('Merged'), findsOneWidget);
    expect(find.textContaining('check'), findsNothing);
    expect(find.textContaining('GitHub'), findsNothing);
  });

  testWidgets('a card with no reader at all shows what the Swarm knows', (
    tester,
  ) async {
    final facts = SuperTabPullRequestFacts(null);
    addTearDown(facts.dispose);
    await show(tester, cardServer(), facts, 'message-2');
    expect(find.text('app · PR #7'), findsOneWidget);
    expect(find.textContaining('check'), findsNothing);
  });

  testWidgets('a task card shows its title, status, checks and its PRs', (
    tester,
  ) async {
    final facts = reading(() => [found(pr)]);
    addTearDown(facts.dispose);
    await show(tester, cardServer(linked: [linkedReview]), facts, 'message-1');
    expect(find.text('#12 Avatars'), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);
    expect(find.text('1 of 2 checks passed'), findsOneWidget);
    expect(find.text('Round avatars'), findsOneWidget);
    expect(find.text('#14 Review avatars: passed'), findsOneWidget);
    expect(find.textContaining('Reviewer: '), findsNothing);
  });

  testWidgets('a task in review is waiting on others', (tester) async {
    final server = cardServer();
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'work')['assignment'] = {
      'id': 'w',
      'agentId': 'kai',
      'status': 'review',
    };
    final facts = SuperTabPullRequestFacts(null);
    addTearDown(facts.dispose);
    await show(tester, server, facts, 'message-1');
    expect(find.text('Waiting on others'), findsOneWidget);
    expect(find.text('In review'), findsNothing);
  });

  testWidgets('a failed check keeps its evidence and is not counted passed', (
    tester,
  ) async {
    final server = cardServer();
    final group = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'work');
    // As the server records a failed check: its evidence, nobody passing it.
    (group['checks'] as List)[1] = {
      'id': 'b',
      'description': 'Screens',
      'evidence': 'Two screens cut off',
      'passedBy': null,
    };
    final facts = SuperTabPullRequestFacts(null);
    addTearDown(facts.dispose);
    await show(tester, server, facts, 'message-1');
    expect(find.text('1 of 2 checks passed'), findsOneWidget);
  });

  testWidgets('the card updates in place as the PR changes', (tester) async {
    var answer = found(pr, passed: 3, pending: 9);
    final facts = reading(() => [answer]);
    addTearDown(facts.dispose);
    await show(tester, cardServer(), facts, 'message-2');
    expect(find.text('3 of 12 checks done'), findsOneWidget);
    answer = found(pr, state: 'Merged');
    await tester.pump(SuperTabPullRequestFacts.every);
    await tester.pump();
    expect(find.text('Merged'), findsOneWidget);
    expect(find.text('3 of 12 checks done'), findsNothing);
  });

  testWidgets(
    'a sign-out or another GitHub account clears a card, even one whose PRs are all merged',
    (tester) async {
      Map<String, dynamic> answer = {
        'account': 'ada',
        'rows': [found(pr, state: 'Merged')],
      };
      final facts = SuperTabPullRequestFacts((_) async => answer);
      addTearDown(facts.dispose);
      await show(tester, cardServer(), facts, 'message-2');
      expect(find.text('Round avatars'), findsOneWidget);
      answer = {'account': 'none', 'error': 'GH_SIGNED_OUT'};
      await tester.pump(SuperTabPullRequestFacts.every);
      await tester.pump();
      expect(find.text('Round avatars'), findsNothing);
      answer = {
        'account': 'ada',
        'rows': [found(pr, state: 'Merged')],
      };
      await tester.pump(SuperTabPullRequestFacts.every);
      await tester.pump();
      expect(find.text('Round avatars'), findsOneWidget);
      // Another account, which cannot read that repository.
      answer = {
        'account': 'grace',
        'rows': [
          {'url': pr, 'status': 'no_access'},
        ],
      };
      await tester.pump(SuperTabPullRequestFacts.every);
      await tester.pump();
      expect(find.text('Round avatars'), findsNothing);
      expect(find.text('app · PR #7'), findsOneWidget);
    },
  );

  testWidgets(
    'a switch to another GitHub account clears a card at once, even while its reads fail',
    (tester) async {
      Map<String, dynamic> answer = {
        'account': 'ada',
        'rows': [found(pr)],
      };
      final facts = SuperTabPullRequestFacts((_) async => answer);
      addTearDown(facts.dispose);
      await show(tester, cardServer(), facts, 'message-2');
      expect(find.text('Round avatars'), findsOneWidget);
      expect(find.text('12 checks passed'), findsOneWidget);
      for (final error in ['TIMEOUT', 'RATE_LIMITED']) {
        answer = {
          'account': 'grace-$error',
          'error': error,
          'rows': [
            {'url': pr, 'status': 'unavailable', 'error': error},
          ],
        };
        await tester.pump(SuperTabPullRequestFacts.every);
        await tester.pump();
        expect(find.text('Round avatars'), findsNothing, reason: error);
        expect(find.text('12 checks passed'), findsNothing, reason: error);
        expect(find.text('app · PR #7'), findsOneWidget, reason: error);
      }
    },
  );

  testWidgets('an answer that names no account shows no private details', (
    tester,
  ) async {
    final facts = SuperTabPullRequestFacts(
      (_) async => {
        'rows': [found(pr)],
      },
    );
    addTearDown(facts.dispose);
    await show(tester, cardServer(), facts, 'message-2');
    expect(find.text('Round avatars'), findsNothing);
    expect(find.textContaining('check'), findsNothing);
    expect(find.text('app · PR #7'), findsOneWidget);
  });

  testWidgets(
    'a merge the Swarm recorded wins over an open read, even while GitHub fails',
    (tester) async {
      Map<String, dynamic> answer = {
        'account': 'ada',
        'rows': [found(pr, passed: 3, pending: 9)],
      };
      final facts = SuperTabPullRequestFacts((_) async => answer);
      addTearDown(facts.dispose);
      await show(tester, cardServer(), facts, 'message-2');
      expect(find.text('Open'), findsOneWidget);
      answer = {'account': 'ada', 'error': 'RATE_LIMITED'};
      final c = cardServer(mergedAt: 5).controller();
      addTearDown(c.dispose);
      await c.refresh();
      final group = c.snapshot!.conversation('work')!;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabLiveCard(
              group: group,
              card: group.cards.of('message-2')!,
              controller: c,
              facts: facts,
            ),
          ),
        ),
      );
      await tester.pump(SuperTabPullRequestFacts.every);
      await tester.pump();
      expect(find.text('Merged'), findsOneWidget);
      expect(find.text('Open'), findsNothing);
      expect(find.text('3 of 12 checks done'), findsNothing);
    },
  );

  testWidgets(
    "a linked task without checks reads its work's status, never a Ready line",
    (tester) async {
      final server = cardServer(
        linked: [
          {
            ...conversationFixture('review', 'Review: Avatars'),
            'number': 13,
            'reviewOf': 'work',
            'agentIds': ['ivy'],
            'assignment': {
              'id': 'r',
              'agentId': 'ivy',
              'status': 'done',
              'result': 'Ready: no — revision 050bab807. Two findings.',
            },
          },
        ],
      );
      final facts = SuperTabPullRequestFacts(null);
      addTearDown(facts.dispose);
      await show(tester, server, facts, 'message-1');
      expect(find.text('#13 Review: Avatars: done'), findsOneWidget);
      expect(find.textContaining('050bab807'), findsNothing);
    },
  );

  testWidgets('rebuilding a card often never stops its refresh', (
    tester,
  ) async {
    final reads = <List<String>>[];
    final facts = reading(
      () => [found(pr, passed: 3, pending: 9)],
      onRead: reads.add,
    );
    addTearDown(facts.dispose);
    final c = await show(tester, cardServer(), facts, 'message-2');
    final group = c.snapshot!.conversation('work')!;
    for (var i = 0; i < 7; i++) {
      await tester.pump(const Duration(seconds: 10));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabLiveCard(
              group: group,
              card: group.cards.of('message-2')!,
              controller: c,
              facts: facts,
            ),
          ),
        ),
      );
    }
    expect(reads, hasLength(2));
  });

  testWidgets('the conversation draws a card message as one card', (
    tester,
  ) async {
    final c = await showView(tester, cardServer());
    await c.select('work');
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabLiveCard), findsNWidgets(2));
    expect(find.text('CI is running on $pr'), findsOneWidget);
    // The read mark it just made is saved a moment later.
    await tester.pump(const Duration(milliseconds: 250));
  });
}
