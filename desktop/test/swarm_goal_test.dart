import 'dart:convert';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/goal.dart';

import 'support/swarm_goal_gh.dart';

/// A project's goal as Desktop reads it with `gh` (Swarm plan, rule 1: "a goal that can be checked"): the score its bar shows
/// is the one the daemon tells the PM for the same repository (cli/src/superTabs/goal.ts), so each case here is one of
/// goal.spec.ts's, asked the way Desktop asks.
void main() {
  const file = '''
# Goal

| Milestone | Check |
|---|---|
| Settings sync offline | `npm test -- sync.offline` |
| The app starts in a second | `scripts/start-time --under 1000` |
| Every screen has a test | `make desktop-test` |
''';
  const sync = 'Settings sync offline';
  const start = 'The app starts in a second';
  const screens = 'Every screen has a test';
  final done = [
    goalRun(1, sync, 'SUCCESS'),
    goalRun(2, start, 'SUCCESS'),
    goalRun(3, screens, 'FAILURE'),
  ];
  final running = [
    goalRun(1, sync, 'SUCCESS'),
    goalRun(2, start, null, status: 'IN_PROGRESS'),
  ];

  /// What [t]'s goal reads as: how many pass, fail and are not run.
  Future<(int, int, int)?> score(FakeGoalGitHub t) async {
    final goal = await t.github.goal('acme/lampos');
    return goal == null ? null : (goal.passed, goal.failed, goal.notRun);
  }

  FakeGoalGitHub commits(List<List<Map<String, Object?>>> runs, {String? of}) =>
      FakeGoalGitHub(
        file: of ?? file,
        landings: [for (final each in runs) FakeLanding(each)],
      );

  // The same file the CLI's goal.spec.ts reads: the bar must list the milestones the daemon scores.
  test('reads every row of a goal file as the daemon does', () {
    final fixture = jsonDecode(
      File('../cli/src/superTabs/__fixtures__/goal-rows.json')
          .readAsStringSync(),
    ) as Map<String, dynamic>;
    final cases = fixture['cases'] as List;
    expect(cases, isNotEmpty);
    for (final each in cases) {
      expect(
        [
          for (final row in goalRows(each['text'] as String?))
            {'milestone': row.milestone, 'check': row.check},
        ],
        each['rows'],
        reason: each['name'] as String,
      );
    }
  });

  test('reads a file of one very long line at once: no row from a line too long to be one', () {
    final watch = Stopwatch()..start();
    expect(goalRows('| a${' ' * 400000}| x\n| Sync | `a` |'), [
      (milestone: 'Sync', check: 'a'),
    ]);
    expect(watch.elapsed, lessThan(const Duration(seconds: 1)));
  });

  test('a milestone passes when its check concluded success, fails when it concluded anything else, cancelled too, and is not run otherwise', () async {
    expect(
      await score(
        commits([
          [goalRun(1, sync, 'SUCCESS'), goalRun(2, start, 'FAILURE')],
        ]),
      ),
      (1, 1, 1),
    );
    const one = '| $sync | `a` |';
    for (final conclusion in [
      'FAILURE',
      'TIMED_OUT',
      'ACTION_REQUIRED',
      'STALE',
      'STARTUP_FAILURE',
      // GitHub ends a check that ran past its time limit as cancelled: a hang fails, it is not still to run.
      'CANCELLED',
      // Completed with no conclusion is not a success.
      null,
    ]) {
      expect(
        await score(
          commits([
            [goalRun(1, sync, conclusion)],
          ], of: one),
        ),
        (0, 1, 0),
        reason: '$conclusion',
      );
    }
    // Running, queued, skipped and neutral say nothing yet.
    for (final waiting in [
      goalRun(1, sync, null, status: 'IN_PROGRESS'),
      goalRun(1, sync, null, status: 'QUEUED'),
      goalRun(1, sync, 'SKIPPED'),
      goalRun(1, sync, 'NEUTRAL'),
    ]) {
      expect(
        await score(
          commits([
            [waiting],
          ], of: one),
        ),
        (0, 0, 1),
        reason: '$waiting',
      );
    }
  });

  test('a milestone is read by the newest run of its own check, and no other check as one', () async {
    expect(
      await score(
        commits([
          [
            goalRun(5, sync, 'FAILURE'),
            goalRun(9, sync, 'SUCCESS'),
            goalRun(7, sync, 'FAILURE'),
            // The project's own checks, a check of another milestone's name, and one that only starts like it.
            {
              'databaseId': 20,
              'name': 'ci/required',
              'status': 'COMPLETED',
              'conclusion': 'SUCCESS',
            },
            {
              'databaseId': 21,
              'name': screens,
              'status': 'COMPLETED',
              'conclusion': 'SUCCESS',
            },
            goalRun(22, '$screens and more', 'SUCCESS'),
            {
              'databaseId': 23,
              'name': 'Goal: $start',
              'status': 'COMPLETED',
              'conclusion': 'SUCCESS',
            },
          ],
        ]),
      ),
      (1, 0, 2),
    );
    // A run with no name is no milestone's; a named one with no id is read as the oldest of its name.
    expect(
      await score(
        commits([
          [
            {'status': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {
              'name': 'goal: $sync',
              'status': 'COMPLETED',
              'conclusion': 'FAILURE',
            },
            goalRun(4, sync, 'SUCCESS'),
          ],
        ], of: '| $sync | `a` |'),
      ),
      (1, 0, 0),
    );
  });

  test('each milestone carries its state and its check run\'s page, in the file\'s order; those that do not pass list fails first', () async {
    final goal = (await commits([
      [
        goalRun(1, sync, 'SUCCESS'),
        goalRun(3, screens, 'FAILURE'),
        // A page that is not GitHub's over https is no link.
        {...goalRun(2, start, null, status: 'QUEUED'), 'url': 'file:///x'},
      ],
    ]).github.goal('acme/lampos'))!;
    expect(
      [for (final m in goal.milestones) (m.name, m.state, m.url)],
      [
        (
          sync,
          SwarmMilestoneState.passes,
          'https://github.com/acme/lampos/runs/1',
        ),
        (start, SwarmMilestoneState.notRun, null),
        (
          screens,
          SwarmMilestoneState.fails,
          'https://github.com/acme/lampos/runs/3',
        ),
      ],
    );
    expect((goal.total, goal.branch), (3, 'main'));
    expect([for (final m in goal.notPassing) m.name], [screens, start]);
  });

  test('the goal is scored on the branch\'s tip when all its checks have ended, in one request', () async {
    final t = commits([
      done,
      [goalRun(9, sync, 'FAILURE')],
    ]);
    expect(await score(t), (2, 1, 0));
    expect(t.calls, hasLength(1));
    expect(
      t.calls.single,
      containsAll(['api', 'graphql', 'owner=acme', 'name=lampos']),
    );
  });

  // After each landing the tip has no run yet, and a tip pushed with [skip ci] never has one.
  test('else on the newest of the branch\'s last five landings whose checks have all ended', () async {
    expect(
      await score(
        commits([
          [],
          running,
          done,
          [goalRun(9, sync, 'FAILURE')],
        ]),
      ),
      (2, 1, 0),
    );
    // The sixth is not looked at.
    expect(await score(commits([[], [], [], [], [], done])), (0, 0, 3));
  });

  // A train that lands as a merge commit brings its members' commits with it: none was pushed to the branch, so none has
  // a check of it.
  test('the landings are the branch\'s first-parent line, not every commit a landing brought with it', () async {
    final t = FakeGoalGitHub(
      file: file,
      landings: [
        FakeLanding(running, parents: [7, 1]),
        for (var n = 0; n < 6; n++) const FakeLanding([], parents: [7]),
        FakeLanding(done),
        const FakeLanding([]),
      ],
    );
    expect(await score(t), (2, 1, 0));
  });

  // The daemon lists the branch's last hundred commits and follows the line among them: a landing older than those is not
  // one of its five, so it is none of Desktop's.
  test(
    'a landing behind the branch\'s last hundred commits is not followed',
    () async {
      final t = FakeGoalGitHub(
        file: file,
        landings: [
          FakeLanding(running, parents: [100]),
          for (var n = 0; n < 99; n++) const FakeLanding([], parents: [100]),
          FakeLanding(done),
        ],
      );
      expect(await score(t), (1, 0, 2));
    },
  );

  test('with none of the five ended, on the landing with the fewest not run, the newest of those', () async {
    final one = [goalRun(1, sync, 'SUCCESS')];
    expect(await score(commits([[], running, one, running, [], done])), (
      1,
      0,
      2,
    ));
    expect(
      await score(
        commits([
          [],
          one,
          [goalRun(1, sync, 'FAILURE')],
        ]),
      ),
      (1, 0, 2),
    );
    // After a milestone is added, every older landing lacks it: the one that lacks only that is the goal.
    expect(
      await score(
        commits([[], done], of: '$file| A new milestone | `make new` |\n'),
      ),
      (2, 1, 1),
    );
    // A branch with no commit GitHub tells of: nothing has run.
    expect(await score(commits([])), (0, 0, 3));
  });

  test('a commit\'s checks past the first hundred are read too, as far as three hundred, and only for a landing looked at', () async {
    Map<String, Object?> other(int id) => {
      'databaseId': id,
      'name': 'build $id',
      'status': 'COMPLETED',
      'conclusion': 'SUCCESS',
    };
    final late = [
      for (final run in done)
        {...run, 'databaseId': 900 + (run['databaseId']! as int)},
    ];
    final t = commits([
      [for (var n = 1; n <= 250; n++) other(n), ...late],
      // Its further pages are never asked for: the tip's checks have ended.
      [for (var n = 1; n <= 250; n++) other(n)],
    ]);
    expect(await score(t), (2, 1, 0));
    expect(t.calls, hasLength(3));
    expect(t.calls[1], containsAll(['oid=${FakeGoalGitHub.oid(0)}']));
    expect(
      [
        for (final call in t.calls.skip(1))
          call.firstWhere((a) => a.startsWith('after=')),
      ],
      ['after=100', 'after=200'],
    );
    final far = commits([
      [for (var n = 1; n <= 300; n++) other(n), ...done],
    ]);
    expect(await score(far), (0, 0, 3));
    expect(far.calls, hasLength(3));
  });

  test('a project with no goal file, or no row in it, has no goal', () async {
    for (final text in [null, '# Goal\n\nNot written yet.']) {
      final t = FakeGoalGitHub(file: text, landings: [FakeLanding(done)]);
      expect(await t.github.goal('acme/lampos'), isNull, reason: '$text');
      expect(t.calls, hasLength(1));
    }
    // A repository with no commit at all.
    expect(await FakeGoalGitHub().github.goal('acme/lampos'), isNull);
  });

  test('a read that fails says why in the board\'s words, and what GitHub sends in another shape reads as nothing run', () async {
    final t = commits([done])..failure = FakeGoalGitHub.signedOut;
    await expectLater(
      t.github.goal('acme/lampos'),
      throwsA(
        isA<SwarmGitHubError>().having(
          (e) => e.message,
          'message',
          'Sign in to GitHub: run gh auth login.',
        ),
      ),
    );
    t.failure = (1, 'GraphQL: Could not resolve to a Repository');
    await expectLater(
      t.github.goal('acme/lampos'),
      throwsA(
        isA<SwarmGitHubError>().having(
          (e) => e.message,
          'message',
          'You can\'t see acme/lampos on GitHub.',
        ),
      ),
    );
    ProcessResult ok(Object? data) =>
        ProcessResult(1, 0, jsonEncode({'data': data}), '');
    await expectLater(
      SwarmGitHub(run: (_) async => ok(null)).goal('acme/lampos'),
      throwsA(isA<SwarmGitHubError>()),
    );
    for (final branch in <Object?>[
      'main',
      {'name': 7, 'target': 'none'},
      {
        'target': {
          'oid': 5,
          'history': {'nodes': 'none'},
        },
      },
      {
        'name': 'main',
        'target': {
          'oid': FakeGoalGitHub.oid(0),
          'history': {
            'nodes': [
              {'oid': FakeGoalGitHub.oid(0)},
              7,
            ],
          },
          'statusCheckRollup': {
            'contexts': {
              'nodes': [
                7,
                {'name': 9, 'databaseId': 'x', 'status': 3},
              ],
            },
          },
          'parents': {
            'nodes': ['none'],
          },
        },
      },
    ]) {
      final goal = await SwarmGitHub(
        run: (_) async => ok({
          'repository': {
            'goal': {'text': file},
            'defaultBranchRef': branch,
          },
        }),
      ).goal('acme/lampos');
      expect(
        (goal!.passed, goal.failed, goal.notRun),
        (0, 0, 3),
        reason: '$branch',
      );
    }
  });

  test('the last goal read of a repository is kept with when it was read, a handful of them, and a failed read keeps it', () async {
    final t = commits([done]);
    expect(t.github.keptGoal('acme/lampos'), isNull);
    final at = DateTime.utc(2026, 11, 11, 9);
    await withClock(Clock.fixed(at), () => t.github.goal('acme/lampos'));
    final kept = t.github.keptGoal('acme/lampos')!;
    expect((kept.goal!.passed, kept.readAt), (2, at));
    t.failure = FakeGoalGitHub.signedOut;
    await expectLater(
      t.github.goal('acme/lampos'),
      throwsA(isA<SwarmGitHubError>()),
    );
    expect(t.github.keptGoal('acme/lampos'), kept);
    // A project with no goal is kept as having none, so it is not asked again at once.
    t
      ..failure = null
      ..file = null;
    for (var n = 0; n < SwarmGitHub.goalsKept; n++) {
      await t.github.goal('acme/other-$n');
    }
    expect(t.github.keptGoal('acme/other-0'), isNotNull);
    expect(t.github.keptGoal('acme/other-0')!.goal, isNull);
    expect(t.github.keptGoal('acme/lampos'), isNull);
  });
}
