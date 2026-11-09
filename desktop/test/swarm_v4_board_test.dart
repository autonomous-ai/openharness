import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/task_board.dart';

import 'support/capture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// A project's tasks, its GitHub issues, as a person with a busy repository sees them: 154 open issues (lampOS had 144 on
/// 2026-11-09), at the window the app opens in, and every way `gh` can answer.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  /// What `gh api graphql` answers for [total] open issues of lampOS, 100 to a page, as GitHub's does, newest activity first.
  /// Issue number 6000 + n is for `builder:pip` when n is a multiple of 3, taken (`status:taken`) when n leaves 1 over 3, and
  /// nobody's otherwise. [hold] keeps every page after the first back until it completes; [fail] says how `gh` fails.
  SwarmGitHub board({
    int total = 154,
    Completer<void>? hold,
    ({int code, String said})? Function()? fail,
  }) => SwarmGitHub(
    timeout: const Duration(seconds: 5),
    run: (arguments) async {
      if (fail?.call() case final failure?) {
        return ProcessResult(1, failure.code, '', failure.said);
      }
      final query = arguments
          .firstWhere((a) => a.startsWith('query='), orElse: () => '')
          .substring(6);
      // The taken ones (n leaves 1 over 3) each have their builder's open pull request: green and waiting for a reader, the
      // seventh in conflict.
      if (query.contains('pullRequests(')) {
        return ProcessResult(
          1,
          0,
          jsonEncode({
            'data': {
              'repository': {
                'defaultBranchRef': {'name': 'main'},
                'pullRequests': {
                  'nodes': [
                    for (var n = 1; n <= total; n += 3)
                      {
                        'number': 7000 + n,
                        'title': 'Fix task $n',
                        'url':
                            'https://github.com/autonomous-ai/lampOS/pull/${7000 + n}',
                        'isDraft': false,
                        'headRefName': 'pip/${6000 + n}',
                        'headRefOid': '${'a' * 39}$n'.substring(0, 40),
                        'baseRefName': 'main',
                        'body': 'Closes #${6000 + n}',
                        'mergeable': n == 7 ? 'CONFLICTING' : 'MERGEABLE',
                        'labels': {
                          'nodes': [
                            {'name': 'builder:pip'},
                          ],
                        },
                        'closingIssuesReferences': {
                          'nodes': [
                            {'number': 6000 + n},
                          ],
                        },
                        'commits': {
                          'nodes': [
                            {
                              'commit': {
                                'statusCheckRollup': {'state': 'SUCCESS'},
                              },
                            },
                          ],
                        },
                        'comments': {'nodes': <Object?>[]},
                      },
                  ],
                },
              },
            },
          }),
          '',
        );
      }
      if (!query.contains('issues(first:')) {
        return ProcessResult(
          3,
          1,
          '',
          'GraphQL: Could not resolve to an Issue with the number of 0.',
        );
      }
      final after = arguments
          .where((a) => a.startsWith('after='))
          .firstOrNull
          ?.substring(6);
      final first = int.parse(
        arguments.firstWhere((a) => a.startsWith('first=')).substring(6),
      );
      final start = after == null ? 0 : int.parse(after);
      if (start > 0) await hold?.future;
      final end = (start + first).clamp(0, total);
      return ProcessResult(
        1,
        0,
        jsonEncode({
          'data': {
            'repository': {
              'issues': {
                'pageInfo': {'hasNextPage': end < total, 'endCursor': '$end'},
                'nodes': [
                  for (var n = start + 1; n <= end; n++)
                    {
                      'number': 6000 + n,
                      'title': 'Task number $n of the busy project',
                      'url':
                          'https://github.com/autonomous-ai/lampOS/issues/${6000 + n}',
                      'createdAt': '2026-11-09T01:00:00Z',
                      'updatedAt': DateTime.utc(
                        2026,
                        11,
                        9,
                        12,
                      ).subtract(Duration(minutes: n)).toIso8601String(),
                      'author': {'login': 'deehw'},
                      'comments': {'totalCount': n % 7},
                      'labels': {
                        'nodes': [
                          if (n % 3 == 0)
                            {'name': 'builder:pip', 'color': '1d76db'},
                          if (n % 3 == 1)
                            {'name': 'status:taken', 'color': 'fbca04'},
                          {'name': 'part:voice', 'color': '0e8a16'},
                        ],
                      },
                    },
                ],
              },
            },
          },
        }),
        '',
      );
    },
  );

  Future<void> openBoard(
    WidgetTester tester,
    SwarmGitHub github, {
    Size size = const Size(1440, 860),
  }) async {
    await openSwarmV4(tester, swarmV4Channel(), github: github, size: size);
    await tester.tap(key('swarm-tasks-button'));
    await tester.pumpAndSettle();
  }

  /// The count a column's head shows beside its name.
  String count(WidgetTester tester, String column) => tester
      .widget<Text>(
        find
            .descendant(
              of: key('swarm-task-column-$column'),
              matching: find.byType(Text),
            )
            .at(1),
      )
      .data!;

  testWidgets(
    '154 issues: the first hundred show while the rest are read, then every column is whole',
    (tester) async {
      final hold = Completer<void>();
      await openBoard(tester, board(hold: hold));
      // The first hundred, newest first, are on the board while the page after them is on its way.
      expect(
        [
          for (final c in ['To do', 'Assigned', 'On it']) count(tester, c),
        ],
        ['33', '33', '34'],
      );
      expect(key('swarm-task-6001'), findsOneWidget);
      hold.complete();
      await tester.pumpAndSettle();
      expect(
        [
          for (final c in ['To do', 'Assigned', 'On it']) count(tester, c),
        ],
        ['51', '51', '52'],
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final size in const [Size(1440, 860), Size(1280, 800)]) {
    testWidgets(
      'the three columns are all in sight beside the channel at ${size.width.toInt()}x${size.height.toInt()}',
      (tester) async {
        await openBoard(tester, board(), size: size);
        final pane = tester.getRect(find.byType(SwarmTaskBoard));
        for (final column in ['To do', 'Assigned', 'On it']) {
          final at = tester.getRect(key('swarm-task-column-$column'));
          expect(
            at.right,
            lessThanOrEqualTo(pane.right),
            reason: 'the $column column ends inside the board',
          );
        }
        await captureWindow(tester, shots, 'board-${size.width.toInt()}');
      },
    );
  }

  /// Whether the text in [finder] is cut to fit, an ellipsis where its end was.
  bool cut(WidgetTester tester, Finder finder) => tester
      .renderObject<RenderParagraph>(
        // The last: a chip draws its icon as text first.
        find.descendant(of: finder, matching: find.byType(RichText)).last,
      )
      .didExceedMaxLines;

  for (final size in const [Size(1440, 860), Size(1280, 800)]) {
    testWidgets(
      'a card\'s pull request reads whole beside or under its task\'s number at ${size.width.toInt()}x${size.height.toInt()}',
      (tester) async {
        await openBoard(tester, board(), size: size);
        for (final (task, pull) in const [(6001, 7001), (6007, 7007)]) {
          expect(key('swarm-pull-$pull'), findsOneWidget);
          // Whole, but for a long word in the narrowest column, which shortens ("#7007 Confl…"), never its number.
          if (size.width > 1280 || pull == 7001) {
            expect(
              cut(tester, key('swarm-pull-$pull')),
              isFalse,
              reason: '#$pull is whole',
            );
          } else {
            expect(
              tester.getSize(key('swarm-pull-$pull')).width,
              greaterThan(80),
              reason: '#$pull has the room of its own line',
            );
          }
          final card = tester.getRect(key('swarm-task-$task'));
          expect(
            card.contains(tester.getTopRight(key('swarm-pull-$pull'))),
            isTrue,
            reason: '#$pull stays inside its card',
          );
        }
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'board-pulls-${size.width.toInt()}');
      },
    );
  }

  testWidgets(
    'a rate limit beside cards already read says to wait in full, at 1280x800',
    (tester) async {
      var limited = false;
      await openBoard(
        tester,
        board(
          fail: () => limited
              ? (
                  code: 1,
                  said: 'gh: API rate limit exceeded for user ID 12345. (HTTP 403)',
                )
              : null,
        ),
        size: const Size(1280, 800),
      );
      limited = true;
      await tester.tap(key('swarm-tasks-close'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-tasks-button'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-tasks-stale')).data,
        SwarmGitHub.limitedWords,
      );
      expect(cut(tester, key('swarm-tasks-stale')), isFalse);
      await captureWindow(tester, shots, 'board-limited-1280');
    },
  );

  testWidgets('a card far down a column opens its task', (tester) async {
    await openBoard(tester, board());
    // Card 6154 is the oldest, last in On it: scroll its column to it.
    await tester.dragUntilVisible(
      key('swarm-task-6154'),
      find.descendant(
        of: key('swarm-task-column-On it'),
        matching: find.byType(Scrollable),
      ),
      const Offset(0, -400),
    );
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-task-6154'));
    await tester.pumpAndSettle();
    expect(key('swarm-issue-panel'), findsOneWidget);
  });

  testWidgets(
    'GitHub says too many requests: the board says to wait and offers Try again',
    (tester) async {
      await openBoard(
        tester,
        board(
          fail: () => (
            code: 1,
            said: 'gh: API rate limit exceeded for user ID 12345. (HTTP 403)',
          ),
        ),
      );
      expect(
        tester.widget<Text>(key('swarm-tasks-error')).data,
        SwarmGitHub.limitedWords,
      );
      expect(key('swarm-tasks-retry'), findsOneWidget);
      expect(key('swarm-task-board'), findsNothing);
    },
  );

  testWidgets(
    'a read that fails while the cards show says so beside them, and Try again reads again',
    (tester) async {
      var failing = false;
      await openBoard(
        tester,
        board(
          fail: () =>
              failing ? (code: 1, said: 'gh: Server Error (HTTP 502)') : null,
        ),
      );
      expect(key('swarm-task-board'), findsOneWidget);
      failing = true;
      await tester.tap(key('swarm-tasks-close'));
      await tester.pumpAndSettle();
      // Open again, the cards read before show at once, and the failed read is said beside them.
      await tester.tap(key('swarm-tasks-button'));
      await tester.pumpAndSettle();
      expect(key('swarm-task-board'), findsOneWidget);
      expect(key('swarm-tasks-stale'), findsOneWidget);
      failing = false;
      await tester.tap(key('swarm-tasks-retry'));
      await tester.pumpAndSettle();
      expect(key('swarm-tasks-stale'), findsNothing);
      expect(key('swarm-task-board'), findsOneWidget);
    },
  );

  testWidgets('no open issue: three empty columns and no card', (tester) async {
    await openBoard(tester, board(total: 0));
    expect(
      [
        for (final c in ['To do', 'Assigned', 'On it']) count(tester, c),
      ],
      ['0', '0', '0'],
    );
    expect(key('swarm-task-6001'), findsNothing);
    await captureWindow(tester, shots, 'board-empty');
  });
}
