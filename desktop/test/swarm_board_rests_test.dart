import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/issue_panel.dart';
import 'package:harness/super_tabs/task_board.dart';

import 'support/swarm_v4_data.dart';

/// A project's board and an open task read GitHub again on a clock while they show (Swarm v4). While the app is hidden
/// (minimized, or another app's window in front of it) nothing is read: each read spends the person's GitHub rate limit and
/// this Mac's time. Back in sight, they read at once and go on.
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

  for (final kind in ['board', 'task']) {
    testWidgets(
      'the $kind reads nothing while the app is hidden, and reads at once when it is back',
      (tester) async {
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
        const every = Duration(minutes: 1);
        await show(
          tester,
          kind == 'board'
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
                ),
        );
        int reads() => calls.where((c) => c == 'read').length;
        final first = reads();
        expect(first, greaterThan(0));
        await tester.pump(every);
        await tester.pump();
        expect(reads(), first + 1);

        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        await tester.pump(every * 5);
        await tester.pump();
        expect(reads(), first + 1, reason: 'nothing read while hidden');

        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        expect(reads(), first + 2, reason: 'read at once when back');
        await tester.pump(every);
        await tester.pump();
        expect(reads(), first + 3, reason: 'and on its clock again');
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
