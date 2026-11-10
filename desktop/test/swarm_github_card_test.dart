import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_row.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/swarm_v4_data.dart';

/// What GitHub said to a person's agent, in their chat with it (Swarm v4, anh Dee 2026-11-09), clicked through as a person
/// does: GitHub's words are a card on the left, not the person's bubble; Read shows them all and the way to GitHub.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  /// The person's chat with their agent `second`, with what their Harness relayed from GitHub (backend githubRelay.ts).
  Future<SuperTabController> show(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarmV4Server();
    void relay(String text, Map<String, dynamic> source) {
      server.append(text, conversationId: 'agent-chat-second');
      server.messages.last
        ..['author'] = {'kind': 'person', 'id': 'owner', 'name': 'Dee'}
        ..['source'] = {'kind': 'github', 'repository': 'autonomous-ai/lampOS', 'login': 'deehw', 'association': 'MEMBER', ...source};
    }
    relay('On GitHub, deehw wrote on pull request autonomous-ai/lampOS#3879:\nfirst builder, 14:20, to **second**: HOLD d0bf35bb2\n'
        'The wake word misses at 2 m: add the far-field test.\nhttps://github.com/autonomous-ai/lampOS/pull/3879#issuecomment-1', {
      'event': 'comment', 'on': 'pull', 'number': 3879, 'url': 'https://github.com/autonomous-ai/lampOS/pull/3879#issuecomment-1' });
    relay('New task for you on GitHub: issue autonomous-ai/lampOS#5810 Voice: answer within a second\n'
        'https://github.com/autonomous-ai/lampOS/issues/5810', {
      'event': 'task', 'on': 'issue', 'number': 5810, 'url': 'https://github.com/autonomous-ai/lampOS/issues/5810' });
    final c = server.controller(account: 'owner', initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'agent-chat-second'});
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(body: SuperTabView(controller: c, onAddAgent: (_) {}, onOpenTerminal: (_) {},
        machineName: (_) => 'Mac Studio', github: swarmV4GitHub())),
    ));
    await tester.pumpAndSettle();
    return c;
  }

  testWidgets('a GitHub comment to the agent is a card on the left, and Read shows all of it', (tester) async {
    await show(tester);
    expect(key('swarm-github-row'), findsNWidgets(2));
    expect(find.text('PR #3879 · deehw'), findsOneWidget);
    expect(find.text('first builder, 14:20, to second: HOLD d0bf35bb2'), findsOneWidget);
    expect(find.text('New task · #5810'), findsOneWidget);
    expect(find.text('Voice: answer within a second'), findsOneWidget);
    // Not the person's own words: no bubble of theirs carries it.
    final card = tester.getRect(find.text('PR #3879 · deehw'));
    expect(card.left, lessThan(1440 / 2));
    expect(find.textContaining('The wake word misses at 2 m'), findsNothing);
    await tester.tap(find.text('Read').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('The wake word misses at 2 m'), findsOneWidget);
    expect(key('swarm-github-open'), findsOneWidget);
  });

  testWidgets('Open in GitHub opens the comment itself', (tester) async {
    final opened = <String>[];
    final message = SuperTabMessage.fromJson({'id': 'm1', 'conversationId': 'agent-chat-second', 'sequence': 1,
      'text': 'On GitHub, kenmore commented on sandbox/quotes.py line 12 in pull request acme/app#4:\nOff by one here.\n'
          'https://github.com/acme/app/pull/4#discussion_r9',
      'author': {'kind': 'person', 'id': 'owner', 'name': 'Dee'}, 'createdAt': '2026-11-09T12:00:00Z',
      'source': {'kind': 'github', 'event': 'review-comment', 'on': 'pull', 'repository': 'acme/app', 'number': 4,
        'url': 'https://github.com/acme/app/pull/4#discussion_r9', 'login': 'kenmore', 'association': 'COLLABORATOR',
        'path': 'sandbox/quotes.py', 'line': 12}});
    await tester.pumpWidget(MaterialApp(theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(body: SuperTabGitHubRow(message: message, openUrl: opened.add))));
    expect(find.text('Line · PR #4 · kenmore'), findsOneWidget);
    expect(find.text('Off by one here.'), findsOneWidget);
    await tester.tap(find.text('Read'));
    await tester.pumpAndSettle();
    expect(find.text('sandbox/quotes.py, line 12'), findsOneWidget);
    await tester.tap(key('swarm-github-open'));
    expect(opened, ['https://github.com/acme/app/pull/4#discussion_r9']);
  });

  test('a review reads as its verdict', () {
    final row = SuperTabGitHubRow(message: SuperTabMessage.fromJson({'id': 'm2', 'conversationId': 'c', 'sequence': 2,
      'text': 'On GitHub, deehw reviewed pull request acme/app#4: Changes requested\nChanges requested.\nhttps://github.com/acme/app/pull/4#pullrequestreview-7',
      'author': {'kind': 'person', 'id': 'owner', 'name': 'Dee'},
      'source': {'kind': 'github', 'event': 'review', 'on': 'pull', 'number': 4, 'verdict': 'CHANGES_REQUESTED', 'login': 'deehw',
        'url': 'https://github.com/acme/app/pull/4#pullrequestreview-7'}}));
    expect(row.label, 'Review · PR #4 · deehw');
    expect(row.title, 'Changes requested');
    expect(SuperTabGitHubRow.shows(row.message), isTrue);
  });
}
