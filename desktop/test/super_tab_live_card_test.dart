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

/// A workgroup with a builder, a reviewer whose verdict is in the chat, and the
/// two cards the backend names: its brief is the task card, its first link of
/// [pr] the PR card.
ConversationServer cardServer({int? mergedAt}) {
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
      {'id': 'a', 'description': 'Tests pass', 'evidence': 'ok'},
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
  return {'rows': answer()};
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

  testWidgets('a PR card shows its title, state, checks and the verdict', (
    tester,
  ) async {
    final facts = reading(() => [found(pr)]);
    addTearDown(facts.dispose);
    await show(tester, cardServer(), facts, 'message-2');
    expect(find.text('Round avatars'), findsOneWidget);
    expect(find.text('app · PR #7'), findsOneWidget);
    expect(find.text('Open'), findsOneWidget);
    expect(find.text('12 checks passed'), findsOneWidget);
    expect(
      find.text('Reviewer: Ivy · Ready: yes on 1a2b3c4d5'),
      findsOneWidget,
    );
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
    await show(tester, cardServer(), facts, 'message-1');
    expect(find.text('#12 Avatars'), findsOneWidget);
    expect(find.text('Working'), findsOneWidget);
    expect(find.text('1 of 2 checks passed'), findsOneWidget);
    expect(find.text('Round avatars'), findsOneWidget);
    expect(
      find.text('Reviewer: Ivy · Ready: yes on 1a2b3c4d5'),
      findsOneWidget,
    );
  });

  testWidgets('the card updates in place as the PR changes, then stops', (
    tester,
  ) async {
    var answer = found(pr, passed: 3, pending: 9);
    final reads = <List<String>>[];
    final facts = reading(() => [answer], onRead: reads.add);
    addTearDown(facts.dispose);
    await show(tester, cardServer(), facts, 'message-2');
    expect(find.text('3 of 12 checks done'), findsOneWidget);
    answer = found(pr, state: 'Merged');
    await tester.pump(SuperTabPullRequestFacts.every);
    await tester.pump();
    expect(find.text('Merged'), findsOneWidget);
    expect(find.text('3 of 12 checks done'), findsNothing);
    await tester.pump(SuperTabPullRequestFacts.every * 3);
    expect(reads, hasLength(2));
  });

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
