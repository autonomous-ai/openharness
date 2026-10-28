import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/pull_request_entry.dart';
import 'package:harness/super_tabs/pull_requests.dart';

import 'support/super_tab_fixture.dart';

String prUrl(int number) => 'https://github.com/o/r/pull/$number';
Map<String, dynamic> prRow(
  int number, [
  Map<String, dynamic> values = const {},
]) => {
  'url': prUrl(number),
  'title': 'Pull request $number',
  'status': 'found',
  'state': 'Open',
  'updatedAt': '2026-10-22T07:00:00Z',
  'mergedAt': '2026-10-22T07:00:00Z',
  'closedAt': '2026-10-22T07:00:00Z',
  'mergeStateStatus': 'CLEAN',
  'reviewDecision': 'APPROVED',
  'autoMerge': false,
  'checks': {'passed': 14, 'failed': 0, 'pending': 0, 'total': 14},
  'additions': 32,
  'deletions': 6,
  ...values,
};
List<Map<String, dynamic>> allPrStates() => [
  prRow(1, {
    'checks': {'passed': 12, 'failed': 2, 'pending': 0, 'total': 14},
  }),
  prRow(2, {'mergeStateStatus': 'DIRTY'}),
  prRow(3, {'reviewDecision': 'CHANGES_REQUESTED'}),
  prRow(4, {'mergeStateStatus': 'BEHIND'}),
  prRow(5),
  prRow(6, {
    'autoMerge': true,
    'checks': {'passed': 9, 'failed': 0, 'pending': 5, 'total': 14},
  }),
  prRow(7, {'reviewDecision': 'REVIEW_REQUIRED'}),
  prRow(8, {
    'checks': {'passed': 6, 'failed': 0, 'pending': 8, 'total': 14},
  }),
  prRow(9, {
    'state': 'Draft',
    'checks': {'passed': 0, 'failed': 0, 'pending': 0, 'total': 0},
  }),
  for (var n = 10; n < 16; n++)
    prRow(n, {'state': 'Merged', 'mergedAt': '2026-10-22T0${16 - n}:00:00Z'}),
  prRow(16, {'state': 'Closed'}),
  {'url': prUrl(17), 'status': 'no_access'},
];
ConversationServer prServer(Iterable<int> numbers) {
  final server = ConversationServer();
  server.state['projects'] = [projectFixture('lead', 'Lamp OS', 'lead')];
  for (final group in server.state['conversations'] as List) {
    group['projectId'] = 'lead';
  }
  for (final number in numbers) {
    server.append(prUrl(number));
  }
  return server;
}

void main() {
  final now = DateTime.utc(2026, 10, 22, 8);
  Future<SuperTabController> mount(
    WidgetTester tester,
    ConversationServer server,
    Future<Map<String, dynamic>> Function(List<String>) read, {
    bool visible = true,
    DateTime Function()? clock,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1100, 1500));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabPullRequests(
            controller: c,
            read: read,
            visible: visible,
            now: clock ?? () => now,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  test('every GitHub input maps to the approved label and section, without inventing readiness', () {
    final rows = allPrStates()
        .map(SuperTabPullRequestEntry.fromJson)
        .cast<SuperTabPullRequestEntry>()
        .toList();
    expect(rows.map((e) => e.kind), [
      PullRequestKind.failed,
      PullRequestKind.conflicts,
      PullRequestKind.changes,
      PullRequestKind.behind,
      PullRequestKind.ready,
      PullRequestKind.autoMerge,
      PullRequestKind.review,
      PullRequestKind.running,
      PullRequestKind.draft,
      ...List.filled(6, PullRequestKind.merged),
      PullRequestKind.closed,
      PullRequestKind.unknown,
    ]);
    expect(rows[0].label, '2 of 14 checks failed');
    expect(rows[7].label, 'Checks running · 6 of 14 done');
    expect(rows[8].checksLabel, 'No checks yet');
    expect(rows.last.label, contains("Can't read status"));
    expect(
      SuperTabPullRequestEntry.fromJson(
        prRow(1, {'mergeStateStatus': 'BLOCKED'}),
      )!.kind,
      PullRequestKind.open,
    );
    expect(
      SuperTabPullRequestEntry.fromJson(prRow(1, {'checks': {}}))!.kind,
      PullRequestKind.open,
    );
    expect(
      SuperTabPullRequestEntry.fromJson({'url': 'https://evil.com/o/r/pull/1'}),
      isNull,
    );
    expect(
      SuperTabPullRequestEntry.fromJson({'url': prUrl(1), 'status': 'found'})!
          .kind,
      PullRequestKind.unknown,
    );
  });
  testWidgets(
    'all states have two-line rows in the approved order, five merged, closed collapsed',
    (tester) async {
      final rows = allPrStates();
      await mount(
        tester,
        prServer(
          rows.map((r) => int.parse((r['url'] as String).split('/').last)),
        ),
        (_) async => {'rows': rows.reversed.toList()},
      );
      for (final text in [
        'Needs you 4',
        'Open 5',
        'Merged 6',
        'Closed 1',
        'Status unknown 1',
        'Show 1 more',
        '2 of 14 checks failed',
        'Conflicts with main',
        'Changes requested',
        'Behind main',
        'Ready to merge',
        'Merges when checks pass',
        'Waiting for review',
        'Checks running · 6 of 14 done',
        'Draft',
        '+32 −6',
        'in Lead',
      ]) {
        expect(find.text(text), findsWidgets, reason: text);
      }
      final ordered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
      for (var i = 1; i < ordered.length; i++) {
        expect(
          tester.getTopLeft(find.text('#${ordered[i - 1]}')).dy,
          lessThan(tester.getTopLeft(find.text('#${ordered[i]}')).dy),
        );
      }
      expect(find.text('#15'), findsNothing);
      expect(find.text('#16'), findsNothing);
      expect(find.text('View status on GitHub'), findsNothing);
      expect(find.text('Open on GitHub'), findsNothing);
      await tester.tap(find.text('Show 1 more'));
      await tester.pumpAndSettle();
      expect(find.text('#15'), findsOneWidget);
      await tester.tap(find.text('Closed 1'));
      await tester.pumpAndSettle();
      expect(find.text('#16'), findsOneWidget);
      expect(find.text('Not merged'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'whole row opens the linked PR, including a merged PR whose agent stopped',
    (tester) async {
      final opened = <Uri>[], old = browserOpener;
      browserOpener = (url) async {
        opened.add(url);
        return true;
      };
      addTearDown(() => browserOpener = old);
      await mount(
        tester,
        prServer([1494]),
        (_) async => {
          'rows': [
            prRow(1494, {'state': 'Merged', 'title': 'Merged with no agent'}),
          ],
        },
      );
      expect(find.text('Nothing needs you.'), findsOneWidget);
      await tester.tap(find.text('Merged with no agent'));
      expect(opened.single.toString(), prUrl(1494));
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets('first load immediately lists links while GitHub is pending', (
    tester,
  ) async {
    final pending = Completer<Map<String, dynamic>>();
    await mount(tester, prServer([1, 2]), (_) => pending.future);
    expect(find.text('#1'), findsOneWidget);
    expect(find.text('#2'), findsOneWidget);
    expect(find.text('Checking GitHub…'), findsNWidgets(2));
    expect(find.text('Linked in this project 2'), findsOneWidget);
    pending.complete({
      'rows': [prRow(1), prRow(2)],
    });
    await tester.pumpAndSettle();
    expect(find.text('Pull request 1'), findsOneWidget);
  });
  testWidgets(
    'stored links merge with loaded messages without duplicate PR rows',
    (tester) async {
      final server = prServer([52, 51]);
      (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((group) => group['id'] == 'lead')['pullRequestUrls'] = [
        prUrl(51),
        prUrl(53),
      ];
      final asked = <List<String>>[];
      await mount(tester, server, (urls) async {
        asked.add(urls);
        return {
          'rows': [prRow(51), prRow(52), prRow(53)],
        };
      });
      expect(asked.single.toSet(), {prUrl(51), prUrl(52), prUrl(53)});
      expect(asked.single, hasLength(3));
      for (final number in [51, 52, 53]) {
        expect(find.text('Pull request $number'), findsOneWidget);
      }
      expect(find.text('· 3'), findsOneWidget);
    },
  );
  testWidgets(
    'older snapshots without stored links still use loaded messages',
    (tester) async {
      final asked = <List<String>>[];
      await mount(tester, prServer([54]), (urls) async {
        asked.add(urls);
        return {
          'rows': [prRow(54)],
        };
      });
      expect(asked.single, [prUrl(54)]);
      expect(find.text('Pull request 54'), findsOneWidget);
    },
  );
  testWidgets('timeout keeps the last answer and says how old it is', (
    tester,
  ) async {
    var reads = 0;
    var time = now;
    await mount(
      tester,
      prServer([1]),
      (_) async => ++reads == 1
          ? {
              'rows': [prRow(1)],
            }
          : {'error': 'TIMEOUT'},
      clock: () => time,
    );
    time = time.add(const Duration(minutes: 6));
    await tester.pump(const Duration(seconds: 60));
    await tester.pumpAndSettle();
    expect(find.text('Pull request 1'), findsOneWidget);
    expect(
      find.textContaining(
        "GitHub didn't answer. Showing what it said 6 min ago",
      ),
      findsOneWidget,
    );
    expect(find.text('· Checked 6 min ago'), findsOneWidget);
  });
  for (final code in ['GH_MISSING', 'GH_SIGNED_OUT']) {
    testWidgets('$code shows one fix banner and keeps links as unknown', (
      tester,
    ) async {
      await mount(tester, prServer([1, 2]), (_) async => {'error': code});
      expect(find.textContaining('gh auth login'), findsOneWidget);
      expect(find.text('Status unknown 2'), findsOneWidget);
      expect(find.text('Status unknown'), findsNWidgets(2));
      expect(find.text('#1'), findsOneWidget);
      expect(find.text('· Not checked'), findsOneWidget);
    });
  }
  testWidgets('an inaccessible PR is unknown without a machine banner', (
    tester,
  ) async {
    await mount(
      tester,
      prServer([1, 2]),
      (_) async => {
        'rows': [
          prRow(1),
          {'url': prUrl(2), 'status': 'no_access'},
        ],
      },
    );
    expect(find.text('Status unknown 1'), findsOneWidget);
    expect(find.textContaining("Can't read status:"), findsOneWidget);
    expect(find.textContaining('Trying again'), findsNothing);
  });
  testWidgets(
    'empty project uses the approved explanation and makes no GitHub call',
    (tester) async {
      var reads = 0;
      await mount(tester, prServer([]), (_) async {
        reads++;
        return {'rows': []};
      });
      expect(reads, 0);
      expect(find.text('No pull requests yet'), findsOneWidget);
      expect(
        find.text(
          'A GitHub pull request link posted in any chat of this project shows up here with its status.',
        ),
        findsOneWidget,
      );
    },
  );
  for (final code in [
    'UNSUPPORTED',
    'E2EE_REQUIRED',
    'OWNER_REQUIRED',
    'LOCAL_GITHUB_UNAVAILABLE',
  ]) {
    testWidgets(
      '$code falls back immediately instead of claiming GitHub did not answer',
      (tester) async {
        await mount(tester, prServer([1]), (_) async => {'error': code});
        expect(find.textContaining('View status on GitHub'), findsOneWidget);
        expect(find.textContaining("GitHub didn't answer"), findsNothing);
        expect(find.textContaining('Trying again'), findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
  testWidgets('local GitHub unavailable is retried', (tester) async {
    var reads = 0;
    await mount(tester, prServer([1]), (_) async {
      reads++;
      return reads == 1
          ? {'error': 'LOCAL_GITHUB_UNAVAILABLE'}
          : {
              'rows': [prRow(1)],
            };
    });
    expect(find.textContaining('View status on GitHub'), findsOneWidget);
    // This computer connects; the next minute's refresh asks GitHub again.
    await tester.pump(const Duration(seconds: 60));
    await tester.pumpAndSettle();
    expect(reads, 2);
    expect(find.text('Pull request 1'), findsOneWidget);
    expect(find.textContaining('View status on GitHub'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('a computer that cannot read PR status is not asked again', (
    tester,
  ) async {
    var reads = 0;
    await mount(tester, prServer([1]), (_) async {
      reads++;
      return {'error': 'UNSUPPORTED'};
    });
    await tester.pump(const Duration(seconds: 60));
    await tester.pumpAndSettle();
    expect(reads, 1);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'refreshes only open PRs every minute and stops when the pane is hidden',
    (tester) async {
      final asks = <List<String>>[];
      final c = await mount(tester, prServer([1, 2]), (urls) async {
        asks.add(urls);
        return {
          'rows': [
            for (final url in urls)
              prRow(url == prUrl(1) ? 1 : 2, {
                'state': url == prUrl(1) ? 'Merged' : 'Open',
              }),
          ],
        };
      });
      expect(asks, [
        [prUrl(1), prUrl(2)],
      ]);
      await tester.pump(const Duration(seconds: 59));
      expect(asks.length, 1);
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpAndSettle();
      expect(asks.last, [prUrl(2)]);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabPullRequests(
              controller: c,
              visible: false,
              read: (urls) async {
                asks.add(urls);
                return {'rows': []};
              },
            ),
          ),
        ),
      );
      final before = asks.length;
      await tester.pump(const Duration(minutes: 2));
      expect(asks.length, before);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'group/project scope and newly posted links update without a selection change',
    (tester) async {
      final server = prServer([1]);
      server.append(prUrl(2), conversationId: 'offline');
      final asks = <List<String>>[];
      final c = server.controller();
      await c.refresh();
      c.select('offline');
      await c.loadMessages('offline');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabPullRequests(
              controller: c,
              read: (urls) async {
                asks.add(urls);
                return {
                  'rows': urls
                      .map((url) => prRow(int.parse(url.split('/').last)))
                      .toList(),
                };
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(asks.last, [prUrl(2)]);
      expect(find.text('#1'), findsNothing);
      await tester.tap(find.text('This group'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('This project').last);
      await tester.pumpAndSettle();
      expect(asks.last.toSet(), {prUrl(1), prUrl(2)});
      expect(c.selectedId, 'offline');
      server.append(prUrl(3), conversationId: 'offline');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(asks.last, contains(prUrl(3)));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );
}
