import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/sidebar_pull_requests.dart';
import 'package:harness/super_tabs/task_status.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_task_board_fixture.dart';

/// The Swarm sidebar's task board: what each workgroup's task is doing, said on its row without asking the Lead —
/// a status chip, the agent's avatar, how long since it was last active, its pull request — a filter by status,
/// and the finished work gathered behind one row.
void main() {
  late List<List<String>> reads;
  late Map<int, (String, int)> states;
  late Map<String, dynamic>? answer;

  setUp(() {
    reads = [];
    states = {1557: ('Draft', 2), 1572: ('Open', 5), 1494: ('Merged', 5)};
    answer = null;
  });

  Future<Map<String, dynamic>> read(List<String> urls) async {
    reads.add(urls);
    return answer ?? pullRequestRows(urls, states);
  }

  /// A Swarm with [groups], its sidebar mounted with project "Harness" open.
  Future<SuperTabController> show(
    WidgetTester tester,
    List<Map<String, dynamic>> groups, {
    Future<Map<String, dynamic>> Function(List<String>)? reader,
    DateTime? now,
    bool open = true,
  }) async {
    await tester.binding.setSurfaceSize(const Size(360, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = ConversationServer();
    taskBoard(server, groups);
    final c = server.controller();
    await c.refresh();
    if (open) c.expandedProjects.add('lead');
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: ListenableBuilder(
            listenable: c,
            builder: (context, _) => ProjectSidebar(
              controller: c,
              onSelect: c.select,
              needsHuman: (_) => 0,
              onAddAgent: (_) {},
              now: () => now ?? taskBoardNow,
              readPullRequests: reader ?? read,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
    return c;
  }

  Finder row(int number) => find.byKey(ValueKey('super-group-task-$number'));
  Finder chip(int number) =>
      find.byKey(ValueKey('super-task-chip-task-$number'));
  String chipWord(WidgetTester tester, int number) =>
      tester.widget<SuperTabTaskChip>(chip(number)).status.label;

  /// One group of each assignment status, none of them finished.
  List<Map<String, dynamic>> inProgress() => [
    taskGroup(1, 'Working task', 'working', ago: const Duration(minutes: 2)),
    taskGroup(
      2,
      'Waiting task',
      'needs_human',
      agent: 'sage',
      ago: const Duration(minutes: 12),
    ),
    taskGroup(
      3,
      'Stuck task',
      'blocked',
      agent: 'nova',
      ago: const Duration(minutes: 47),
    ),
    taskGroup(4, 'Review task', 'review', ago: const Duration(minutes: 5)),
    taskGroup(
      5,
      'Reconciling task',
      'reconciling',
      agent: 'finn',
      ago: const Duration(hours: 3),
    ),
    taskGroup(6, 'Planned task', 'planned'),
    taskGroup(7, 'Unassigned task', null),
  ];

  group('what a task is called', () {
    test('every assignment status has its one word', () {
      SuperTabTaskStatus? of(String? status) => SuperTabTaskStatus.of(
        SuperTabConversation.fromJson(taskGroup(1, 'T', status)),
      );
      expect(of(null), SuperTabTaskStatus.notStarted);
      expect(of('planned'), SuperTabTaskStatus.notStarted);
      expect(of('working'), SuperTabTaskStatus.working);
      expect(of('reconciling'), SuperTabTaskStatus.working);
      expect(of('needs_human'), SuperTabTaskStatus.needsYou);
      expect(of('blocked'), SuperTabTaskStatus.blocked);
      expect(of('review'), SuperTabTaskStatus.review);
      expect(of('done'), SuperTabTaskStatus.done);
      expect(of('stopped'), SuperTabTaskStatus.stopped);
      expect(of('cancelled'), SuperTabTaskStatus.cancelled);
      // A status a newer backend adds is no one of these, and has no chip rather than a wrong one.
      expect(of('paused_for_review'), isNull);
      expect(
        [for (final s in SuperTabTaskStatus.values) s.label],
        [
          'Not started',
          'Working',
          'Needs you',
          'Blocked',
          'Review',
          'Done',
          'Stopped',
          'Cancelled',
        ],
      );
    });

    test('done, stopped and cancelled are finished; nothing else is', () {
      expect(SuperTabTaskStatus.values.where((s) => s.finished), [
        SuperTabTaskStatus.done,
        SuperTabTaskStatus.stopped,
        SuperTabTaskStatus.cancelled,
      ]);
      expect(
        SuperTabTaskStatus.filterable,
        isNot(contains(SuperTabTaskStatus.done)),
      );
    });

    test('blocked reads Blocked wherever a status is said, not Stuck', () {
      expect(superTabWorkStatusLabel('blocked'), 'blocked');
      expect(SuperTabTaskStatus.blocked.label, 'Blocked');
    });

    test('the group keeps the time of its last activity, and none from a backend that says none', () {
      final seen = SuperTabConversation.fromJson(
        taskGroup(1, 'T', 'working', ago: const Duration(minutes: 3)),
      );
      expect(
        seen.lastActivityAt!.millisecondsSinceEpoch,
        taskBoardNow
            .subtract(const Duration(minutes: 3))
            .millisecondsSinceEpoch,
      );
      expect(
        SuperTabConversation.fromJson(taskGroup(2, 'T', 'working'))
            .lastActivityAt,
        isNull,
      );
    });
  });

  group('the chip, avatar, age and pull request on a workgroup row', () {
    testWidgets('each assignment status shows its own chip', (tester) async {
      await show(tester, inProgress());
      expect(
        {for (var n = 1; n <= 7; n++) n: chipWord(tester, n)},
        {
          1: 'Working',
          2: 'Needs you',
          3: 'Blocked',
          4: 'Review',
          5: 'Working',
          6: 'Not started',
          7: 'Not started',
        },
      );
      expect(find.text('Stuck'), findsNothing);
    });

    testWidgets('finished work shows Done, Stopped and Cancelled once opened', (
      tester,
    ) async {
      final c = await show(tester, [
        taskGroup(1, 'Shipped', 'done', ago: const Duration(hours: 5)),
        taskGroup(2, 'Dropped', 'stopped', ago: const Duration(days: 1)),
        taskGroup(
          3,
          'Cancelled for good',
          'cancelled',
          ago: const Duration(days: 2),
        ),
      ]);
      c.toggleFinished('lead');
      await tester.pump();
      expect(
        {for (var n = 1; n <= 3; n++) n: chipWord(tester, n)},
        {1: 'Done', 2: 'Stopped', 3: 'Cancelled'},
      );
    });

    testWidgets(
      'the assigned agent\'s avatar, and how long since the group was last active',
      (tester) async {
        await show(tester, inProgress());
        final avatar = tester.widget<SuperTabAvatar>(
          find.byKey(const ValueKey('super-task-agent-task-2')),
        );
        expect((avatar.identity, avatar.name), ('agent:sage', 'Sage'));
        expect(find.byTooltip('Sage'), findsOneWidget);
        String age(int n) => tester
            .widget<Text>(find.byKey(ValueKey('super-task-age-task-$n')))
            .data!;
        expect(
          [
            for (final n in [1, 2, 3, 4, 5]) age(n),
          ],
          ['2 min ago', '12 min ago', '47 min ago', '5 min ago', '3 h ago'],
        );
        // The age moves with the clock.
        await tester.pumpWidget(const SizedBox());
        await show(
          tester,
          inProgress(),
          now: taskBoardNow.add(const Duration(minutes: 10)),
        );
        expect(
          tester
              .widget<Text>(find.byKey(const ValueKey('super-task-age-task-1')))
              .data,
          '12 min ago',
        );
      },
    );

    testWidgets(
      'a group the backend gave no time shows no age, and no agent shows no avatar',
      (tester) async {
        final groups = [
          taskGroup(1, 'No time', 'working'),
          {
            ...taskGroup(
              2,
              'Agent gone',
              'working',
              ago: const Duration(minutes: 1),
            ),
            'assignment': {
              ...(taskGroup(2, 'x', 'working')['assignment']
                  as Map<String, dynamic>),
              'agentId': 'removed-agent',
            },
          },
        ];
        await show(tester, groups);
        expect(
          find.byKey(const ValueKey('super-task-age-task-1')),
          findsNothing,
        );
        expect(chip(1), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-task-agent-task-2')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('super-task-age-task-2')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'the pull request a group links to shows its state, read once for every row',
      (tester) async {
        await show(tester, [
          taskGroup(
            1,
            'In a check',
            'working',
            evidence: '$taskBoardRepo/1557',
          ),
          taskGroup(
            2,
            'In the result',
            'review',
            result: 'Ready: $taskBoardRepo/1572',
          ),
          taskGroup(3, 'No PR', 'working'),
          taskGroup(
            4,
            'Two PRs',
            'working',
            result: '$taskBoardRepo/1557 then $taskBoardRepo/1572',
          ),
        ]);
        Text pr(int n) =>
            tester.widget<Text>(find.byKey(ValueKey('super-task-pr-task-$n')));
        expect(pr(1).data, '#1557 Draft');
        expect(pr(2).data, '#1572 Ready to merge');
        expect(
          find.byKey(const ValueKey('super-task-pr-task-3')),
          findsNothing,
        );
        // The newest link a group names.
        expect(pr(4).data, '#1572 Ready to merge');
        // One batch for all of them, each link once.
        expect(reads, hasLength(1));
        expect(reads.single..sort(), [
          '$taskBoardRepo/1557',
          '$taskBoardRepo/1572',
        ]);
      },
    );

    testWidgets(
      'a merged pull request says Merged, and is not asked about again',
      (tester) async {
        final c = await show(tester, [
          taskGroup(
            1,
            'Shipped',
            'done',
            result: 'Merged: $taskBoardRepo/1494',
          ),
          taskGroup(2, 'Live', 'working', evidence: '$taskBoardRepo/1557'),
        ]);
        c.toggleFinished('lead');
        await tester.pump();
        await tester.pump();
        expect(
          tester
              .widget<Text>(find.byKey(const ValueKey('super-task-pr-task-1')))
              .data,
          '#1494 Merged',
        );
        expect(
          reads.expand((u) => u),
          containsAll(['$taskBoardRepo/1494', '$taskBoardRepo/1557']),
        );
      },
    );

    testWidgets('the row says it all in one label for a screen reader', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await show(tester, [
        taskGroup(
          1,
          'Relay opens',
          'working',
          ago: const Duration(minutes: 2),
          evidence: '$taskBoardRepo/1557',
        ),
      ]);
      await tester.pump();
      await tester.pump();
      expect(
        tester.getSemantics(row(1)).label,
        '#1 Relay opens, Working, with Atlas, updated 2 min ago, pull request #1557 Draft',
      );
      handle.dispose();
    });
  });

  group('a Swarm whose Desktop cannot read pull requests', () {
    testWidgets(
      'an older CLI leaves the rows without a pull request, and no error',
      (tester) async {
        answer = {'error': 'UNSUPPORTED'};
        await show(tester, [
          taskGroup(1, 'Linked', 'working', evidence: '$taskBoardRepo/1557'),
          taskGroup(2, 'Linked too', 'review', result: '$taskBoardRepo/1572'),
        ]);
        expect(
          find.byKey(const ValueKey('super-task-pr-task-1')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('super-task-pr-task-2')),
          findsNothing,
        );
        expect(chip(1), findsOneWidget);
        expect(chip(2), findsOneWidget);
        expect(tester.takeException(), isNull);
        // It asked once and, told it cannot, never again.
        await tester.pump(const Duration(minutes: 5));
        expect(reads, hasLength(1));
      },
    );

    testWidgets('a window with no reader at all asks nothing and shows none', (
      tester,
    ) async {
      final c = await show(tester, [
        taskGroup(1, 'Linked', 'working', evidence: '$taskBoardRepo/1557'),
      ], reader: null);
      // `reader: null` falls back to the default (read); rebuild the sidebar with none.
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) => ProjectSidebar(
                controller: c,
                onSelect: c.select,
                needsHuman: (_) => 0,
                onAddAgent: (_) {},
                now: () => taskBoardNow,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(chip(1), findsOneWidget);
      expect(find.byKey(const ValueKey('super-task-pr-task-1')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'a GitHub login that is signed out takes the old pull requests off the rows, without an error',
      (tester) async {
        await show(tester, [
          taskGroup(1, 'Linked', 'working', evidence: '$taskBoardRepo/1557'),
        ]);
        expect(
          find.byKey(const ValueKey('super-task-pr-task-1')),
          findsOneWidget,
        );
        // The reader's login changes: yesterday's pull requests are not left under today's account.
        answer = {'error': 'GH_SIGNED_OUT'};
        await tester.pump(const Duration(seconds: 61));
        await tester.pump();
        await tester.pump();
        expect(
          find.byKey(const ValueKey('super-task-pr-task-1')),
          findsNothing,
        );
        expect(chip(1), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  });

  group('the status filter', () {
    testWidgets(
      'offers each status that some group has, with how many, and narrows the rows',
      (tester) async {
        final c = await show(tester, [
          ...inProgress(),
          taskGroup(
            8,
            'Another waiting',
            'needs_human',
            agent: 'sage',
            ago: const Duration(minutes: 30),
          ),
          taskGroup(9, 'Shipped', 'done'),
        ]);
        expect(find.text('All'), findsOneWidget);
        expect(find.text('Needs you 2'), findsOneWidget);
        expect(find.text('Blocked 1'), findsOneWidget);
        expect(find.text('Working 2'), findsOneWidget);
        expect(find.text('Review 1'), findsOneWidget);
        expect(find.text('Not started 2'), findsOneWidget);
        // Finished work is not in the filter; it has its own row.
        expect(find.textContaining('Done'), findsNothing);

        await tester.tap(
          find.byKey(const ValueKey('super-task-filter-needsYou')),
        );
        await tester.pump();
        expect(c.statusFilter, SuperTabTaskStatus.needsYou);
        expect(
          [
            for (var n = 1; n <= 8; n++)
              if (row(n).evaluate().isNotEmpty) n,
          ],
          [2, 8],
        );
        // Narrowed, there is no Finished row: the filter is about work in progress.
        expect(find.textContaining('Finished'), findsNothing);

        // Choosing it again, or All, shows everything.
        await tester.tap(
          find.byKey(const ValueKey('super-task-filter-needsYou')),
        );
        await tester.pump();
        expect(c.statusFilter, isNull);
        expect(
          [
            for (var n = 1; n <= 8; n++)
              if (row(n).evaluate().isNotEmpty) n,
          ],
          [1, 2, 3, 4, 5, 6, 7, 8],
        );
        await tester.tap(
          find.byKey(const ValueKey('super-task-filter-blocked')),
        );
        await tester.pump();
        expect(
          [
            for (var n = 1; n <= 8; n++)
              if (row(n).evaluate().isNotEmpty) n,
          ],
          [3],
        );
        await tester.tap(find.byKey(const ValueKey('super-task-filter-all')));
        await tester.pump();
        expect(c.statusFilter, isNull);
        expect(row(1), findsOneWidget);
      },
    );

    testWidgets('is not offered when there is nothing to tell apart', (
      tester,
    ) async {
      await show(tester, [
        taskGroup(1, 'One', 'working'),
        taskGroup(2, 'Two', 'working'),
      ]);
      expect(find.byKey(const ValueKey('super-task-filter-all')), findsNothing);
    });

    testWidgets(
      'says so when no group has the chosen status, and can be undone',
      (tester) async {
        final c = await show(tester, inProgress());
        c.filterByStatus(SuperTabTaskStatus.review);
        await tester.pump();
        expect(row(4), findsOneWidget);
        // The Review task moves on; the choice stays, and says nothing is left under it.
        final server = ConversationServer();
        taskBoard(server, inProgress().where((g) => g['number'] != 4).toList());
        c.filterByStatus(SuperTabTaskStatus.blocked);
        await tester.pump();
        expect(row(3), findsOneWidget);
        expect(find.text('No Review workgroups'), findsNothing);
        c.filterByStatus(SuperTabTaskStatus.review);
        await tester.pump();
        expect(
          find.byKey(const ValueKey('super-task-filter-all')),
          findsOneWidget,
        );
      },
    );
  });

  group('finished tasks', () {
    List<Map<String, dynamic>> mixed() => [
      taskGroup(1, 'Working task', 'working'),
      taskGroup(2, 'Shipped', 'done', ago: const Duration(hours: 5)),
      taskGroup(3, 'Dropped', 'stopped'),
      taskGroup(4, 'Called off', 'cancelled'),
    ];

    testWidgets(
      'are gathered under Finished (N), collapsed, instead of filling the list',
      (tester) async {
        await show(tester, mixed());
        expect(row(1), findsOneWidget);
        expect(find.text('Finished (3)'), findsOneWidget);
        for (final n in [2, 3, 4]) {
          expect(row(n), findsNothing, reason: '$n');
        }
      },
    );

    testWidgets('open and close with the row, apart for each project', (
      tester,
    ) async {
      final c = await show(tester, mixed());
      await tester.tap(find.byKey(const ValueKey('super-finished-lead')));
      await tester.pump();
      expect(
        [
          for (final n in [2, 3, 4]) row(n).evaluate().isNotEmpty,
        ],
        [true, true, true],
      );
      expect(c.finishedOpenProjects, {'lead'});
      await tester.tap(find.byKey(const ValueKey('super-finished-lead')));
      await tester.pump();
      expect(row(2), findsNothing);
    });

    testWidgets('open on their own for a finished group that is chosen', (
      tester,
    ) async {
      final c = await show(tester, mixed());
      c.select('task-3');
      await tester.pump();
      expect(row(3), findsOneWidget);
      expect(c.finishedOpenProjects, contains('lead'));
      expect(c.selectedId, 'task-3');
      await c.flush();
    });

    testWidgets(
      'a project with only finished work shows no empty list, only the row',
      (tester) async {
        await show(tester, [
          taskGroup(1, 'Shipped', 'done'),
          taskGroup(2, 'Dropped', 'stopped'),
        ]);
        expect(find.text('Finished (2)'), findsOneWidget);
        expect(find.text('No workgroups yet'), findsNothing);
      },
    );

    testWidgets('a project with none says so, as before', (tester) async {
      await show(tester, const []);
      expect(find.text('No workgroups yet'), findsOneWidget);
      expect(find.textContaining('Finished'), findsNothing);
    });
  });

  group('what stays as it was', () {
    testWidgets('unread dots, selection and the lead row', (tester) async {
      final c = await show(tester, [
        {...taskGroup(1, 'Has news', 'working'), 'lastMessageSequence': 4},
        taskGroup(2, 'Quiet', 'review'),
      ]);
      Finder dot(int n) => find.descendant(
        of: row(n),
        matching: find.byWidgetPredicate(
          (w) => w is Semantics && w.properties.label == 'Unread messages',
        ),
      );
      expect(dot(1), findsOneWidget);
      expect(dot(2), findsNothing);
      // Choosing a row selects it; the lead row has no chip, and still opens the lead.
      await tester.tap(row(2));
      await tester.pump();
      expect(c.selectedId, 'task-2');
      expect(find.byKey(const ValueKey('super-task-chip-lead')), findsNothing);
      expect(find.text('Harness'), findsOneWidget);
      await tester.tap(find.text('Harness'));
      await tester.pump();
      expect(c.selectedId, 'lead');
      await c.flush();
    });

    testWidgets('a project that is collapsed shows none of it', (tester) async {
      await show(tester, inProgress(), open: false);
      expect(row(1), findsNothing);
      expect(
        find.byKey(const ValueKey('super-project-expand-lead')),
        findsOneWidget,
      );
    });
  });

  group('the order of the rows, and how much room each takes', () {
    /// The numbers of the rows shown, top to bottom.
    List<int> order(WidgetTester tester) {
      final rows = [
        for (final element
            in find
                .byWidgetPredicate(
                  (w) =>
                      w.key is ValueKey<String> &&
                      (w.key! as ValueKey<String>).value.startsWith(
                        'super-group-task-',
                      ),
                )
                .evaluate())
          (
            int.parse(
              (element.widget.key! as ValueKey<String>).value.split('-').last,
            ),
            tester.getTopLeft(find.byWidget(element.widget)).dy,
          ),
      ]..sort((a, b) => a.$2.compareTo(b.$2));
      return [for (final r in rows) r.$1];
    }

    testWidgets(
      'within a project: Needs you, Blocked, Review, Working, Not started; the newest first in each',
      (tester) async {
        await show(tester, [
          taskGroup(1, 'Old work', 'working', ago: const Duration(hours: 3)),
          taskGroup(
            2,
            'Fresh work',
            'working',
            ago: const Duration(minutes: 1),
          ),
          taskGroup(3, 'Not begun', 'planned'),
          taskGroup(4, 'Review', 'review', ago: const Duration(minutes: 9)),
          taskGroup(
            5,
            'Waits, older',
            'needs_human',
            ago: const Duration(hours: 2),
          ),
          taskGroup(
            6,
            'Waits, newer',
            'needs_human',
            ago: const Duration(minutes: 3),
          ),
          taskGroup(7, 'Stuck', 'blocked', ago: const Duration(minutes: 40)),
          taskGroup(8, 'No time given', 'working'),
          taskGroup(9, 'Unassigned', null),
          taskGroup(10, 'A status from the future', 'paused_for_review'),
        ]);
        expect(order(tester), [6, 5, 7, 4, 2, 1, 8, 3, 9, 10]);
      },
    );

    testWidgets(
      'finished work is gathered newest first, and does not mix with the rest',
      (tester) async {
        final c = await show(tester, [
          taskGroup(
            1,
            'Shipped long ago',
            'done',
            ago: const Duration(days: 3),
          ),
          taskGroup(2, 'Waiting', 'needs_human', ago: const Duration(days: 4)),
          taskGroup(
            3,
            'Dropped today',
            'stopped',
            ago: const Duration(minutes: 20),
          ),
          taskGroup(
            4,
            'Cancelled yesterday',
            'cancelled',
            ago: const Duration(days: 1),
          ),
        ]);
        c.toggleFinished('lead');
        await tester.pump();
        expect(order(tester), [2, 3, 4, 1]);
      },
    );

    testWidgets(
      'a row is two lines: the title, and one line of chip, avatar, age and pull request',
      (tester) async {
        await show(tester, [
          taskGroup(
            1,
            'Relay opens',
            'working',
            ago: const Duration(minutes: 2),
            evidence: '$taskBoardRepo/1557',
          ),
          taskGroup(
            2,
            'No PR',
            'review',
            agent: 'sage',
            ago: const Duration(minutes: 5),
          ),
        ]);
        double y(Finder f) => tester.getCenter(f).dy;
        // On one line, left to right, whether or not there is a pull request.
        for (final n in [1, 2]) {
          final line = y(find.byKey(ValueKey('super-task-chip-task-$n')));
          expect(
            y(find.byKey(ValueKey('super-task-agent-task-$n'))),
            closeTo(line, 2),
          );
          expect(
            y(find.byKey(ValueKey('super-task-age-task-$n'))),
            closeTo(line, 2),
          );
          // Below the title, which is one line too.
          expect(
            line,
            greaterThan(
              y(find.text('#$n ${n == 1 ? 'Relay opens' : 'No PR'}')),
            ),
          );
        }
        final chipRight = tester.getTopRight(chip(1)).dx;
        final ageLeft = tester
            .getTopLeft(find.byKey(const ValueKey('super-task-age-task-1')))
            .dx;
        final prLeft = tester
            .getTopLeft(find.byKey(const ValueKey('super-task-pr-task-1')))
            .dx;
        expect(ageLeft, greaterThan(chipRight));
        expect(prLeft, greaterThan(ageLeft));
        expect(
          y(find.byKey(const ValueKey('super-task-pr-task-1'))),
          closeTo(y(find.byKey(const ValueKey('super-task-chip-task-1'))), 2),
        );
        // So a row without a pull request is as tall as one with.
        expect(
          tester.getSize(row(1)).height,
          closeTo(tester.getSize(row(2)).height, 1),
        );
      },
    );

    for (final (width, scale) in [(240.0, 1.0), (200.0, 1.0), (280.0, 2.0)]) {
      testWidgets(
        'never overflows, at $width px and ${scale}x text, with a long pull request',
        (tester) async {
          states[1572] = ('Open', 1);
          await tester.binding.setSurfaceSize(Size(width, 1600));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          final server = ConversationServer();
          taskBoard(server, [
            taskGroup(
              1,
              'A workgroup with a rather long name indeed',
              'needs_human',
              agent: 'sage',
              ago: const Duration(days: 12),
              result: '$taskBoardRepo/1572',
            ),
            taskGroup(
              2,
              'Short',
              'blocked',
              agent: 'nova',
              ago: const Duration(minutes: 47),
            ),
          ]);
          final c = server.controller();
          await c.refresh();
          c.expandedProjects.add('lead');
          await tester.pumpWidget(
            MaterialApp(
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: ListenableBuilder(
                  listenable: c,
                  builder: (context, _) => ProjectSidebar(
                    controller: c,
                    onSelect: c.select,
                    needsHuman: (_) => 0,
                    onAddAgent: (_) {},
                    now: () => taskBoardNow,
                    readPullRequests: read,
                  ),
                ),
              ),
            ),
          );
          await tester.pump();
          await tester.pump();
          expect(tester.takeException(), isNull);
          expect(chip(1), findsOneWidget);
          await tester.pumpWidget(const SizedBox());
          c.dispose();
        },
      );
    }
  });

  group('the batched pull request reader', () {
    SidebarPullRequests reader({
      Future<Map<String, dynamic>> Function(List<String>)? read,
      Duration every = const Duration(milliseconds: 30),
      bool Function()? active,
    }) {
      final r = SidebarPullRequests(
        read: read,
        every: every,
        active: active ?? () => true,
      );
      addTearDown(r.dispose);
      return r;
    }

    String url(int n) => '$taskBoardRepo/$n';

    test('reads the links wanted once, in batches of fifty, and asks again only for what can still change', () async {
      final asked = <List<String>>[];
      final r = reader(
        every: const Duration(hours: 1),
        read: (urls) async {
          asked.add(urls);
          return pullRequestRows(urls, {
            for (var n = 1; n <= 60; n++) n: (n.isEven ? 'Merged' : 'Open', 5),
          });
        },
      );
      r.want({for (var n = 1; n <= 60; n++) url(n)});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(asked.map((a) => a.length), [50, 10]);
      expect(r.of(url(2))?.state, 'Merged');
      expect(r.of(url(1))?.state, 'Open');
      // A new link: the merged ones are final and are not read again.
      asked.clear();
      r.want({for (var n = 1; n <= 61; n++) url(n)});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(asked.expand((a) => a).toSet(), {
        for (var n = 1; n <= 61; n += 2) url(n),
      });
    });

    test('asks again after its interval while a pull request can change, and tells its listeners', () async {
      var open = 0;
      final r = reader(
        read: (urls) async => pullRequestRows(urls, {1: ('Open', ++open)}),
      );
      var told = 0;
      r.addListener(() => told++);
      r.want({url(1)});
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(open, greaterThan(2));
      expect(r.of(url(1))?.passed, open > 5 ? 5 : r.of(url(1))!.passed);
      expect(told, greaterThan(1));
    });

    test('stops for good when the reader is not there, and clears what it had on a signed-out login', () async {
      var calls = 0;
      var error = 'UNSUPPORTED';
      final r = reader(
        read: (urls) async {
          calls++;
          return {'error': error};
        },
      );
      r.want({url(1)});
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(r.unsupported, isTrue);
      expect(calls, 1);

      final signed = reader(
        read: (urls) async => error == 'GH_SIGNED_OUT'
            ? {'error': 'GH_SIGNED_OUT'}
            : pullRequestRows(urls, {1: ('Open', 3)}),
      );
      error = 'none';
      signed.want({url(1)});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(signed.of(url(1)), isNotNull);
      error = 'GH_SIGNED_OUT';
      await signed.refresh();
      expect(signed.of(url(1)), isNull);
      expect(signed.unsupported, isFalse);
    });

    test(
      'reads nothing while the window is not in front, or without a reader',
      () async {
        var calls = 0;
        var front = false;
        final r = reader(
          read: (urls) async {
            calls++;
            return pullRequestRows(urls, {1: ('Open', 1)});
          },
          active: () => front,
        );
        r.want({url(1)});
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(calls, 0);
        front = true;
        await r.refresh();
        expect(calls, 1);
        final none = reader();
        none.want({url(1)});
        await none.refresh();
        expect(none.of(url(1)), isNull);
      },
    );

    test('one read at a time; links that arrive during one are read right after it', () async {
      final gate = Completer<void>();
      final asked = <List<String>>[];
      final r = reader(
        every: const Duration(hours: 1),
        read: (urls) async {
          asked.add(urls);
          if (asked.length == 1) await gate.future;
          return pullRequestRows(urls, {1: ('Open', 1), 2: ('Open', 1)});
        },
      );
      r.want({url(1)});
      await Future<void>.delayed(const Duration(milliseconds: 10));
      r.want({url(1), url(2)});
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(asked, hasLength(1));
      gate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(asked, hasLength(2));
      expect(asked.last, containsAll([url(1), url(2)]));
    });
  });
}
