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
    String? opener,
    Set<String>? team,
    String author = 'pip',
    Set<String> writers = const {},
  }) => SwarmPull.statusOf(
    draft: draft,
    head: head,
    author: author,
    writers: writers,
    body: body,
    comments: comments,
    checks: checks,
    mergeable: mergeable,
    intoDefault: intoDefault,
    opener: opener,
    team: team,
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

    // Every agent of a person posts as that person's GitHub login, the login that opened its pull request: from it, an
    // unsigned READ-OK may be the author's own (the merger's rule, cli githubMerge.ts, #3722).
    group('from the login that opened it', () {
      const team = {'pip', 'juno', 'kai'};
      test('an unsigned READ-OK is no read', () {
        expect(
          status(opener: 'deehw', comments: [said('READ-OK f6edb44')]),
          SwarmPullStatus.review,
        );
        expect(
          status(
            opener: 'DeeHW',
            team: team,
            comments: [said('**READ-OK f6edb44**')],
          ),
          SwarmPullStatus.review,
        );
      });

      test('a verdict\'s own words are no signature', () {
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [said('READ-OK f6edb44: looks good')],
          ),
          SwarmPullStatus.review,
        );
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [said('LGTM: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
      });

      test('signed by a teammate who is not its author, it counts', () {
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [said('Juno, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.merging,
        );
        // Its author's own signature never counts, nor a name that is no teammate's.
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [said('Pip, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [said('Stranger, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
      });

      test('an unsigned HOLD from it still holds', () {
        expect(
          status(opener: 'deehw', team: team, comments: [said('HOLD f6edb44')]),
          SwarmPullStatus.held,
        );
      });

      test('its writers are named as the merger names them: in any spelling, every builder label and the branch', () {
        // A two-word author signing its own.
        expect(
          status(
            opener: 'deehw',
            team: const {'pip-two', 'juno'},
            author: 'pip-two',
            comments: [said('Pip Two, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
        // A task taken over: Juno's label, Pip's branch; Pip is a writer too.
        expect(
          status(
            opener: 'deehw',
            team: team,
            author: 'juno',
            writers: SwarmPull.writersOf(const ['Builder:Juno'], 'pip/12'),
            comments: [said('Pip, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
        // A teammate who hyphenates their name is still a teammate.
        expect(
          status(
            opener: 'deehw',
            team: const {'juno-bee', 'pip'},
            comments: [said('Juno-Bee, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.merging,
        );
      });

      test('a later READ-OK from it lifts its own HOLD, but is no read', () {
        final hold = said('HOLD f6edb44', at: '2026-11-09T01:00:00Z');
        final ok = said('READ-OK f6edb44', at: '2026-11-09T02:00:00Z');
        expect(
          status(opener: 'deehw', team: team, comments: [hold, ok]),
          SwarmPullStatus.review,
        );
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [
              hold,
              ok,
              said('Juno, 10:00: READ-OK f6edb44', at: '2026-11-09T03:00:00Z'),
            ],
          ),
          SwarmPullStatus.merging,
        );
      });

      test('before the team is known, no signature from it counts', () {
        expect(
          status(
            opener: 'deehw',
            comments: [said('Juno, 10:00: READ-OK f6edb44')],
          ),
          SwarmPullStatus.review,
        );
      });

      test('another login\'s unsigned READ-OK counts as that person\'s', () {
        expect(
          status(
            opener: 'deehw',
            team: team,
            comments: [said('READ-OK f6edb44: looks good', login: '69tc')],
          ),
          SwarmPullStatus.merging,
        );
      });
    });

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

  // Harness's train (cli/src/superTabs/githubTrain.ts) carries pull requests that were already read, on a branch
  // `harness-train/<time>`: nobody reads the train itself, and no agent wrote it.
  group('a train, the pull request that carries read ones together', () {
    Map<Object?, Object?> train(String checks) => {
      'number': 5773,
      'title': 'Train: #5770',
      'url': 'https://github.com/autonomous-ai/lampOS/pull/5773',
      'isDraft': false,
      'headRefName': 'harness-train/1794363575848',
      'headRefOid': head,
      'baseRefName': 'main',
      'body': "Harness's train into main, built to $head.",
      'mergeable': 'MERGEABLE',
      'commits': {
        'nodes': [
          {
            'commit': {
              'statusCheckRollup': {'state': checks},
            },
          },
        ],
      },
      'comments': {'nodes': <Object?>[]},
    };
    test('is no agent\'s, and is read: it waits for nobody', () {
      final pull = SwarmPull.read(train('SUCCESS'), defaultBranch: 'main')!;
      expect(pull.author, isNull);
      expect(pull.readOk, isTrue);
      expect(pull.status, SwarmPullStatus.merging);
    });
    test('says its checks are running, or failed, as any other', () {
      expect(
        SwarmPull.read(train('PENDING'), defaultBranch: 'main')!.status,
        SwarmPullStatus.checks,
      );
      expect(
        SwarmPull.read(train('FAILURE'), defaultBranch: 'main')!.status,
        SwarmPullStatus.failing,
      );
    });
    // Review of #3959: anyone can push a branch under the train's prefix. One that is not titled as Harness titles a
    // train is a builder's pull request, and still one to read.
    test('a pull request on such a branch that is not titled a train is its builder\'s', () {
      final pull = SwarmPull.read({
        ...train('SUCCESS'),
        'title': 'Add the day count',
        'headRefName': 'harness-train/14',
        'labels': {
          'nodes': [
            {'name': 'builder:pip'},
          ],
        },
      }, defaultBranch: 'main')!;
      expect(pull.author, 'pip');
      expect(pull.readOk, isFalse);
      expect(pull.status, SwarmPullStatus.review);
    });
    test('a branch that only begins like a train\'s is its builder\'s', () {
      final pull = SwarmPull.read({
        ...train('SUCCESS'),
        'headRefName': 'harness-trains/12',
      }, defaultBranch: 'main')!;
      expect(pull.author, 'harness-trains');
      expect(pull.readOk, isFalse);
    });
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

    testWidgets(
      'opened by deehw: its own unsigned READ-OK leaves it in Review, a teammate\'s signed one merges it',
      (tester) async {
        Map<String, Object?> read(String body) => {
          ...pullNode(),
          'author': {'login': 'deehw'},
          'commits': {
            'nodes': [
              {
                'commit': {
                  'statusCheckRollup': {'state': 'SUCCESS'},
                },
              },
            ],
          },
          'comments': {
            'nodes': [said(body)],
          },
        };
        await panel(tester, github([read('READ-OK f6edb44')]));
        expect(find.text('#5770 Review'), findsOneWidget);
        // A panel opened afresh.
        await tester.pumpWidget(const SizedBox());
        // Seventh is an agent of lampOS's project in this Swarm, and is not its builder.
        await panel(tester, github([read('Seventh, 10:00: READ-OK f6edb44')]));
        expect(find.text('#5770 Merging'), findsOneWidget);
      },
    );

    testWidgets('a task with no open pull request shows no row', (
      tester,
    ) async {
      await panel(tester, github(const []));
      expect(find.text('Score both rows again.'), findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-issue-pull')), findsNothing);
    });
  });
}
