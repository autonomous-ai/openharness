import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/agent_instructions.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/issue_panel.dart';
import 'package:harness/super_tabs/task_board.dart';

import 'support/swarm_v4_data.dart';

/// The Tasks board and an open issue read again while they show (Swarm v4, 2026-11-09): what a read that is slow, partial or
/// failed leaves on screen, and how the comments of one read join those of the last.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  ProcessResult json(Object? data) =>
      ProcessResult(1, 0, jsonEncode({'data': data}), '');

  Map<String, Object?> issueNode(int n, {int comments = 0}) => {
    'number': n,
    'title': 'Issue $n',
    'url': 'https://github.com/autonomous-ai/lampOS/issues/$n',
    'createdAt': '2026-11-09T01:00:00Z',
    'updatedAt': '2026-11-09T0$n:00:00Z',
    'author': {'login': 'deehw'},
    'labels': {'nodes': <Object?>[]},
    'comments': {'totalCount': comments},
  };

  ProcessResult issuesPage(List<int> numbers, {String? next}) => json({
    'repository': {
      'issues': {
        'pageInfo': {'hasNextPage': next != null, 'endCursor': next},
        'nodes': [for (final n in numbers) issueNode(n)],
      },
    },
  });

  /// Whether `gh` was asked for the issues list (not a thread the board reads ahead).
  bool listing(List<String> arguments) => arguments.contains('first=100');

  Map<String, Object?> commentNode(int n) => {
    'body': 'comment $n',
    'createdAt': '2026-11-09T02:${'$n'.padLeft(2, '0')}:00Z',
    'url': 'https://github.com/autonomous-ai/lampOS/issues/7#c$n',
    'author': {'login': 'deehw'},
  };

  Map<String, Object?> commentsOf(
    List<int> numbers, {
    int? total,
    String? before,
  }) => {
    'totalCount': ?total,
    'pageInfo': {'hasPreviousPage': before != null, 'startCursor': before},
    'nodes': [for (final n in numbers) commentNode(n)],
  };

  ProcessResult thread(
    List<int> numbers, {
    required int total,
    String? before,
  }) => json({
    'repository': {
      'issue': {
        ...issueNode(7, comments: total),
        'body': 'The task.',
        'state': 'OPEN',
        'comments': commentsOf(numbers, total: total, before: before),
      },
    },
  });

  Future<SuperTabController> controller(WidgetTester tester) async {
    final c = swarmV4Server().controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    return c;
  }

  /// Lets what `gh` answered reach the screen. Not pumpAndSettle: the board's refresh timer is always pending.
  Future<void> flush(WidgetTester tester, [Duration by = Duration.zero]) async {
    await tester.pump(by);
    for (var i = 0; i < 4; i++) {
      await tester.pump();
    }
  }

  Future<void> show(WidgetTester tester, Widget Function() pane) async {
    await tester.binding.setSurfaceSize(const Size(1000, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(body: pane()),
      ),
    );
    await flush(tester);
  }

  Future<void> board(WidgetTester tester, SwarmGitHub github) async {
    final c = await controller(tester);
    await show(
      tester,
      () => SwarmTaskBoard(
        controller: c,
        conversationId: 'lead',
        github: github,
        onOpen: (_, _) {},
        onClose: () {},
        refreshEvery: const Duration(seconds: 30),
      ),
    );
  }

  testWidgets('a refresh keeps every card while its pages are read', (
    tester,
  ) async {
    final secondPage = Completer<ProcessResult>();
    var lists = 0;
    final github = SwarmGitHub(
      timeout: const Duration(minutes: 10),
      run: (arguments) {
        if (arguments.contains('after=p2')) return secondPage.future;
        if (!listing(arguments)) return Future.value(json(null));
        lists++;
        return Future.value(
          lists == 1 ? issuesPage([3, 2, 1]) : issuesPage([3], next: 'p2'),
        );
      },
    );
    await board(tester, github);
    for (final n in [1, 2, 3]) {
      expect(key('swarm-task-$n'), findsOneWidget);
    }
    // The refresh's first page arrives, the rest not yet: the board is still the whole list, not that page.
    await flush(tester, const Duration(seconds: 30));
    expect(lists, 2);
    for (final n in [1, 2, 3]) {
      expect(key('swarm-task-$n'), findsOneWidget);
    }
    secondPage.complete(issuesPage([2, 1]));
    await flush(tester);
    for (final n in [1, 2, 3]) {
      expect(key('swarm-task-$n'), findsOneWidget);
    }
  });

  testWidgets(
    'a refresh that fails says so beside the cards, which stay, and Try again reads again',
    (tester) async {
      var lists = 0;
      final github = SwarmGitHub(
        run: (arguments) async {
          if (!listing(arguments)) return json(null);
          lists++;
          return lists == 2
              ? ProcessResult(1, 1, '', 'boom')
              : issuesPage([2, 1]);
        },
      );
      await board(tester, github);
      expect(key('swarm-tasks-stale'), findsNothing);
      await flush(tester, const Duration(seconds: 30));
      expect(
        tester.widget<Text>(key('swarm-tasks-stale')).data,
        'GitHub didn\'t answer. Try again.',
      );
      for (final n in [1, 2]) {
        expect(key('swarm-task-$n'), findsOneWidget);
      }
      await tester.tap(key('swarm-tasks-retry'));
      await flush(tester);
      expect(lists, 3);
      expect(key('swarm-tasks-stale'), findsNothing);
      expect(key('swarm-task-1'), findsOneWidget);
    },
  );

  testWidgets('a refresh that comes while a read is still going waits', (
    tester,
  ) async {
    final slow = Completer<ProcessResult>();
    var lists = 0;
    final github = SwarmGitHub(
      timeout: const Duration(minutes: 10),
      run: (arguments) {
        if (!listing(arguments)) return Future.value(json(null));
        lists++;
        return lists == 1 ? slow.future : Future.value(issuesPage([1]));
      },
    );
    await board(tester, github);
    expect(lists, 1);
    // Three refreshes come, the first read still going: none starts another.
    await flush(tester, const Duration(seconds: 90));
    expect(lists, 1);
    slow.complete(issuesPage([1]));
    await flush(tester);
    await flush(tester, const Duration(seconds: 30));
    expect(lists, 2);
  });

  Future<List<List<String>>> panel(
    WidgetTester tester,
    List<ProcessResult> threads, {
    DateTime? now,
  }) async {
    final calls = <List<String>>[];
    var reads = 0;
    final github = SwarmGitHub(
      timeout: const Duration(minutes: 10),
      run: (arguments) async {
        calls.add(arguments);
        if (arguments.any((a) => a.startsWith('before='))) {
          return json({
            'repository': {
              'issue': {
                'comments': commentsOf([1, 2, 3]),
              },
            },
          });
        }
        final read = reads++;
        return threads[read.clamp(0, threads.length - 1)];
      },
    );
    final c = await controller(tester);
    await show(
      tester,
      () => SwarmIssuePanel(
        controller: c,
        github: github,
        repository: 'autonomous-ai/lampOS',
        number: 7,
        onClose: () {},
        refreshEvery: const Duration(seconds: 30),
        now: () => now ?? DateTime.utc(2026, 11, 9, 3),
      ),
    );
    return calls;
  }

  testWidgets(
    'comments that came since the last read join the newest ones, with no gap hidden',
    (tester) async {
      // The thread had comments 8 to 10 of 10 and now has 11 to 13 of 13: a window past them, which they no longer join.
      final calls = await panel(tester, [
        thread([8, 9, 10], total: 10, before: 'b8'),
        thread([11, 12, 13], total: 13, before: 'b11'),
      ]);
      expect(find.textContaining('comment 8'), findsOneWidget);
      expect(find.text('7 earlier comments'), findsOneWidget);
      await flush(tester, const Duration(seconds: 30));
      expect(find.textContaining('comment 11'), findsOneWidget);
      expect(find.textContaining('comment 13'), findsOneWidget);
      expect(find.textContaining('comment 8'), findsNothing);
      // What Show reads is what is missing before the window, not before the first read.
      expect(find.text('10 earlier comments'), findsOneWidget);
      await tester.tap(key('swarm-issue-show-earlier'));
      await flush(tester);
      expect(calls.last, contains('before=b11'));
    },
  );

  testWidgets(
    'a new read whose window starts among the held comments keeps the earlier ones, in order',
    (tester) async {
      final calls = await panel(tester, [
        thread([8, 9, 10], total: 10, before: 'b8'),
        thread([9, 10, 11], total: 11, before: 'b9'),
      ]);
      await flush(tester, const Duration(seconds: 30));
      final bodies = [
        for (final n in [8, 9, 10, 11])
          tester.getTopLeft(find.textContaining('comment $n')).dy,
      ];
      expect(bodies, orderedEquals([...bodies]..sort()));
      expect(find.text('7 earlier comments'), findsOneWidget);
      await tester.tap(key('swarm-issue-show-earlier'));
      await flush(tester);
      expect(calls.last, contains('before=b8'));
    },
  );

  testWidgets('an issue says when it was opened: now, or how long ago', (
    tester,
  ) async {
    await panel(tester, [
      thread([1], total: 1),
    ], now: DateTime.utc(2026, 11, 9, 1, 0, 20));
    expect(find.textContaining('opened now'), findsOneWidget);
    expect(find.textContaining('now ago'), findsNothing);
    await panel(tester, [
      thread([1], total: 1),
    ], now: DateTime.utc(2026, 11, 9, 1, 5));
    expect(find.textContaining('opened 5m ago'), findsOneWidget);
  });

  test('an agent\'s name that is a path names no file in its folder', () {
    expect(
      SwarmAgentInstructions.fileIn('/work/lampOS', 'Faye'),
      '/work/lampOS/agents/Faye.md',
    );
    expect(
      SwarmAgentInstructions.fileIn('/work/lampOS', 'first builder'),
      '/work/lampOS/agents/first builder.md',
    );
    expect(SwarmAgentInstructions.fileIn('/work/lampOS', '../../x'), isNull);
    expect(SwarmAgentInstructions.fileIn('/work/lampOS', 'a/b'), isNull);
    expect(SwarmAgentInstructions.fileIn('/work/lampOS', r'a\b'), isNull);
  });
}
