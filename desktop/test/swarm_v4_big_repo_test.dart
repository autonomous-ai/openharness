import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/swarm_v4_data.dart';

/// The Tasks board on a project whose repository is a team's busy one, made up here: 154 open issues, 78 of them `status:taken`,
/// 66 for a builder and not yet taken, 10 nobody's (a queue, a handoff, proposals), one for two builders, and none with a
/// priority label. A team's first morning in a Swarm is a list like this, so the board has to hold it.
List<Map<String, Object?>> bigRepoIssues() {
  const builders = [
    'first',
    'second',
    'fourth',
    'fifth',
    'sixth',
    'seventh',
    'el',
    'nine',
    'ten',
    'twelve',
    'thirteen',
    'fourteen',
    'mobile',
    'jarvis',
    'friday',
    'heron',
    'tests',
    'tiers',
    'bench',
    'blue',
    'finn',
    'sub',
    'pipeline',
    'hw-first',
  ];
  final rows = <List<String>>[
    // The two this test reads by name sit on top, as the most recently touched: a two-builder task, and one for an agent
    // whose name has two words (Product Manager's `builder:<name>` makes `first-builder` of "First builder").
    ['builder:fourteen', 'builder:backend2'],
    ['builder:first-builder'],
    for (var i = 0; i < 64; i++) ['builder:${builders[i % builders.length]}'],
    for (var i = 0; i < 78; i++)
      ['status:taken', 'builder:${builders[i % builders.length]}'],
    for (var i = 0; i < 8; i++) ['queue'],
    ['proposal'],
    ['proposal'],
  ];
  assert(rows.length == 154);
  return [
    for (final (i, labels) in rows.indexed)
      {
        'number': 5900 - i,
        'title': 'Task ${5900 - i}',
        'url': 'https://github.com/example-org/shop/issues/${5900 - i}',
        'createdAt': '2026-11-01T01:00:00Z',
        // Newest activity first, a minute apart.
        'updatedAt': DateTime.utc(
          2026,
          11,
          9,
          8,
        ).subtract(Duration(minutes: i)).toIso8601String(),
        'author': {'login': 'deehw'},
        'labels': {
          'nodes': [
            for (final name in labels) {'name': name, 'color': '1d76db'},
          ],
        },
        'comments': {'totalCount': i % 7},
      },
  ];
}

/// `gh api graphql` as GitHub answers it for those issues, one page of the `first` asked at a time, after the cursor given.
SwarmGitHub bigRepoGitHub(List<List<String>> calls) {
  final all = bigRepoIssues();
  return SwarmGitHub(
    run: (arguments) async {
      calls.add(arguments);
      final query = arguments
          .firstWhere((a) => a.startsWith('query='), orElse: () => '')
          .substring(6);
      // The board also reads the open pull requests of its tasks: none here.
      if (query.contains('pullRequests(')) {
        return ProcessResult(
          1,
          0,
          jsonEncode({
            'data': {
              'repository': {
                'defaultBranchRef': {'name': 'main'},
                'pullRequests': {'nodes': <Object?>[]},
              },
            },
          }),
          '',
        );
      }
      if (!query.contains('issues(first:')) {
        return ProcessResult(1, 1, '', 'GraphQL: not in this fixture.');
      }
      String? value(String name) => arguments
          .where((a) => a.startsWith('$name='))
          .map((a) => a.substring(name.length + 1))
          .firstOrNull;
      final first = int.parse(value('first')!);
      final from = int.tryParse(value('after') ?? '0')!;
      final to = (from + first).clamp(0, all.length);
      return ProcessResult(
        1,
        0,
        jsonEncode({
          'data': {
            'repository': {
              'issues': {
                'pageInfo': {
                  'hasNextPage': to < all.length,
                  'endCursor': '$to',
                },
                'nodes': all.sublist(from, to),
              },
            },
          },
        }),
        '',
      );
    },
  );
}

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<List<List<String>>> showBoard(WidgetTester tester) async {
    final calls = <List<String>>[];
    await tester.binding.setSurfaceSize(const Size(2000, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // Its agents include "first builder" (two words) and `fourteen`, as a person names them in the New agent form.
    final c = swarmV4Server().controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
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
            github: bigRepoGitHub(calls),
            board: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-tasks-button'));
    await tester.pumpAndSettle();
    return calls;
  }

  testWidgets(
    'the board of a repository with 154 open issues is read in two pages and sorts them into To do 10, Assigned 66 and On it 78',
    (tester) async {
      final calls = await showBoard(tester);
      expect(key('swarm-task-board'), findsOneWidget);
      // 100 a page: a second read follows the first's cursor.
      final pages = [
        for (final c in calls)
          if (c.any((a) => a.contains('issues(first:'))) c,
      ];
      expect(pages, hasLength(2));
      expect(pages[0], isNot(contains(startsWith('after='))));
      expect(pages[1], contains('after=100'));
      Finder count(String column, String n) => find.descendant(
        of: key('swarm-task-column-$column'),
        matching: find.text(n),
      );
      expect(count('To do', '10'), findsOneWidget);
      expect(count('Assigned', '66'), findsOneWidget);
      expect(count('On it', '78'), findsOneWidget);
    },
  );

  testWidgets(
    'a task for two builders shows both labels, and its face is the first builder\'s',
    (tester) async {
      await showBoard(tester);
      final card = key('swarm-task-5900');
      expect(card, findsOneWidget);
      expect(
        find.descendant(
          of: card,
          matching: key('swarm-label-builder:fourteen'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: card,
          matching: key('swarm-label-builder:backend2'),
        ),
        findsOneWidget,
      );
      // `fourteen` is an agent of this Swarm: its own face, not one drawn from the label.
      final faces = find.descendant(
        of: card,
        matching: find.byType(SuperTabAvatar),
      );
      expect(faces, findsOneWidget);
      expect(tester.widget<SuperTabAvatar>(faces).identity, 'agent:fourteen');
    },
  );

  testWidgets(
    'a task labelled as the PM labels it for "First builder" wears that agent\'s face',
    (tester) async {
      await showBoard(tester);
      // The label of an agent's tasks is its name in lower case with a hyphen between words (cli superTabs/githubMentions.ts
      // builderLabel), so "First builder" is `builder:first-builder`.
      final card = key('swarm-task-5899');
      expect(
        find.descendant(
          of: card,
          matching: key('swarm-label-builder:first-builder'),
        ),
        findsOneWidget,
      );
      final faces = find.descendant(
        of: card,
        matching: find.byType(SuperTabAvatar),
      );
      expect(faces, findsOneWidget);
      expect(
        tester.widget<SuperTabAvatar>(faces).identity,
        'agent:first builder',
      );
    },
  );
}
