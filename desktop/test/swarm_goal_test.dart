import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/goal.dart';

import 'support/swarm_goal_gh.dart';

/// A project's goal as Desktop reads it with `gh` (Swarm plan, rule 1: "a goal that can be checked"): the score its bar shows
/// is the one the daemon tells the PM for the same repository (cli/src/superTabs/goal.ts), read by the same REST calls, so
/// each case here is one of goal.spec.ts's, asked the way Desktop asks.
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
    goalRun(1, sync, 'success'),
    goalRun(2, start, 'success'),
    goalRun(3, screens, 'failure'),
  ];
  final running = [
    goalRun(1, sync, 'success'),
    goalRun(2, start, null, status: 'in_progress'),
  ];

  /// How many of [goal]'s milestones pass, fail and are not run.
  (int, int, int) counts(SwarmGoal goal) => (
    goal.passed,
    goal.milestones.where((m) => m.state == SwarmMilestoneState.fails).length,
    goal.notRun,
  );

  /// What [t]'s goal reads as.
  Future<(int, int, int)?> score(FakeGoalGitHub t) async {
    final goal = await t.github.goal('acme/lampos');
    return goal == null ? null : counts(goal);
  }

  FakeGoalGitHub commits(List<List<Map<String, Object?>>> runs, {String? of}) =>
      FakeGoalGitHub(
        file: of ?? file,
        landings: [for (final each in runs) FakeLanding(each)],
      );

  /// The calls of [t] for commits' check runs, each as the commit's place among the branch's and its page.
  List<(int, int)> checksAsked(FakeGoalGitHub t) => [
    for (final call in t.calls)
      if (RegExp(
            r'^/commits/([0-9a-f]{2})[0-9a-f]{38}/check-runs\?per_page=100(?:&page=(\d))?$',
          ).firstMatch(call)
          case final found?)
        (int.parse(found[1]!, radix: 16) - 1, int.parse(found[2] ?? '1')),
  ];

  /// A file as GitHub's contents API answers for it.
  Map<String, Object?> contents(String text) => {
    'content': base64.encode(utf8.encode(text)),
    'encoding': 'base64',
  };

  /// A `gh` that answers each place under the repository with what [body] makes of it: JSON, or its text as it stands.
  SwarmGitHub answering(Object? Function(String path) body) => SwarmGitHub(
    run: (arguments) async {
      final answer = body(arguments.last.replaceFirst('repos/acme/lampos', ''));
      return ProcessResult(
        1,
        0,
        answer is String ? answer : jsonEncode(answer),
        '',
      );
    },
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

  // As one pattern a row was read in time by the cube of its line's length: a 1,000-character line of a bar, spaces and a
  // letter took about 2 s in the built app, on the isolate that draws it, and a file of them minutes (review, 2026-11-11).
  // Read by plain searches from the row's end, as the daemon reads it since #4048, a megabyte of the worst lines is read at
  // once. Under the old reader this test ran out of its time: it is read a few lines at a time first, with the test's own
  // clock let in between, because a reader that never returns cannot be timed out.
  test('reads a megabyte of the slowest lines there are at once, and the row among them', () async {
    final slow = [
      '|${' ' * 998}a',
      '|${' ' * 500}|${' ' * 490}`a` x',
      '| a |${' ' * 990}`x',
      '|${' |' * 498} x',
    ];
    for (var n = 0; n < 275; n++) {
      expect(goalRows(slow.join('\n')), isEmpty);
      await Future<void>.delayed(Duration.zero);
    }
    final file = [
      for (var n = 0; n < 1100; n++) slow[n % slow.length],
      '| Sync | `a` |',
    ].join('\n');
    expect(file.length, greaterThan(1000000));
    expect(goalRows(file), [(milestone: 'Sync', check: 'a')]);
    // A line too long to be a row is not read at all.
    expect(goalRows('| a${' ' * 400000}| x\n| Sync | `a` |'), [
      (milestone: 'Sync', check: 'a'),
    ]);
  });

  test('a milestone passes when its check concluded success, fails when it concluded anything else, cancelled too, and is not run otherwise', () async {
    expect(
      await score(
        commits([
          [goalRun(1, sync, 'success'), goalRun(2, start, 'failure')],
        ]),
      ),
      (1, 1, 1),
    );
    const one = '| $sync | `a` |';
    for (final conclusion in [
      'failure',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
      // GitHub ends a check that ran past its time limit as cancelled: a hang fails, it is not still to run.
      'cancelled',
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
      goalRun(1, sync, null, status: 'in_progress'),
      goalRun(1, sync, null, status: 'queued'),
      goalRun(1, sync, 'skipped'),
      goalRun(1, sync, 'neutral'),
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
    Map<String, Object?> other(int id, String name) => {
      'id': id,
      'name': name,
      'status': 'completed',
      'conclusion': 'success',
    };
    expect(
      await score(
        commits([
          [
            goalRun(5, sync, 'failure'),
            goalRun(9, sync, 'success'),
            goalRun(7, sync, 'failure'),
            // The project's own checks, a check of another milestone's name, and one that only starts like it.
            other(20, 'ci/required'),
            other(21, screens),
            goalRun(22, '$screens and more', 'success'),
            other(23, 'Goal: $start'),
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
            {'status': 'completed', 'conclusion': 'success'},
            {
              'name': 'goal: $sync',
              'status': 'completed',
              'conclusion': 'failure',
            },
            goalRun(4, sync, 'success'),
          ],
        ], of: '| $sync | `a` |'),
      ),
      (1, 0, 0),
    );
  });

  test('each milestone carries its state and its check run\'s page, in the file\'s order; those that do not pass list fails first', () async {
    final goal = (await commits([
      [
        goalRun(1, sync, 'success'),
        goalRun(3, screens, 'failure'),
        goalRun(2, start, null, status: 'queued'),
      ],
    ]).github.goal('acme/lampos'))!;
    expect(
      [for (final m in goal.milestones) (m.name, m.state, m.url)],
      [
        (
          sync,
          SwarmMilestoneState.passes,
          'https://github.com/acme/lampos/actions/runs/7/job/1',
        ),
        (
          start,
          SwarmMilestoneState.notRun,
          'https://github.com/acme/lampos/actions/runs/7/job/2',
        ),
        (
          screens,
          SwarmMilestoneState.fails,
          'https://github.com/acme/lampos/actions/runs/7/job/3',
        ),
      ],
    );
    expect((goal.total, goal.branch), (3, 'main'));
    expect([for (final m in goal.notPassing) m.name], [screens, start]);
  });

  // `gh` hands over no control character as it is: it writes each in caret notation (U+0007 as `^G`), so that no answer
  // can drive a terminal. The daemon asks GitHub itself and reads a check's name as it is. Seen on a real repository
  // (2026-11-11): the milestone `A bell <U+0007> in a name` passed for the daemon and was not run for Desktop.
  test('a milestone with a control character in its name is matched to its check as gh hands the name over', () async {
    const bell = 'A bell \u0007 in a name';
    const others = 'Esc \u001B, a file separator \u001C and a next line \u0085';
    const rubout = 'A rubout \u007F stays';
    const goal = '| $bell | `a` |\n| $others | `b` |\n| $rubout | `c` |';
    Map<String, Object?> named(int id, String name) => {
      'id': id,
      'name': name,
      'status': 'completed',
      'conclusion': 'success',
    };
    // As gh writes the names.
    expect(
      await score(
        commits([
          [
            named(1, 'goal: A bell ^G in a name'),
            named(2, 'goal: Esc ^[, a file separator ^\\ and a next line ^E'),
            named(3, 'goal: $rubout'),
          ],
        ], of: goal),
      ),
      (3, 0, 0),
    );
    // As GitHub itself has them: a gh that rewrites nothing reads the same.
    expect(
      await score(
        commits([
          [goalRun(1, bell, 'success'), goalRun(2, others, 'success')],
        ], of: goal),
      ),
      (2, 0, 1),
    );
    // The newest run of a name is still told among both spellings.
    expect(
      await score(
        commits([
          [
            named(5, 'goal: A bell ^G in a name'),
            {...goalRun(9, bell, 'failure')},
          ],
        ], of: '| $bell | `a` |'),
      ),
      (0, 1, 0),
    );
  });

  // gh's second rewrite (review of the Desktop score, 2026-11-11, on gh 2.83.2): the text `\u00XX` naming such a character,
  // a backslash and u written out, comes over as `\^X`, as though the escape were the character. A terminal project may well
  // name a milestone so.
  test('a milestone that writes out such a character\'s escape is matched to its check as gh hands the name over', () async {
    const logs = r'Logs drop \u001b codes';
    const next = r'A next line \u0085 and \u001B';
    const kept = r'A tab \u0009, \u000b and \u007f stay';
    const goal = '| $logs | `a` |\n| $next | `b` |\n| $kept | `c` |';
    Map<String, Object?> named(int id, String name) => {
      'id': id,
      'name': name,
      'status': 'completed',
      'conclusion': 'success',
    };
    expect(
      await score(
        commits([
          [
            named(1, r'goal: Logs drop \^[ codes'),
            named(2, r'goal: A next line \^E and \^['),
            named(3, 'goal: $kept'),
          ],
        ], of: goal),
      ),
      (3, 0, 0),
    );
    // A run's name comes as gh rewrote it already, and is not rewritten again: a file separator before `u001b` comes as
    // `^\u001b`, which read again would be `^\^[` (third review, 2026-11-11).
    const separator = 'A separator \u001Cu001b';
    expect(
      await score(
        commits([
          [named(4, r'goal: A separator ^\u001b')],
        ], of: '| $separator | `a` |'),
      ),
      (1, 0, 0),
    );
  });

  // A check run's page is text from outside: a row may send a browser only to github.com, over https.
  test(
    'a run\'s page is a link only when it is github.com\'s over https',
    () async {
      for (final (page, link) in <(Object?, bool)>[
        ('https://github.com/acme/lampos/actions/runs/7/job/1', true),
        ('https://GitHub.com/acme/lampos/runs/1', true),
        ('http://github.com/acme/lampos/runs/1', false),
        ('https://github.com.example.org/acme/lampos/runs/1', false),
        ('https://example.org/github.com/runs/1', false),
        ('https://github.com@example.org/runs/1', false),
        ('file:///Applications', false),
        ('javascript:alert(1)', false),
        ('github.com/acme/lampos/runs/1', false),
        ('https://', false),
        (7, false),
        (null, false),
      ]) {
        final goal = (await commits([
          [
            {...goalRun(1, sync, 'failure'), 'html_url': page},
          ],
        ], of: '| $sync | `a` |').github.goal('acme/lampos'))!;
        expect(
          goal.milestones.single.url,
          link ? page : isNull,
          reason: '$page',
        );
        expect(goal.milestones.single.state, SwarmMilestoneState.fails);
      }
    },
  );

  // A milestone's name is the repository's text. On screen it loses what would draw as nothing or as other words; its
  // check is still found by the name as written.
  test('a milestone is shown without control characters and marks that turn a line\'s direction, and matched as written', () async {
    const written =
        'A bell \u0007 in a\u0085 name\u202E txet\u202C \u2066x\u2069\u200E\u200F\u007F\u009F\u001B[31m';
    final goal = (await commits([
      [goalRun(1, written, 'success')],
    ], of: '| $written | `true` |').github.goal('acme/lampos'))!;
    expect(goal.milestones.single.name, written);
    expect(goal.milestones.single.state, SwarmMilestoneState.passes);
    expect(goal.milestones.single.shown, 'A bell  in a name txet x[31m');
    // The Arabic letter mark turns a line's direction as its siblings do.
    expect(
      const SwarmMilestone(
        name: 'One \u061C two',
        state: SwarmMilestoneState.notRun,
      ).shown,
      'One  two',
    );
    // A branch's name is the repository's text too: git takes a mark that turns a line's direction in one.
    expect(
      const SwarmGoal(milestones: [], branch: 'main\u202Eniam').shownBranch,
      'mainniam',
    );
    // Words in other scripts, and an emoji, are a name's own.
    expect(
      const SwarmMilestone(
        name: 'Caf\u00E9 \u{1F4A1} \u706F',
        state: SwarmMilestoneState.notRun,
      ).shown,
      'Caf\u00E9 \u{1F4A1} \u706F',
    );
  });

  test('the goal is scored on the branch\'s tip when all its checks have ended, by the calls the daemon makes', () async {
    final t = commits([
      done,
      [goalRun(9, sync, 'failure')],
    ]);
    expect(await score(t), (2, 1, 0));
    expect(t.calls, [
      '/contents/agents/GOAL.md',
      '',
      '/commits?sha=main&per_page=100',
      '/commits/${FakeGoalGitHub.sha(0)}/check-runs?per_page=100',
    ]);
    // Each a read, as the version of GitHub's API the daemon asks.
    expect(t.last, [
      'api',
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      'repos/acme/lampos/commits/${FakeGoalGitHub.sha(0)}/check-runs?per_page=100',
    ]);
  });

  // After each landing the tip has no run yet, and a tip pushed with [skip ci] never has one.
  test('else on the newest of the branch\'s last five landings whose checks have all ended', () async {
    final t = commits([
      [],
      running,
      done,
      [goalRun(9, sync, 'failure')],
    ]);
    expect(await score(t), (2, 1, 0));
    expect(checksAsked(t), [(0, 1), (1, 1), (2, 1)]);
    // The sixth is not looked at.
    final six = commits([[], [], [], [], [], done]);
    expect(await score(six), (0, 0, 3));
    expect(checksAsked(six), [for (var n = 0; n < 5; n++) (n, 1)]);
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
    expect(checksAsked(t), [(0, 1), (7, 1)]);
  });

  // The daemon follows the line among the branch's last hundred commits, as GitHub lists them: a landing older than those
  // is not one of its five.
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
      expect(checksAsked(t), [(0, 1)]);
    },
  );

  test('with none of the five ended, on the landing with the fewest not run, the newest of those', () async {
    final one = [goalRun(1, sync, 'success')];
    final none = commits([[], running, one, running, [], done]);
    expect(await score(none), (1, 0, 2));
    expect(none.calls, hasLength(3 + 5));
    expect(
      await score(
        commits([
          [],
          one,
          [goalRun(1, sync, 'failure')],
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
    // A branch GitHub lists no commit of: nothing has run, and nothing more is asked.
    final empty = commits([]);
    expect(await score(empty), (0, 0, 3));
    expect(empty.calls, hasLength(3));
  });

  test('the branch is asked for by its name as an address takes it, and a commit\'s checks past the first hundred are read too, as far as three pages', () async {
    Map<String, Object?> other(int id) => {
      'id': id,
      'name': 'build $id',
      'status': 'completed',
      'conclusion': 'success',
    };
    final late = [
      for (final run in done) {...run, 'id': 900 + (run['id']! as int)},
    ];
    final t = commits([
      [for (var n = 1; n <= 250; n++) other(n), ...late],
      // Its checks are never asked for: the tip's have ended.
      [for (var n = 1; n <= 250; n++) other(n)],
    ])..branch = 'release/1 beta';
    final goal = (await t.github.goal('acme/lampos'))!;
    expect((counts(goal), goal.branch), ((2, 1, 0), 'release/1 beta'));
    expect(t.calls.skip(2), [
      '/commits?sha=release%2F1%20beta&per_page=100',
      '/commits/${FakeGoalGitHub.sha(0)}/check-runs?per_page=100',
      '/commits/${FakeGoalGitHub.sha(0)}/check-runs?per_page=100&page=2',
      '/commits/${FakeGoalGitHub.sha(0)}/check-runs?per_page=100&page=3',
    ]);
    final far = commits([
      [for (var n = 1; n <= 300; n++) other(n), ...done],
    ]);
    expect(await score(far), (0, 0, 3));
    expect(checksAsked(far), [(0, 1), (0, 2), (0, 3)]);
    // A repository that names no default branch is asked for its commits with none, as the daemon asks.
    final unnamed = commits([done])..branch = '';
    expect(await score(unnamed), (2, 1, 0));
    expect(unnamed.calls[2], '/commits?sha=&per_page=100');
  });

  test('a project with no goal file, one over 1 MB, or one with no row has no goal, and nothing more is asked for it', () async {
    for (final t in [
      FakeGoalGitHub(landings: [FakeLanding(done)]),
      FakeGoalGitHub(
        file: '# Goal\n\nNot written yet.',
        landings: [FakeLanding(done)],
      ),
      // GitHub answers for a file over 1 MB with no content, which the daemon reads as no file.
      FakeGoalGitHub(file: file, landings: [FakeLanding(done)])..tooBig = true,
    ]) {
      expect(await t.github.goal('acme/lampos'), isNull);
      expect(t.calls, ['/contents/agents/GOAL.md']);
    }
    // Content that is not what GitHub says it is, and an answer that is no JSON at all.
    for (final answer in <Object?>[
      {'content': 'not base64!', 'encoding': 'base64'},
      {'content': 7, 'encoding': 'base64'},
      {'content': base64.encode(utf8.encode(file))},
      [contents(file)],
      'not json',
      'null',
    ]) {
      expect(
        await answering((_) => answer).goal('acme/lampos'),
        isNull,
        reason: '$answer',
      );
    }
    // Bytes that are no UTF-8 are read as the daemon reads them, each as U+FFFD, and the rows around them stand.
    final bytes = [
      ...utf8.encode('| Sync | `a` |\n| '),
      0xFF,
      ...utf8.encode(' | `b` |'),
    ];
    final goal = await answering(
      (path) => path.startsWith('/contents/')
          ? {'content': base64.encode(bytes), 'encoding': 'base64'}
          : path.isEmpty
          ? {'default_branch': 'main'}
          : [],
    ).goal('acme/lampos');
    expect([for (final m in goal!.milestones) m.name], ['Sync', '\uFFFD']);
  });

  // The daemon's reader keeps a file's byte-order mark, which counts toward its first line's length; Dart's own leaves
  // the mark out.
  test(
    'a file that starts with a byte-order mark is read as the daemon reads it',
    () async {
      Future<List<String>?> milestones(String text) async {
        final goal = await answering(
          (path) => path.startsWith('/contents/')
              ? {
                  'content': base64.encode([
                    0xEF,
                    0xBB,
                    0xBF,
                    ...utf8.encode(text),
                  ]),
                  'encoding': 'base64',
                }
              : path.isEmpty
              ? {'default_branch': 'main'}
              : [],
        ).goal('acme/lampos');
        return goal == null ? null : [for (final m in goal.milestones) m.name];
      }

      // The mark is space at a row's start.
      expect(await milestones('| Sync | `a` |\n| Start | `b` |'), [
        'Sync',
        'Start',
      ]);
      // With it the first line is 1,000 long, and read; one longer, and it is not.
      final longest = '| Sync | `${'b' * 986}` |';
      expect(longest.length, 999);
      expect(await milestones(longest), ['Sync']);
      expect(await milestones('| Sync | `${'b' * 987}` |'), isNull);
      expect(await milestones('\n| Sync | `${'b' * 987}` |'), ['Sync']);
    },
  );

  test('a read that fails says why, in the goal\'s own words where the board\'s are of tasks', () async {
    Future<void> fails(Future<SwarmGoal?> read, String words) => expectLater(
      read,
      throwsA(
        isA<SwarmGitHubError>().having((e) => e.message, 'message', words),
      ),
    );
    final logged = <String>[];
    final previous = appLog;
    appLog = _Recorder(logged);
    addTearDown(() => appLog = previous);
    final t = commits([done])..failure = FakeGoalGitHub.signedOut;
    await fails(
      t.github.goal('acme/lampos'),
      'Sign in to GitHub: run gh auth login.',
    );
    // The file not being there is an answer; the repository not being there is not.
    t
      ..failure = FakeGoalGitHub.notFound
      ..failureAt = '';
    await fails(
      t.github.goal('acme/lampos'),
      'You can\'t see acme/lampos on GitHub.',
    );
    t
      ..failure = (1, 'gh: Server Error (HTTP 502)')
      ..failureAt = '/commits/${FakeGoalGitHub.sha(0)}/check-runs?per_page=100';
    await fails(
      t.github.goal('acme/lampos'),
      'GitHub didn\'t answer. Try again.',
    );
    // No gh on this computer.
    await fails(
      SwarmGitHub(run: (_) async => throw const ProcessException('gh', []))
          .goal('acme/lampos'),
      'Install the GitHub CLI (gh) to see the goal.',
    );
    // A limit stops every read for two minutes, the goal's too.
    t
      ..failure = (1, 'gh: API rate limit exceeded for user ID 1. (HTTP 403)')
      ..failureAt = null;
    await fails(t.github.goal('acme/lampos'), SwarmGitHub.limitedWords);
    final asked = t.calls.length;
    t.failure = null;
    await fails(t.github.goal('acme/lampos'), SwarmGitHub.limitedWords);
    expect(t.calls, hasLength(asked));
    // Each failure is named in the log as the goal's, by its kind and never by what gh printed.
    expect(logged, [
      'GitHub goal not read: signed out (gh exited 4)',
      'GitHub goal not read: no repository (gh exited 1)',
      'GitHub goal not read: failed (gh exited 1)',
      'GitHub goal not read: gh is not installed',
      'GitHub goal not read: rate limited (gh exited 1)',
    ]);
    // A project with no goal file is no failure: nothing is logged for it.
    logged.clear();
    expect(await FakeGoalGitHub().github.goal('acme/lampos'), isNull);
    expect(logged, isEmpty);
  });

  // The daemon reads an answer that is not what was asked for as an empty one.
  test('what GitHub sends in another shape reads as nothing run', () async {
    final sha = FakeGoalGitHub.sha(0);
    for (final (commits, runs, asked) in <(Object?, Object?, int)>[
      ('not json', null, 0),
      ({'message': 'not a list'}, null, 0),
      (
        [
          7,
          {},
          {'sha': '../../pulls'},
          {'sha': 7},
          {'sha': sha, 'parents': 'none'},
        ],
        {'total_count': 0},
        1,
      ),
      (
        [
          {
            'sha': sha,
            'parents': [7],
          },
        ],
        {
          'check_runs': [
            7,
            null,
            {'name': 9, 'id': 'x', 'status': 3},
            {'name': 'goal: $sync', 'id': 4.5, 'status': 'completed'},
          ],
        },
        1,
      ),
      (
        [
          {
            'sha': sha,
            'parents': [
              {'sha': 7},
            ],
          },
        ],
        'not json',
        1,
      ),
    ]) {
      var checks = 0;
      final goal = await answering((path) {
        if (path.startsWith('/contents/')) return contents(file);
        // A name that is no text is asked for as it stands, as the daemon asks.
        if (path.isEmpty) return {'default_branch': 7};
        if (path == '/commits?sha=7&per_page=100') return commits;
        if (path == '/commits/$sha/check-runs?per_page=100') {
          checks++;
          return runs;
        }
        fail('asked for $path');
      }).goal('acme/lampos');
      final expected = runs is Map && runs['check_runs'] is List
          ? (0, 1, 2)
          : (0, 0, 3);
      expect(counts(goal!), expected, reason: '$commits');
      expect(checks, asked, reason: '$commits');
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

  // Two reads of one repository can be on their way at once (its bar shown again while the first still waits on GitHub).
  test(
    'an answer that comes after a later read\'s is not kept in its place',
    () async {
      final t = commits([done]);
      final gate = t.hold = Completer<void>();
      // Its checks are answered, 2 passing, and the answer waits.
      final older = t.github.goal('acme/lampos');
      await pumpEventQueue();
      expect(t.calls, hasLength(4));
      t
        ..hold = null
        ..landings = [
          FakeLanding([...done, goalRun(13, screens, 'success')]),
        ];
      expect((await t.github.goal('acme/lampos'))!.passed, 3);
      gate.complete();
      expect((await older)!.passed, 2);
      expect(t.github.keptGoal('acme/lampos')!.goal!.passed, 3);
    },
  );
}

/// The app log's lines, as they were written.
class _Recorder implements AppLog {
  _Recorder(this.lines);
  final List<String> lines;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add(message);
}
