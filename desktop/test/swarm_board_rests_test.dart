import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/issue_panel.dart';
import 'package:harness/super_tabs/task_board.dart';
import 'package:harness/super_tabs/visible_tick.dart';

import 'support/swarm_v4_data.dart';

/// A project's board and an open task read GitHub again on a clock while they show (Swarm v4). While the app is hidden
/// (minimized, or covered by another app's window) or their page is not the one showing, nothing is read: each read spends
/// the person's GitHub rate limit and this Mac's time. Back in sight, they read at once when their minute has passed.
void main() {
  /// GitHub as `gh` answers, counting each call.
  (SwarmGitHub, List<String>) counted() {
    final calls = <String>[];
    final github = SwarmGitHub(
      run: (arguments) async {
        final query = arguments.firstWhere((a) => a.startsWith('query='));
        calls.add(query.contains('pullRequests(') ? 'pulls' : 'read');
        return ProcessResult(
          1,
          0,
          jsonEncode({
            'data': {
              'repository': {
                'defaultBranchRef': {'name': 'main'},
                'pullRequests': {'nodes': <Object?>[]},
                'issues': {
                  'pageInfo': {'hasNextPage': false, 'endCursor': null},
                  'nodes': <Object?>[],
                },
                'issue': {
                  'number': 5759,
                  'title': 'A task',
                  'url': 'https://github.com/autonomous-ai/lampOS/issues/5759',
                  'labels': {'nodes': <Object?>[]},
                  'body': '',
                  'state': 'OPEN',
                  'comments': {
                    'totalCount': 0,
                    'pageInfo': {'hasPreviousPage': false},
                    'nodes': <Object?>[],
                  },
                },
              },
            },
          }),
          '',
        );
      },
    );
    return (github, calls);
  }

  Future<void> show(WidgetTester tester, Widget child) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(body: child),
      ),
    );
    await tester.pump();
  }

  const every = Duration(minutes: 1);

  /// The board or the open task on a one-minute clock, and the count of its reads.
  Future<(Widget, int Function())> mount(
    WidgetTester tester,
    String kind,
  ) async {
    addTearDown(
      () => tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      ),
    );
    final c = swarmV4Server().controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final (github, calls) = counted();
    final widget = kind == 'board'
        ? SwarmTaskBoard(
            controller: c,
            conversationId: 'lead',
            github: github,
            refreshEvery: every,
            onOpen: (_, _) {},
            onClose: () {},
          )
        : SwarmIssuePanel(
            controller: c,
            github: github,
            repository: 'autonomous-ai/lampOS',
            number: 5759,
            refreshEvery: every,
            onClose: () {},
          );
    return (widget, () => calls.where((c) => c == 'read').length);
  }

  void hide(WidgetTester tester) {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  }

  void back(WidgetTester tester) {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  }

  for (final kind in ['board', 'task']) {
    testWidgets(
      'the $kind reads nothing while the app is hidden, and reads at once when it is back',
      (tester) async {
        final (widget, reads) = await mount(tester, kind);
        await show(tester, widget);
        final first = reads();
        expect(first, greaterThan(0));
        await tester.pump(every);
        await tester.pump();
        expect(reads(), first + 1);

        hide(tester);
        await tester.pump(every * 5);
        await tester.pump();
        expect(reads(), first + 1, reason: 'nothing read while hidden');

        back(tester);
        await tester.pump();
        expect(reads(), first + 2, reason: 'read at once when back');
        await tester.pump(every);
        await tester.pump();
        expect(reads(), first + 3, reason: 'and on its clock again');
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('the $kind back in sight within its minute reads nothing new', (
      tester,
    ) async {
      final (widget, reads) = await mount(tester, kind);
      await show(tester, widget);
      final first = reads();
      // A glance at another app and back, many times: the clock's minute holds.
      for (var i = 0; i < 5; i++) {
        hide(tester);
        await tester.pump(const Duration(seconds: 5));
        back(tester);
        await tester.pump();
      }
      expect(reads(), first);
      await tester.pump(every);
      await tester.pump();
      expect(reads(), first + 1, reason: 'the clock reads on time');
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'the $kind on a page not showing reads nothing until it shows',
      (tester) async {
        final (widget, reads) = await mount(tester, kind);
        Future<void> page(int index) => show(
          tester,
          SuperTabPages(index: index, children: [widget, const SizedBox()]),
        );
        await page(0);
        final first = reads();
        await page(1);
        await tester.pump(every * 5);
        await tester.pump();
        expect(reads(), first, reason: 'nothing read while another page shows');
        await page(0);
        expect(reads(), first + 1, reason: 'read at once when it shows');
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
