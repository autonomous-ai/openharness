import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/github_pulls.dart';
import 'package:harness/super_tabs/issue_panel.dart';

import 'support/swarm_v4_data.dart';

/// Where a task's pull request stands on its card (Swarm v4, anh Dee 2026-11-09): the rule Harness merges by
/// (cli/src/superTabs/githubMerge.ts), read from GitHub as the board reads it.
void main() {
  const head = 'f6edb44a1b2c3d4e5f60718293a4b5c6d7e8f901';
  Map<Object?, Object?> said(
    String body, {
    String at = '2026-11-09T02:00:00Z',
    String association = 'MEMBER',
    String login = 'deehw',
  }) => {
    'body': body,
    'createdAt': at,
    'authorAssociation': association,
    'author': {'login': login},
  };
  SwarmPullStatus status({
    bool draft = false,
    String body = '',
    List<Map<Object?, Object?>> comments = const [],
    String? checks = 'SUCCESS',
    String? mergeable = 'MERGEABLE',
    bool intoDefault = true,
  }) => SwarmPull.statusOf(
    draft: draft,
    head: head,
    author: 'pip',
    body: body,
    comments: comments,
    checks: checks,
    mergeable: mergeable,
    intoDefault: intoDefault,
  );

  group('where a pull request stands, by the rule Harness merges by', () {
    test('a draft is still being built', () {
      expect(
        status(draft: true, comments: [said('Juno, 10:00: READ-OK f6edb44')]),
        SwarmPullStatus.draft,
      );
    });

    test('a READ-OK on its head from someone else, checks green: merging', () {
      expect(
        status(comments: [said('Juno, 10:00, to **Pip**: READ-OK f6edb44')]),
        SwarmPullStatus.merging,
      );
      // Unsigned, the reader is its GitHub login.
      expect(
        status(comments: [said('READ-OK f6edb44')]),
        SwarmPullStatus.merging,
      );
    });

    test(
      'a READ-OK by its author, on an older head, or by a stranger is no read',
      () {
        expect(
          status(comments: [said('Pip, 10:00: READ-OK f6edb44')]),
          SwarmPullStatus.review,
        );
        expect(
          status(comments: [said('Juno, 10:00: READ-OK 1234567')]),
          SwarmPullStatus.review,
        );
        expect(
          status(
            comments: [said('Juno: READ-OK f6edb44', association: 'NONE')],
          ),
          SwarmPullStatus.review,
        );
        expect(
          status(comments: [said('Harness, 10:00: READ-OK f6edb44')]),
          SwarmPullStatus.review,
        );
      },
    );

    test('TWO READS, in its text or a comment, needs two readers', () {
      final one = [said('Juno, 10:00: READ-OK f6edb44')];
      expect(
        status(body: 'Risky. TWO READS', comments: one),
        SwarmPullStatus.review,
      );
      expect(
        status(comments: [said('Pip, 09:00: TWO READS please'), ...one]),
        SwarmPullStatus.review,
      );
      expect(
        status(
          body: 'TWO READS',
          comments: [...one, said('Atlas, 10:05: READ-OK f6edb44a')],
        ),
        SwarmPullStatus.merging,
      );
    });

    test(
      'a HOLD stands over everything until that reader\'s later READ-OK',
      () {
        expect(
          status(
            comments: [
              said('Juno, 10:00: HOLD f6edb44', at: '2026-11-09T03:00:00Z'),
              said('Atlas, 10:05: READ-OK f6edb44', at: '2026-11-09T03:05:00Z'),
            ],
          ),
          SwarmPullStatus.held,
        );
        expect(
          status(
            comments: [
              said('Juno, 10:00: HOLD 1234567', at: '2026-11-09T03:00:00Z'),
              said('Juno, 11:00: READ-OK f6edb44', at: '2026-11-09T04:00:00Z'),
            ],
          ),
          SwarmPullStatus.merging,
        );
      },
    );

    test('what its builder must fix comes before any read: a conflict, a failed check', () {
      final read = [said('Juno, 10:00: READ-OK f6edb44')];
      expect(
        status(mergeable: 'CONFLICTING', comments: read),
        SwarmPullStatus.conflict,
      );
      expect(
        status(checks: 'FAILURE', comments: read),
        SwarmPullStatus.failing,
      );
      expect(status(checks: 'ERROR'), SwarmPullStatus.failing);
      expect(status(checks: 'PENDING', comments: read), SwarmPullStatus.checks);
      // No checks at all pass, as the merger counts them.
      expect(status(checks: null, comments: read), SwarmPullStatus.merging);
    });

    test(
      'one into another branch than the default is never merged by rule',
      () {
        expect(
          status(
            intoDefault: false,
            comments: [said('Juno, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
      },
    );
  });

  group('which task a pull request is for', () {
    SwarmPull pull({List<int> closes = const [], String branch = 'pip/14'}) =>
        SwarmPull(
          number: 21,
          title: 'Count the days',
          url: 'https://github.com/acme/app/pull/21',
          branch: branch,
          status: SwarmPullStatus.review,
          closes: closes,
        );

    test('the issues it closes, else the one its branch is named for', () {
      expect(pull(closes: [14, 15]).tasks, [14, 15]);
      expect(pull().tasks, [14]);
      expect(pull(branch: 'pip/fix-the-count').tasks, isEmpty);
      expect(pull(branch: 'main').tasks, isEmpty);
    });

    test('its author is its builder label, else its branch\'s first part', () {
      expect(SwarmPull.authorOf(['part:api', 'builder:Pip'], 'x/1'), 'pip');
      expect(SwarmPull.authorOf(const [], 'Juno/14'), 'juno');
      expect(SwarmPull.authorOf(const [], 'main'), isNull);
    });
  });

  group('the panel of a task with a pull request', () {
    Map<String, Object?> pullNode() => {
      'number': 5770,
      'title': 'Score the update rows again',
      'url': 'https://github.com/autonomous-ai/lampOS/pull/5770',
      'isDraft': false,
      'headRefName': 'first-builder/5759',
      'headRefOid': head,
      'baseRefName': 'main',
      'body': 'Closes #5759',
      'mergeable': 'MERGEABLE',
      'labels': {'nodes': <Object?>[]},
      'closingIssuesReferences': {
        'nodes': [
          {'number': 5759},
        ],
      },
      'commits': {
        'nodes': [
          {
            'commit': {
              'statusCheckRollup': {'state': 'FAILURE'},
            },
          },
        ],
      },
      'comments': {'nodes': <Object?>[]},
    };

    /// GitHub as `gh` answers the panel: issue 5759's thread, and [pulls] as the repository's open pull requests.
    SwarmGitHub github(List<Map<String, Object?>> pulls) => SwarmGitHub(
      run: (arguments) async {
        final query = arguments.firstWhere((a) => a.startsWith('query='));
        final data = query.contains('pullRequests(')
            ? {
                'repository': {
                  'defaultBranchRef': {'name': 'main'},
                  'pullRequests': {'nodes': pulls},
                },
              }
            : {
                'repository': {
                  'issue': {
                    'number': 5759,
                    'title': 'The two update rows were scored down',
                    'url':
                        'https://github.com/autonomous-ai/lampOS/issues/5759',
                    'createdAt': '2026-11-09T01:00:00Z',
                    'updatedAt': '2026-11-09T07:20:06Z',
                    'labels': {'nodes': <Object?>[]},
                    'author': {'login': '69tc'},
                    'body': 'Score both rows again.',
                    'state': 'OPEN',
                    'comments': {
                      'totalCount': 0,
                      'pageInfo': {'hasPreviousPage': false},
                      'nodes': <Object?>[],
                    },
                  },
                },
              };
        return ProcessResult(1, 0, jsonEncode({'data': data}), '');
      },
    );

    Future<void> panel(
      WidgetTester tester,
      SwarmGitHub github, {
      void Function(String)? openUrl,
    }) async {
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
            body: SwarmIssuePanel(
              controller: c,
              github: github,
              repository: 'autonomous-ai/lampOS',
              number: 5759,
              refreshEvery: null,
              onClose: () {},
              openUrl: openUrl ?? (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('shows where it stands under the title, and Open goes to it', (
      tester,
    ) async {
      final opened = <String>[];
      await panel(tester, github([pullNode()]), openUrl: opened.add);
      final row = find.byKey(const ValueKey('swarm-issue-pull'));
      expect(row, findsOneWidget);
      expect(
        find.descendant(of: row, matching: find.text('#5770 Failing')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: row,
          matching: find.text(
            'Score the update rows again · first-builder/5759',
          ),
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('swarm-issue-pull-open')));
      expect(opened, ['https://github.com/autonomous-ai/lampOS/pull/5770']);
    });

    testWidgets('a task with no open pull request shows no row', (
      tester,
    ) async {
      await panel(tester, github(const []));
      expect(find.text('Score both rows again.'), findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-issue-pull')), findsNothing);
    });
  });
}
