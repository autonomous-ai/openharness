import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/swarm_code_block.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard_reader.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_project_tasks.dart';
import 'package:harness_mobile/swarm/swarm_project_team.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The project screen of Tony's Swarm Home, direction C (2026-10-30): the
/// project's #name over its team line and its chat filling the screen, with
/// ☰ opening its Leaderboard and its Team as sheets.
void main() {
  const board = '/api/super-tabs/$tab/leaderboard?projectId=$project';

  /// One Swarm whose project Mobile has three people (the viewer, diego and
  /// ken) and four agents: River, the Product Manager; Nova at work on g1;
  /// Juno, whose work waits on a person; and Ash with none.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          agent('agent-juno', displayName: 'Juno'),
          agent('agent-ash', displayName: 'Ash'),
        ],
        groups: [
          groupData(
            'g1',
            title: 'Buddy chat header',
            number: 2156,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            workerId: 'agent-builder',
            lastMessageSequence: 3,
          ),
          groupData(
            'g2',
            title: 'Saved views cache',
            number: 2160,
            agentIds: ['agent-lead', 'agent-juno'],
            status: 'needs_human',
            workerId: 'agent-juno',
            lastMessageSequence: 4,
          ),
        ],
      ),
      'members': [
        part(me, 1, person(me)),
        part('diego', 1, {
          ...person('diego', role: 'collaborator'),
          'status': {'text': 'Reviewing PRs', 'emoji': '🎯'},
        }),
        part('ken', 1, {
          ...person('ken', role: 'collaborator'),
          'status': {
            'text': 'At lunch',
            'emoji': '🍽️',
            'until': '2026-10-01T05:00:00.000Z',
          },
        }),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
        (_) => {
          'messages': [
            {
              'id': 'msg-lead-1',
              'conversationId': leadChat,
              'text': 'CI on #2154 is green.',
              'sequence': 1,
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
              'createdAt': '2026-10-29T02:40:00.000Z',
            },
          ],
          'next': null,
        };
    fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
      'messages': [
        {
          'id': 'msg-g1-1',
          'conversationId': 'g1',
          'text': 'Header is in.',
          'sequence': 3,
          'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          'createdAt': '2026-10-29T02:50:00.000Z',
        },
      ],
      'next': null,
    };
    fake.routes[board] = (_) => leaderboardData(
      people: [
        scoreData(me, points: 1320, rank: 1, shipped: 6, unblocked: 3),
        scoreData('diego', points: 1050, rank: 2, lentMs: 10 * 3600000),
        scoreData('ken', points: 640, rank: 3),
      ],
    );
    return fake;
  }

  /// [home] under a signed-in shell's Swarm, with Swarm turned on; the
  /// phone keeps its read marks in [marks].
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake,
    Widget home, {
    bool settle = true,
    LocalKeyValueStore? marks,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: marks ?? MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      // A read held on its way: skeletons pulse until it answers.
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  const page = SwarmProjectPage(
    swarmId: tab,
    projectId: project,
    tabs: SwarmProjectTab.homeC,
  );

  /// The page with the sheet of its menu's row keyed [row] open.
  Future<SwarmHost> fromMenu(
    WidgetTester tester,
    FakeSwarm fake,
    String row,
  ) async {
    final host = await pump(tester, fake, page);
    await tester.tap(key('swarm-project-menu'));
    await tester.pumpAndSettle();
    await tester.tap(key(row));
    await tester.pumpAndSettle();
    return host;
  }

  /// The page with its Team sheet open.
  Future<SwarmHost> team(WidgetTester tester, FakeSwarm fake) =>
      fromMenu(tester, fake, 'swarm-project-menu-team');

  /// The page with its Leaderboard sheet open.
  Future<SwarmHost> leaderboard(WidgetTester tester, FakeSwarm fake) =>
      fromMenu(tester, fake, 'swarm-project-menu-leaderboard');

  /// The words of the row keyed [k], its rich text included.
  String said(WidgetTester tester, String k) => [
    for (final text in tester.widgetList<RichText>(
      find.descendant(of: key(k), matching: find.byType(RichText)),
    ))
      text.text.toPlainText(),
  ].join(' | ');

  /// How a screen reader says the row keyed [k].
  String heard(WidgetTester tester, String k) =>
      tester.getSemantics(key(k)).label;

  /// The [SwarmHost] a test's app is under.
  SwarmHost host(WidgetTester tester) =>
      tester.widget<SwarmScope>(find.byType(SwarmScope)).notifier!;

  /// [path] answers only once the returned gate is opened.
  Completer<void> hold(FakeSwarm fake, String path) {
    final gate = Completer<void>();
    final answer = fake.routes[path]!;
    fake.routes[path] = (body) async {
      await gate.future;
      return answer(body);
    };
    return gate;
  }

  /// The people on the Leaderboard sheet, top to bottom.
  List<String> onBoard(WidgetTester tester) {
    final rows = find.byWidgetPredicate(
      (w) => switch (w.key) {
        ValueKey<String>(:final value) => value.startsWith(
          'swarm-leaderboard-person-',
        ),
        _ => false,
      },
    );
    final found = rows.evaluate().map((e) => e.widget).toList()
      ..sort(
        (a, b) => tester
            .getTopLeft(find.byWidget(a))
            .dy
            .compareTo(tester.getTopLeft(find.byWidget(b)).dy),
      );
    return [
      for (final w in found)
        (w.key! as ValueKey<String>).value.substring(
          'swarm-leaderboard-person-'.length,
        ),
    ];
  }

  /// The texts of the row keyed [k] with a digit in them, its face aside.
  Finder figures(String k) => find.descendant(
    of: key(k),
    matching: find.textContaining(RegExp(r'\d'), findRichText: true),
  );

  group('Team, its tasks', () {
    /// The key of Juno's work in g2, waiting on the person.
    String workKey(WidgetTester tester) =>
        host(tester).session!.inbox.needs.whereType<SwarmWorkNeed>().single.key;

    /// The key of that work's row.
    String waitingKey(WidgetTester tester) =>
        'swarm-waiting-${workKey(tester)}';

    testWidgets('on top: what waits on the person, then what is worked on, '
        "in the Tasks tab's rows, under a caption each", (tester) async {
      await team(tester, backend());

      expect(said(tester, 'swarm-team-waiting-caption'), 'Waiting on you');
      expect(said(tester, 'swarm-team-working-caption'), 'Working on');
      final waiting = 'swarm-waiting-${workKey(tester)}';
      expect(key(waiting), findsOneWidget);
      expect(tester.widget(key(waiting)), isA<SwarmWaitingRow>());
      expect(tester.widget(key('swarm-task-g1')), isA<SwarmWorkRow>());
      expect(key('swarm-task-g2'), findsNothing, reason: 'it waits on you');
      expect(key('swarm-reply-${workKey(tester)}'), findsOneWidget);
      double y(String k) => tester.getTopLeft(key(k)).dy;
      final order = [
        y('swarm-team-waiting-caption'),
        y(waiting),
        y('swarm-team-working-caption'),
        y('swarm-task-g1'),
        y('swarm-team-agents-caption'),
      ];
      expect(order, [...order]..sort(), reason: 'Tasks first, waiting first');
      expect(find.text('Done today'), findsNothing, reason: 'open tasks only');
    });

    /// [backend] with River asking the person, in g2, whether to merge.
    FakeSwarm asked() {
      final fake = backend();
      const derived = {'decisionsWaiting': 1};
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async => {
        ...(await load(body))! as Map<String, dynamic>,
        'derived': derived,
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived);
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'projectName': 'Mobile',
            'conversationId': 'g2',
            'conversationTitle': 'Saved views cache',
            'askerName': 'River',
            'question': 'Merge #2160?',
            'options': ['Merge', 'Wait'],
          },
        ],
      };
      return fake;
    }

    testWidgets('Approve asks first, naming the answer, who asked, where and '
        'the question; confirmed, it is held for Undo and sent once', (
      tester,
    ) async {
      final fake = asked();
      await team(tester, fake);

      await tester.tap(key('swarm-approve-d1'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Sends “Merge” to River in #Mobile: Merge #2160?\n\n'
          'You can undo it for a few seconds.',
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-activity-approve-cancel'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(fake.commands, isEmpty, reason: 'Cancel sends nothing');

      await tester.tap(key('swarm-approve-d1'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-activity-approve-confirm'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-waiting-decision:d1'),
          matching: find.text('Sending “Merge”'),
        ),
        findsOneWidget,
      );
      expect(fake.commands, isEmpty, reason: 'Undo still can');
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 0,
      });
    });

    testWidgets('access taken away while Approve asks: confirming it then '
        'holds and sends nothing', (tester) async {
      final fake = asked();
      await team(tester, fake);

      await tester.tap(key('swarm-approve-d1'));
      await tester.pumpAndSettle();
      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      await tester.tap(key('swarm-activity-approve-confirm'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(find.byType(SwarmWaitingRow), findsNothing);
    });

    testWidgets('a task opens its chat', (tester) async {
      await team(tester, backend());

      await tester.tap(key('swarm-task-g1'));
      await tester.pumpAndSettle();

      expect(find.text('Header is in.'), findsOneWidget);
    });

    testWidgets('none open says so in a line, and finished work is not '
        'listed', (tester) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        return {
          ...read,
          'groups': [
            part(
              'g1',
              1,
              groupData(
                'g1',
                title: 'Buddy chat header',
                number: 2156,
                agentIds: ['agent-lead', 'agent-builder'],
                status: 'done',
                workerId: 'agent-builder',
              ),
            ),
          ],
        };
      };
      await team(tester, fake);

      expect(said(tester, 'swarm-team-working-caption'), 'Working on');
      expect(key('swarm-team-waiting-caption'), findsNothing);
      expect(key('swarm-team-no-tasks'), findsOneWidget);
      expect(find.text('No open tasks.'), findsOneWidget);
      expect(key('swarm-task-g1'), findsNothing);
    });

    /// [backend] with [count] tasks going on, g-0 the latest, besides what
    /// waits on the person.
    FakeSwarm manyTasks(int count) {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        final groups = read['groups'] as List;
        groups.removeWhere((g) => (g as Map)['key'] == 'g1');
        return {
          ...read,
          'groups': [
            ...groups,
            for (var i = 0; i < count; i++)
              part(
                'g-$i',
                1,
                groupData(
                  'g-$i',
                  title: 'Task $i',
                  number: 3000 + i,
                  agentIds: ['agent-lead', 'agent-builder'],
                  status: 'working',
                  workerId: 'agent-builder',
                  lastMessageSequence: 100 - i,
                ),
              ),
          ],
        };
      };
      return fake;
    }

    Finder workRows() => find.byType(SwarmWorkRow);

    /// A view tall enough that the list builds every row.
    void tall(WidgetTester tester) {
      tester.view
        ..physicalSize = const Size(800, 3000)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }

    testWidgets('shows five of the work going on, and See all shows the rest '
        'in place, above the agents', (tester) async {
      tall(tester);
      await team(tester, manyTasks(8));

      expect(key(waitingKey(tester)), findsOneWidget, reason: 'not capped');
      expect(workRows(), findsNWidgets(5));
      for (var i = 0; i < 5; i++) {
        expect(key('swarm-task-g-$i'), findsOneWidget, reason: 'latest first');
      }
      expect(key('swarm-task-g-5'), findsNothing);
      final seeAll = key('swarm-team-see-all');
      expect(find.text('See all 8 tasks'), findsOneWidget);
      expect(
        tester.getSize(seeAll).height,
        greaterThanOrEqualTo(minTouchTarget),
      );
      double y(String k) => tester.getTopLeft(key(k)).dy;
      expect(y('swarm-task-g-4'), lessThan(y('swarm-team-see-all')));
      expect(
        y('swarm-team-see-all'),
        lessThan(y('swarm-team-agents-caption')),
        reason: 'the agents are a short way down, however many tasks',
      );

      await tester.tap(seeAll);
      await tester.pumpAndSettle();

      expect(workRows(), findsNWidgets(8));
      expect(find.byType(SwarmProjectTeamSheet), findsOneWidget);
      expect(find.text('Show fewer'), findsOneWidget);
      expect(find.text('See all 8 tasks'), findsNothing);

      await tester.tap(seeAll);
      await tester.pumpAndSettle();
      expect(workRows(), findsNWidgets(5), reason: 'it folds again');
    });

    testWidgets('five or fewer have no See all', (tester) async {
      await team(tester, manyTasks(5));

      expect(workRows(), findsNWidgets(5));
      expect(key('swarm-team-see-all'), findsNothing);
    });

    testWidgets('See all stays open when the Swarm is read again, and over a '
        'task opened from it and back', (tester) async {
      tall(tester);
      final fake = manyTasks(8);
      await team(tester, fake);
      await tester.tap(key('swarm-team-see-all'));
      await tester.pumpAndSettle();
      expect(workRows(), findsNWidgets(8));

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            'g-0',
            9,
            groupData(
              'g-0',
              title: 'Task 0, renamed',
              number: 3000,
              agentIds: ['agent-lead', 'agent-builder'],
              status: 'working',
              workerId: 'agent-builder',
              lastMessageSequence: 200,
            ),
          ),
        ],
      );
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(find.textContaining('Task 0, renamed'), findsWidgets);
      expect(workRows(), findsNWidgets(8), reason: 'a read folds nothing');

      await tester.tap(key('swarm-task-g-1'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectTeamSheet, skipOffstage: false), findsOne);
      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmProjectTeamSheet), findsOneWidget);
      expect(workRows(), findsNWidgets(8), reason: 'back, as it was');
    });

    testWidgets('lists no humans: they are on the Leaderboard, and its board '
        'is not read for the Team', (tester) async {
      final fake = backend();
      await team(tester, fake);

      expect(find.text('Humans'), findsNothing);
      expect(fake.paths.where((p) => p.contains('/leaderboard')), isEmpty);
      for (final id in ['person-me', 'diego', 'ken']) {
        expect(key('swarm-member-person-$id'), findsNothing, reason: id);
      }
    });
  });

  group('the Leaderboard sheet', () {
    testWidgets("this project's humans by this week's points, most first, "
        'without ranks: the name, a line of what they did this week and the '
        'points at the right', (tester) async {
      final fake = backend();
      await leaderboard(tester, fake);

      expect(find.text('Leaderboard'), findsOneWidget);
      expect(find.text('This week'), findsOneWidget);
      expect(key('swarm-leaderboard-close'), findsOneWidget);
      expect(onBoard(tester), ['person-me', 'diego', 'ken']);
      expect(
        heard(tester, 'swarm-leaderboard-person-person-me'),
        'person-me, 1320 points, 6 shipped, 3 unblocked',
      );
      expect(
        heard(tester, 'swarm-leaderboard-person-diego'),
        'diego, 1050 points, 10 hours lent',
      );
      expect(
        heard(tester, 'swarm-leaderboard-person-ken'),
        'ken, 640 points',
        reason: 'no zeros',
      );
      expect(
        find.byKey(const ValueKey('swarm-leaderboard-rank-diego')),
        findsNothing,
        reason: 'no rank numbers',
      );
      Finder points(String id) => key('swarm-leaderboard-points-$id');
      expect(
        tester.getTopRight(points('diego')).dx,
        tester.getTopRight(points('ken')).dx,
        reason: 'the points line up',
      );
      expect(fake.paths.where((p) => p == board).length, 1);
      expect(
        fake.paths.where(
          (p) => p.contains('/leaderboard') && !p.startsWith(board),
        ),
        isEmpty,
        reason: "this project's board, and no other",
      );
    });

    testWidgets(
      'its top line fits at 320 wide, with a finger for each control',
      (tester) async {
        tester.view
          ..physicalSize = const Size(320, 640)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        await leaderboard(tester, backend());

        expect(tester.takeException(), isNull);
        for (final k in ['swarm-leaderboard-close', 'swarm-leaderboard-week']) {
          final size = tester.getSize(key(k));
          expect(size.height, greaterThanOrEqualTo(minTouchTarget), reason: k);
          expect(size.width, greaterThanOrEqualTo(minTouchTarget), reason: k);
        }
      },
    );

    testWidgets('equal points, and none, go by name', (tester) async {
      final fake = backend();
      fake.routes[board] = (_) => leaderboardData(
        people: [
          scoreData('ken', points: 40, rank: 1),
          scoreData('diego', points: 40, rank: 1),
        ],
      );
      await leaderboard(tester, fake);

      expect(onBoard(tester), ['diego', 'ken', 'person-me']);
      expect(
        heard(tester, 'swarm-leaderboard-person-person-me'),
        'person-me',
        reason: 'the board does not list them: no points are made up',
      );
    });

    testWidgets('the week picker reads the week picked, for this project, and '
        'says so', (tester) async {
      final fake = backend();
      await leaderboard(tester, fake);

      await tester.tap(key('swarm-leaderboard-week'));
      await tester.pumpAndSettle();
      fake.routes.addAll({
        for (var back = 1; back < 4; back++)
          '$board&week=${swarmWeekOf(DateTime.now()) - back * swarmWeekMs}': (
            _,
          ) => leaderboardData(people: [scoreData('ken', points: 7, rank: 1)]),
      });
      await tester.tap(key('swarm-leaderboard-week-1'));
      await tester.pumpAndSettle();

      expect(find.text('Last week'), findsOneWidget);
      expect(onBoard(tester).first, 'ken');
      expect(
        fake.paths.where((p) => p.startsWith('$board&week=')),
        hasLength(1),
      );
    });

    testWidgets('a row opens their week', (tester) async {
      await leaderboard(tester, backend());

      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-sheet'), findsOneWidget);
    });

    testWidgets('a private project lists only the people who read it', (
      tester,
    ) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        final head = (read['head'] as Map)['data'] as Map<String, dynamic>;
        final mobile = (head['projects'] as List).single as Map;
        mobile['visibility'] = 'private';
        mobile['members'] = [
          {'id': 'diego', 'generation': 'gen-diego'},
        ];
        return read;
      };
      await leaderboard(tester, fake);

      expect(onBoard(tester), ['person-me', 'diego']);
    });

    testWidgets('while the board is read, the people show at once by name, '
        'never a Loading that stays, and take its order when it answers', (
      tester,
    ) async {
      final fake = backend();
      final gate = hold(fake, board);
      await leaderboard(tester, fake);

      expect(onBoard(tester), ['diego', 'ken', 'person-me']);
      expect(find.textContaining('Loading'), findsNothing);
      for (final id in ['person-me', 'diego', 'ken']) {
        expect(
          figures('swarm-leaderboard-person-$id'),
          findsNothing,
          reason: 'no points nor numbers before the board answers: $id',
        );
      }

      gate.complete();
      await tester.pumpAndSettle();
      expect(onBoard(tester), ['person-me', 'diego', 'ken']);
    });

    testWidgets('a first read that fails says so, and Try again recovers it, '
        'with one read', (tester) async {
      final fake = backend();
      final answer = fake.routes[board]!;
      fake.routes[board] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Board is down.');
      await leaderboard(tester, fake);

      expect(find.text('Board is down.'), findsOneWidget);
      expect(onBoard(tester), contains('diego'));
      expect(find.textContaining('Loading'), findsNothing);
      final reads = fake.paths.where((p) => p == board).length;

      fake.routes[board] = answer;
      await tester.tap(key('swarm-leaderboard-retry'));
      await tester.pumpAndSettle();

      expect(fake.paths.where((p) => p == board).length, reads + 1);
      expect(find.text('Board is down.'), findsNothing);
      expect(onBoard(tester), ['person-me', 'diego', 'ken']);
      expect(figures('swarm-leaderboard-person-diego'), findsWidgets);
    });

    testWidgets('a pull reads the board and the Swarm, once each', (
      tester,
    ) async {
      final fake = backend();
      await leaderboard(tester, fake);
      int count(String path) =>
          fake.paths.where((p) => p.startsWith(path)).length;
      final boards = count(board);
      const swarm = '/api/super-tabs/$tab/changes';
      final reads = count(swarm);

      await tester.fling(
        key('swarm-leaderboard-person-diego'),
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      expect(count(board), boards + 1);
      expect(count(swarm), reads + 1);
      expect(find.byType(SwarmLeaderboardPage), findsOneWidget, reason: 'open');
    });

    testWidgets('a server with no board says so, and its people still show', (
      tester,
    ) async {
      final fake = backend();
      fake.routes[board] = (_) =>
          throw const SuperTabFailure('NOT_FOUND', 'Nope.', statusCode: 404);
      await leaderboard(tester, fake);

      expect(key('swarm-leaderboard-unavailable'), findsOneWidget);
      expect(onBoard(tester), ['diego', 'ken', 'person-me']);
    });

    testWidgets('the board answer that lands after the sheet closed changes '
        'nothing, and opening it again reads it anew', (tester) async {
      final fake = backend();
      final gate = hold(fake, board);
      await leaderboard(tester, fake);

      await tester.tap(key('swarm-leaderboard-close'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmLeaderboardPage), findsNothing);
      final reads = fake.paths.where((p) => p == board).length;
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.text('1320'), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-leaderboard'));
      await tester.pumpAndSettle();
      expect(fake.paths.where((p) => p == board).length, reads + 1);
      expect(find.text('1320'), findsOneWidget);
    });

    testWidgets('access taken away while it is open closes it, and the board '
        'answer on its way is dropped', (tester) async {
      final fake = backend();
      final gate = hold(fake, board);
      await leaderboard(tester, fake);
      expect(onBoard(tester), isNotEmpty);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmLeaderboardPage), findsNothing);
      expect(onBoard(tester), isEmpty);
      expect(find.text('diego'), findsNothing);
      expect(
        find.text('This project is no longer in the Swarm.'),
        findsOneWidget,
      );
    });
  });

  group('Team, its agents', () {
    testWidgets('each in its state with the task it holds, the most urgent '
        'first, with what needs a look counted', (tester) async {
      await team(tester, backend());

      expect(
        said(tester, 'swarm-team-agents-caption'),
        'Agents | 1 needs input · 1 working',
      );
      double y(String id) => tester.getTopLeft(key('swarm-member-$id')).dy;
      expect(
        [
          for (final id in ['agent-juno', 'agent-builder', 'agent-ash'])
            y(id) < y('agent-lead'),
        ],
        [true, true, true],
      );
      expect(y('agent-juno'), lessThan(y('agent-builder')));
      expect(y('agent-builder'), lessThan(y('agent-ash')));
      expect(
        heard(tester, 'swarm-member-agent-juno'),
        'Juno, Needs input · #2160 Saved views cache',
      );
      expect(
        heard(tester, 'swarm-member-agent-builder'),
        'Nova, Working · #2156 Buddy chat header',
      );
      expect(heard(tester, 'swarm-member-agent-ash'), 'Ash, Idle');
      for (final id in ['agent-juno', 'agent-builder', 'agent-ash']) {
        expect(
          tester.getSize(key('swarm-member-$id')).height,
          greaterThanOrEqualTo(minTouchTarget),
          reason: id,
        );
      }
    });

    testWidgets('a row opens the task its agent holds', (tester) async {
      await team(tester, backend());

      // Under the Tasks.
      await tester.ensureVisible(key('swarm-member-agent-builder'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-member-agent-builder'));
      await tester.pumpAndSettle();

      expect(find.text('Header is in.'), findsOneWidget);
    });
  });

  group('the project screen', () {
    testWidgets('its #name over the humans, the agents and who is working', (
      tester,
    ) async {
      await pump(tester, backend(), page);

      expect(
        tester.widget<Text>(key('swarm-title')).data,
        '#Mobile',
        reason: 'a channel name, as Slack writes one',
      );
      expect(
        find.descendant(
          of: key('swarm-project-team-line'),
          matching: find.textContaining(
            '3 humans · 4 agents · ● 1 working',
            findRichText: true,
          ),
        ),
        findsOneWidget,
      );
    });

    testWidgets('one human and one agent are said so', (tester) async {
      final fake = backend();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          agents: [agent('agent-lead', name: 'Lead', displayName: 'River')],
        ),
        'members': [part(me, 1, person(me))],
      };
      await pump(tester, fake, page);

      expect(
        find.descendant(
          of: key('swarm-project-team-line'),
          matching: find.textContaining(
            '1 human · 1 agent · All idle',
            findRichText: true,
          ),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a private project counts only the people who read it', (
      tester,
    ) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        final head = (read['head'] as Map)['data'] as Map<String, dynamic>;
        final mobile = (head['projects'] as List).single as Map;
        mobile['visibility'] = 'private';
        mobile['members'] = [
          {'id': 'diego', 'generation': 'gen-diego'},
        ];
        return read;
      };
      await pump(tester, fake, page);

      expect(
        find.descendant(
          of: key('swarm-project-team-line'),
          matching: find.textContaining(
            '2 humans · 4 agents',
            findRichText: true,
          ),
        ),
        findsOneWidget,
        reason: 'its owner (the viewer) and diego; ken does not read it',
      );
    });

    testWidgets('has no tab bar: its chat fills the screen under its header', (
      tester,
    ) async {
      await pump(tester, backend(), page);

      expect(find.byType(SwarmProjectTabBar), findsNothing);
      for (final name in ['chat', 'buddy', 'tasks', 'leaderboard', 'team']) {
        expect(key('swarm-project-tab-$name'), findsNothing, reason: name);
      }
      expect(find.text('CI on #2154 is green.'), findsOneWidget);
      expect(
        tester.getTopLeft(key('swarm-project-body-chat')).dy,
        tester.getBottomLeft(find.byType(SwarmTopBar)).dy,
      );
      expect(
        tester.getBottomLeft(key('swarm-project-body-chat')).dy,
        tester.getSize(find.byType(SwarmProjectPage)).height,
      );
      expect(
        key('swarm-project-team'),
        findsNothing,
        reason: "direction B's team button",
      );
    });

    testWidgets('☰ at the end of the header, a finger wide and tall, says '
        'Menu, and opens Leaderboard and Team on the menu surface', (
      tester,
    ) async {
      await pump(tester, backend(), page);

      final button = key('swarm-project-menu');
      final size = tester.getSize(button);
      expect(size.width, greaterThanOrEqualTo(minTouchTarget));
      expect(size.height, greaterThanOrEqualTo(minTouchTarget));
      expect(heard(tester, 'swarm-project-menu'), 'Menu');
      expect(
        tester.getTopRight(button).dx,
        greaterThan(tester.getTopRight(key('swarm-title')).dx),
        reason: 'at the end of the header',
      );
      expect(find.text('Leaderboard'), findsNothing);

      await tester.tap(button);
      await tester.pumpAndSettle();

      expect(find.text('Leaderboard'), findsOneWidget);
      expect(find.text('Team'), findsOneWidget);
      for (final row in ['leaderboard', 'team']) {
        expect(
          tester.getSize(key('swarm-project-menu-$row')).height,
          greaterThanOrEqualTo(minTouchTarget),
          reason: row,
        );
      }
      expect(
        tester.widget<MenuAnchor>(find.byType(MenuAnchor)).style,
        isNull,
        reason: "the theme's menu surface, AppMenu's, not one of its own",
      );

      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(find.text('Leaderboard'), findsNothing, reason: 'it closes');
    });

    for (final (row, closeKey, title) in [
      ('leaderboard', 'swarm-leaderboard-close', 'Leaderboard'),
      ('team', 'swarm-team-close', 'Team'),
    ]) {
      testWidgets('$row opens as a sheet over the chat, with ✕ and a top '
          'radius of 12; ✕ is back on the chat', (tester) async {
        await fromMenu(tester, backend(), 'swarm-project-menu-$row');

        expect(find.byType(BottomSheet), findsOneWidget);
        expect(find.text(title), findsOneWidget);
        expect(key('swarm-project-menu-$row'), findsNothing, reason: 'closed');
        final sheet = tester.widget<BottomSheet>(find.byType(BottomSheet));
        expect(
          (sheet.shape! as RoundedRectangleBorder).borderRadius,
          const BorderRadius.vertical(top: Radius.circular(12)),
        );
        final close = tester.getSize(key(closeKey));
        expect(close.height, greaterThanOrEqualTo(minTouchTarget));
        expect(close.width, greaterThanOrEqualTo(minTouchTarget));

        await tester.tap(key(closeKey));
        await tester.pumpAndSettle();

        expect(find.byType(BottomSheet), findsNothing);
        expect(find.text('CI on #2154 is green.'), findsOneWidget);
        expect(key('swarm-project-body-chat'), findsOneWidget);
      });
    }

    testWidgets('the four tabs of direction B stay as they were', (
      tester,
    ) async {
      await pump(
        tester,
        backend(),
        const SwarmProjectPage(
          swarmId: tab,
          projectId: project,
          tabs: SwarmProjectTab.homeB,
        ),
      );

      for (final name in ['chat', 'buddy', 'tasks', 'leaderboard']) {
        expect(key('swarm-project-tab-$name'), findsOneWidget, reason: name);
      }
      expect(key('swarm-project-tab-team'), findsNothing);
      expect(key('swarm-project-menu'), findsNothing);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(key('swarm-project-team'), findsOneWidget);
    });
  });

  group('Chat, its New messages line and Jump to latest', () {
    /// River's message [sequence] in the project's chat, [author] another's.
    Map<String, dynamic> said(
      int sequence, {
      String author = 'agent-lead',
      String kind = 'agent',
      String? text,
    }) => {
      'id': 'msg-$sequence',
      'conversationId': leadChat,
      'text': text ?? 'Update $sequence.',
      'sequence': sequence,
      'author': {'kind': kind, 'id': author, 'name': author},
      'createdAt': DateTime.utc(2026, 10, 29, 2, sequence).toIso8601String(),
    };

    /// [backend] whose project chat holds [messages], read through [mark]
    /// on some device (the server's mark, #2131), [older] ones before them.
    FakeSwarm chat(
      List<Map<String, dynamic>> messages, {
      required int mark,
      bool older = false,
    }) {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        ((read['groups'] as List).first as Map)['data']['lastMessageSequence'] =
            messages.last['sequence'];
        return {
          ...read,
          'derived': {
            'readMarks': {leadChat: mark},
          },
        };
      };
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': messages,
            'next': older
                ? {'sequence': messages.first['sequence'], 'id': 'msg-older'}
                : null,
          };
      return fake;
    }

    final line = key('swarm-new-messages-line');

    /// The read marks sent for the project's chat, in order.
    List<Object?> marksSent(FakeSwarm fake) => [
      for (final call in fake.calls)
        if (call.method == 'POST' &&
            call.path == '/api/super-tabs/$tab/conversations/$leadChat/read')
          call.body?['sequence'],
    ];

    /// Whether [f] is drawn inside the chat's list, not scrolled out of it.
    bool onScreen(WidgetTester tester, Finder f) {
      if (f.evaluate().isEmpty) return false;
      final list = tester.getRect(key('swarm-messages'));
      final row = tester.getRect(f);
      return row.top >= list.top && row.bottom <= list.bottom;
    }

    testWidgets('sits above the first message the person has not read, from '
        'someone else, and says so in words', (tester) async {
      await pump(
        tester,
        chat([for (var i = 1; i <= 4; i++) said(i)], mark: 2),
        page,
      );

      expect(line, findsOneWidget);
      expect(find.text('New messages'), findsOneWidget);
      expect(tester.getSemantics(line).label, 'New messages');
      final y = tester.getTopLeft(line).dy;
      expect(tester.getTopLeft(find.text('Update 2.')).dy, lessThan(y));
      expect(tester.getTopLeft(find.text('Update 3.')).dy, greaterThan(y));
    });

    testWidgets("passes over the person's own messages; their own newest "
        'reads what came before it', (tester) async {
      await pump(
        tester,
        chat([
          said(1),
          said(2),
          said(3, author: me, kind: 'person', text: 'On it.'),
        ], mark: 1),
        page,
      );

      expect(line, findsNothing);
    });

    testWidgets('is placed once: a message that comes later and the mark '
        'moving on leave it where it was', (tester) async {
      final fake = chat([for (var i = 1; i <= 3; i++) said(i)], mark: 1);
      await pump(tester, fake, page);
      expect(
        tester.getTopLeft(find.text('Update 2.')).dy,
        greaterThan(tester.getTopLeft(line).dy),
      );

      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [for (var i = 1; i <= 4; i++) said(i)],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            leadChat,
            9,
            groupData(
              leadChat,
              title: 'Mobile',
              agentIds: ['agent-lead'],
              leadId: 'agent-lead',
              lastMessageSequence: 4,
            ),
          ),
        ],
      );
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(find.text('Update 4.'), findsOneWidget);
      expect(line, findsOneWidget);
      final y = tester.getTopLeft(line).dy;
      expect(tester.getTopLeft(find.text('Update 1.')).dy, lessThan(y));
      expect(tester.getTopLeft(find.text('Update 2.')).dy, greaterThan(y));
    });

    testWidgets("the phone's marks read back after the chat's first read: "
        'nothing is read meanwhile, and the line is still placed', (
      tester,
    ) async {
      final marks = _SlowMarks();
      final fake = chat([for (var i = 1; i <= 3; i++) said(i)], mark: 1);
      await pump(tester, fake, page, marks: marks);
      expect(find.text('Update 3.'), findsOneWidget);
      expect(line, findsNothing);
      expect(marksSent(fake), isEmpty, reason: 'held until the line is placed');

      marks.back.complete();
      await tester.pumpAndSettle();

      expect(line, findsOneWidget);
      final y = tester.getTopLeft(line).dy;
      expect(tester.getTopLeft(find.text('Update 1.')).dy, lessThan(y));
      expect(tester.getTopLeft(find.text('Update 2.')).dy, greaterThan(y));
      // The mark is written once this frame's work is done.
      await tester.pump(Duration.zero);
      expect(marksSent(fake), [3], reason: 'the line on screen: all is read');
    });

    testWidgets('a chat never read anywhere, or one read through its end, '
        'has none', (tester) async {
      await pump(tester, chat([said(1), said(2)], mark: 2), page);
      expect(line, findsNothing);
    });

    testWidgets('more unread than one read reaches has none, and opens at '
        'the foot as before', (tester) async {
      await pump(
        tester,
        chat([for (var i = 10; i <= 12; i++) said(i)], mark: 2, older: true),
        page,
      );

      expect(line, findsNothing);
      expect(onScreen(tester, find.text('Update 12.')), isTrue);
    });

    testWidgets('above the screen, the chat opens at it, and what is below '
        'is read only once the person goes down to it', (tester) async {
      final fake = chat([for (var i = 1; i <= 40; i++) said(i)], mark: 5);
      await pump(tester, fake, page);

      expect(onScreen(tester, line), isTrue, reason: 'opened at the line');
      expect(onScreen(tester, find.text('Update 6.')), isTrue);
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(
        marksSent(fake).where((s) => (s! as int) > 5),
        isEmpty,
        reason: 'nothing past the line is read yet',
      );

      await tester.fling(key('swarm-messages'), const Offset(0, -6000), 4000);
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(marksSent(fake).last, 40);
    });

    testWidgets('a message that comes under a sheet is not read until the '
        'sheet closes, and the line and Jump to latest stay', (tester) async {
      final fake = chat([for (var i = 1; i <= 40; i++) said(i)], mark: 40);
      await pump(tester, fake, page);
      await tester.drag(key('swarm-messages'), const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(key('swarm-jump-latest'), findsOneWidget);
      await tester.tap(key('swarm-jump-latest'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-team'));
      await tester.pumpAndSettle();
      final sent = marksSent(fake).length;

      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [for (var i = 1; i <= 41; i++) said(i)],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            leadChat,
            9,
            groupData(
              leadChat,
              title: 'Mobile',
              agentIds: ['agent-lead'],
              leadId: 'agent-lead',
              lastMessageSequence: 41,
            ),
          ),
        ],
      );
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 2));
      expect(marksSent(fake).length, sent, reason: 'under the sheet');

      await tester.tap(key('swarm-team-close'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 2));
      expect(marksSent(fake).last, 41, reason: 'seen once it closed');

      await tester.drag(key('swarm-messages'), const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(key('swarm-jump-latest'), findsOneWidget);
    });

    testWidgets('the New messages line is still there after a sheet opened '
        'and closed', (tester) async {
      await pump(
        tester,
        chat([for (var i = 1; i <= 4; i++) said(i)], mark: 2),
        page,
      );
      expect(line, findsOneWidget);

      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-leaderboard'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-leaderboard-close'));
      await tester.pumpAndSettle();

      expect(line, findsOneWidget);
      final y = tester.getTopLeft(line).dy;
      expect(tester.getTopLeft(find.text('Update 2.')).dy, lessThan(y));
      expect(tester.getTopLeft(find.text('Update 3.')).dy, greaterThan(y));
    });

    testWidgets('reading more than a screen back, Jump to latest takes the '
        'person to the foot; a little way back, none', (tester) async {
      await pump(
        tester,
        chat([for (var i = 1; i <= 40; i++) said(i)], mark: 40),
        page,
      );
      final jump = key('swarm-jump-latest');
      expect(line, findsNothing);
      expect(jump, findsNothing, reason: 'at the foot');

      await tester.drag(key('swarm-messages'), const Offset(0, 120));
      await tester.pumpAndSettle();
      expect(jump, findsNothing, reason: 'not a screen back');

      await tester.drag(key('swarm-messages'), const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(jump, findsOneWidget);
      expect(find.text('Jump to latest'), findsOneWidget);
      expect(tester.getSemantics(jump).label, 'Jump to latest');
      expect(tester.getSize(jump).height, greaterThanOrEqualTo(minTouchTarget));

      await tester.tap(jump);
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(jump, findsNothing);
    });

    testWidgets('far back, what came meanwhile is counted in its place', (
      tester,
    ) async {
      final fake = chat([for (var i = 1; i <= 40; i++) said(i)], mark: 40);
      await pump(tester, fake, page);
      await tester.drag(key('swarm-messages'), const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(key('swarm-jump-latest'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [for (var i = 1; i <= 41; i++) said(i)],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            leadChat,
            9,
            groupData(
              leadChat,
              title: 'Mobile',
              agentIds: ['agent-lead'],
              leadId: 'agent-lead',
              lastMessageSequence: 41,
            ),
          ),
        ],
      );
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-new-pill'), findsOneWidget);
      expect(find.text('1 new'), findsOneWidget);
      expect(key('swarm-jump-latest'), findsNothing);
    });

    testWidgets("direction B's chat has none", (tester) async {
      await pump(
        tester,
        chat([for (var i = 1; i <= 4; i++) said(i)], mark: 2),
        const SwarmProjectPage(
          swarmId: tab,
          projectId: project,
          tabs: SwarmProjectTab.homeB,
        ),
      );

      expect(find.text('Update 4.'), findsOneWidget);
      expect(line, findsNothing);
    });

    testWidgets("direction B's chat offers no Jump to latest", (tester) async {
      await pump(
        tester,
        chat([for (var i = 1; i <= 40; i++) said(i)], mark: 40),
        const SwarmProjectPage(
          swarmId: tab,
          projectId: project,
          tabs: SwarmProjectTab.homeB,
        ),
      );
      await tester.drag(key('swarm-messages'), const Offset(0, 1500));
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(key('swarm-jump-latest'), findsNothing);
    });
  });

  group('Chat, its messages', () {
    const pr = 'https://github.com/example/app/pull/7';

    /// A message of the project's chat; [thread] its own id by default.
    Map<String, dynamic> said(
      String id,
      int sequence,
      String text, {
      String author = 'agent-lead',
      Map<String, List<(String, String)>> reactions = const {},
    }) => {
      'id': id,
      'conversationId': leadChat,
      'text': text,
      'sequence': sequence,
      'thread': id,
      'author': {
        'kind': 'agent',
        'id': author,
        'name': author == 'agent-lead' ? 'River' : 'Nova',
      },
      'reactions': [
        for (final MapEntry(key: emoji, value: by) in reactions.entries)
          {
            'emoji': emoji,
            'count': by.length,
            'by': [
              for (final (kind, who) in by) {'kind': kind, 'id': who},
            ],
          },
      ],
      'createdAt': DateTime.utc(2026, 10, 29, 2, sequence).toIso8601String(),
    };

    /// The project's chat: River's brief, a task card; Nova's Opened, a PR
    /// card; a code block; reactions 👀 ✅ 🚀; and a root with 3 replies.
    FakeSwarm talk() {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        final lead = ((read['groups'] as List).first as Map)['data'] as Map;
        lead
          ..['lastMessageSequence'] = 5
          ..['number'] = 12
          ..['pullRequestUrls'] = [pr]
          ..['cards'] = {
            'task': 'm1',
            'pullRequests': [
              {'url': pr, 'messageId': 'm2'},
            ],
          };
        return read;
      };
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [
              said('m1', 1, 'Brief: the project screen.'),
              said('m2', 2, 'Opened $pr', author: 'agent-builder'),
              said(
                'm3',
                3,
                'Run this:\n```bash\nflutter test test/swarm\n```',
                author: 'agent-builder',
              ),
              said(
                'm4',
                4,
                'Shipped.',
                reactions: {
                  'eyes': [('person', me), ('person', 'diego')],
                  'check': [('person', 'diego')],
                  'rocket': [('agent', 'agent-builder')],
                },
              ),
              said('m5', 5, 'Which header?'),
            ],
            'threads': [
              {
                'id': 'm5',
                'replies': 3,
                'lastSequence': 8,
                'lastAt': DateTime.utc(2026, 10, 29, 2, 8).toIso8601String(),
                'authors': [
                  {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
                ],
                'people': <String>[],
              },
            ],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
        'result': <String, dynamic>{},
      };
      return fake;
    }

    Finder inside(String k, Finder f) =>
        find.descendant(of: key(k), matching: f);

    testWidgets('a task card and a PR card, in place of their messages', (
      tester,
    ) async {
      await pump(tester, talk(), page);

      // The oldest, above the screen.
      for (final card in ['swarm-card-m2', 'swarm-card-m1']) {
        await tester.dragUntilVisible(
          key(card),
          key('swarm-messages'),
          const Offset(0, 200),
        );
        await tester.pumpAndSettle();
      }
      expect(key('swarm-card-m1'), findsOneWidget, reason: 'the task card');
      expect(key('swarm-card-m2'), findsOneWidget, reason: 'the PR card');
      expect(
        inside('swarm-card-m2', find.textContaining('#7', findRichText: true)),
        findsWidgets,
      );
    });

    testWidgets('a code block, with Copy', (tester) async {
      await pump(tester, talk(), page);

      expect(find.byType(SwarmCodeBlock), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SwarmCodeBlock),
          matching: find.textContaining('flutter test test/swarm'),
        ),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel(RegExp('Copy')), findsWidgets);
    });

    testWidgets('reactions 👀 ✅ 🚀, each a finger to tap, the add-reaction '
        'chip after them, and a pick from it is sent', (tester) async {
      final fake = talk();
      await pump(tester, fake, page);

      for (final (emoji, count) in [('eyes', 2), ('check', 1), ('rocket', 1)]) {
        final chip = key('swarm-reaction-m4-$emoji');
        expect(chip, findsOneWidget, reason: emoji);
        final size = tester.getSize(chip);
        expect(
          size.height,
          greaterThanOrEqualTo(minTouchTarget),
          reason: emoji,
        );
        expect(size.width, greaterThanOrEqualTo(minTouchTarget), reason: emoji);
        expect(
          inside('swarm-reaction-m4-$emoji', find.text('$count')),
          findsOneWidget,
        );
      }
      expect(find.text('👍'), findsNothing);
      final add = key('swarm-add-reaction-m4');
      expect(add, findsOneWidget);
      expect(tester.getSize(add).height, greaterThanOrEqualTo(minTouchTarget));
      expect(tester.getSize(add).width, greaterThanOrEqualTo(minTouchTarget));
      expect(tester.getSemantics(add).label, 'Add reaction');
      expect(
        tester.getTopLeft(add).dx,
        greaterThan(tester.getTopLeft(key('swarm-reaction-m4-rocket')).dx),
        reason: 'after the counts',
      );
      expect(
        key('swarm-add-reaction-m1'),
        findsNothing,
        reason: 'only where there are reactions',
      );

      await tester.tap(add);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-react-tada'));
      await tester.pumpAndSettle();

      expect(fake.commands.where((c) => c['type'] == 'message.react').single, {
        'type': 'message.react',
        'conversationId': leadChat,
        'messageId': 'm4',
        'emoji': 'tada',
        'on': true,
      });
    });

    testWidgets("a root's replies in one row, which opens its thread", (
      tester,
    ) async {
      final fake = talk();
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'
          '?thread=m5'] = (_) => {
        'messages': [
          {
            ...said('m8', 8, 'The one on Home C.', author: 'agent-builder'),
            'thread': 'm5',
            'replyTo': 'm5',
          },
          said('m5', 5, 'Which header?'),
        ],
        'next': null,
      };
      await pump(tester, fake, page);

      final line = key('swarm-thread-line-m5');
      expect(
        inside('swarm-thread-line-m5', find.text('3 replies')),
        findsOneWidget,
      );
      expect(tester.getSize(line).height, greaterThanOrEqualTo(minTouchTarget));
      expect(key('swarm-thread-line-m4'), findsNothing, reason: 'no replies');

      await tester.tap(line);
      await tester.pumpAndSettle();

      expect(
        inside('swarm-thread-messages', find.text('Which header?')),
        findsOneWidget,
      );
      expect(
        inside('swarm-thread-messages', find.text('The one on Home C.')),
        findsOneWidget,
      );
    });
  });

  group('its privacy edges', () {
    const desktop = 'project-2';
    const messages = '/api/super-tabs/$tab/conversations/$leadChat/messages';

    /// [backend] whose Swarm has a second project, Desktop, the person reads
    /// too: Ash, Mobile's agent, still holds work there; another agent named
    /// Nova waits on the person there; and Mobile has the person's Buddy chat
    /// with Pip.
    FakeSwarm twoProjects() {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        final head = (read['head'] as Map)['data'] as Map;
        head['projects'] = [
          ...head['projects'] as List,
          {
            'id': desktop,
            'name': 'Desktop',
            'ownerId': me,
            'leadConversationId': 'group-lead-2',
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 5,
          },
        ];
        Map<String, dynamic> there(Map<String, dynamic> g) => {
          ...g,
          'projectId': desktop,
        };
        read['agents'] = [
          ...read['agents'] as List,
          part('agent-nova-2', 1, {
            ...agent('agent-nova-2', displayName: 'Nova'),
            'projectId': desktop,
          }),
          part('buddy-pip', 1, buddyData('buddy-pip', displayName: 'Pip')),
        ];
        final groups = read['groups'] as List;
        read['groups'] = [
          groups.first,
          part(
            'group-lead-2',
            7,
            there(groupData('group-lead-2', title: 'Desktop')),
          ),
          part(
            'g3',
            8,
            there(
              groupData(
                'g3',
                title: 'Desktop sign-in',
                number: 3001,
                agentIds: ['agent-ash'],
                status: 'working',
                workerId: 'agent-ash',
                lastMessageSequence: 2,
              ),
            ),
          ),
          part(
            'g4',
            9,
            there(
              groupData(
                'g4',
                title: 'Desktop keychain',
                number: 3002,
                agentIds: ['agent-nova-2'],
                status: 'needs_human',
                workerId: 'agent-nova-2',
                lastMessageSequence: 2,
              ),
            ),
          ),
          part(
            'buddy-chat',
            10,
            buddyChatData(
              'buddy-chat',
              agentIds: ['buddy-pip'],
              lastMessageSequence: 1,
            ),
          ),
          ...groups.skip(1),
        ];
        return read;
      };
      return fake;
    }

    /// Whether [words] are drawn anywhere on the screen.
    Finder shown(String words) =>
        find.textContaining(words, findRichText: true);

    testWidgets("Team lists this project's alone: not another project's "
        'task, nor its agent of the same name, nor a Buddy', (tester) async {
      await team(tester, twoProjects());

      expect(find.byType(SwarmWaitingRow), findsOneWidget, reason: 'Juno');
      expect(find.byType(SwarmWorkRow), findsOneWidget, reason: 'Nova');
      expect(shown('Desktop keychain'), findsNothing);
      expect(shown('#3002'), findsNothing);
      expect(key('swarm-member-agent-nova-2'), findsNothing);
      expect(key('swarm-member-buddy-pip'), findsNothing);
      expect(
        tester
            .widgetList<SwarmMemberRow>(find.byType(SwarmMemberRow))
            .where((row) => row.name == 'Nova')
            .length,
        1,
      );
    });

    testWidgets('an agent of this project still holding work in another '
        'names none of it on the Team, and opens none of it', (tester) async {
      final fake = twoProjects();
      await team(tester, fake);

      await tester.ensureVisible(key('swarm-member-agent-ash'));
      await tester.pumpAndSettle();
      expect(heard(tester, 'swarm-member-agent-ash'), 'Ash, Working');
      expect(shown('Desktop sign-in'), findsNothing);
      expect(shown('#3001'), findsNothing);

      await tester.tap(key('swarm-member-agent-ash'));
      await tester.pumpAndSettle();

      expect(key('swarm-project-team-list'), findsOneWidget);
      expect(fake.paths.where((p) => p.contains('/conversations/g3/')), []);
    });

    testWidgets("another Swarm's project, a work chat, a Buddy chat and the "
        "project's own chat are refused alike, with nothing of them shown "
        'or read', (tester) async {
      for (final id in ['project-elsewhere', 'g1', 'buddy-chat', leadChat]) {
        final fake = twoProjects();
        await pump(
          tester,
          fake,
          SwarmProjectPage(
            swarmId: tab,
            projectId: id,
            tabs: SwarmProjectTab.homeC,
          ),
        );

        expect(
          find.text('This project is no longer in the Swarm.'),
          findsOneWidget,
          reason: id,
        );
        expect(key('swarm-project-menu'), findsNothing, reason: id);
        for (final words in [
          'Mobile',
          'Desktop',
          'Buddy chat header',
          "$me's Buddy",
          'Pip',
        ]) {
          expect(shown(words), findsNothing, reason: '$id: $words');
        }
        expect(
          fake.paths.where(
            (p) => p.contains('/messages') || p.contains('/leaderboard'),
          ),
          [],
          reason: id,
        );
      }
    });

    testWidgets('a board that lists someone who does not read the project '
        'shows nothing of them', (tester) async {
      final fake = backend();
      final answer = fake.routes[board]!;
      fake.routes[board] = (body) {
        final read = answer(body)! as Map<String, dynamic>;
        return {
          ...read,
          'people': [
            {
              ...scoreData('stranger', points: 9999, rank: 1, shipped: 40),
              'displayName': 'Mallory',
            },
            ...read['people'] as List,
          ],
        };
      };
      await leaderboard(tester, fake);

      expect(shown('Mallory'), findsNothing);
      expect(shown('Former member'), findsNothing);
      expect(shown('9999'), findsNothing);
      expect(shown('40 shipped'), findsNothing);
      expect(onBoard(tester), ['person-me', 'diego', 'ken']);
    });

    testWidgets('access taken away with the Team open: the sheet closes, its '
        'tasks and agents go, and the Swarm read on its way brings none back', (
      tester,
    ) async {
      final fake = backend();
      await team(tester, fake);
      expect(find.byType(SwarmWaitingRow), findsOneWidget);

      final gate = hold(fake, '/api/super-tabs/$tab/changes');
      final reader = host(tester).session!.inbox.reader(tab)!;
      unawaited(reader.refresh());
      await tester.pump();
      reader.revoke();
      await tester.pump();
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.byType(BottomSheet), findsNothing);
      expect(find.byType(SwarmProjectTeamSheet), findsNothing);
      expect(find.byType(SwarmWaitingRow), findsNothing);
      expect(find.byType(SwarmWorkRow), findsNothing);
      expect(find.byType(SwarmMemberRow), findsNothing);
      for (final words in [
        'Juno',
        'Nova',
        'Saved views cache',
        'Buddy chat header',
        '#Mobile',
      ]) {
        expect(shown(words), findsNothing, reason: words);
      }
      expect(
        find.text('This project is no longer in the Swarm.'),
        findsOneWidget,
      );
      expect(fake.commands, isEmpty);
    });

    testWidgets('access taken away with the menu open: it closes, and its rows '
        'open nothing', (tester) async {
      await pump(tester, backend(), page);
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      expect(key('swarm-project-menu-team'), findsOneWidget);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(key('swarm-project-menu-team'), findsNothing);
      expect(key('swarm-project-menu-leaderboard'), findsNothing);
      expect(key('swarm-project-menu'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
    });

    for (final (row, what) in [
      ('team', SwarmProjectTeamSheet),
      ('leaderboard', SwarmLeaderboardPage),
    ]) {
      testWidgets('access taken away between the tap on $row and its first '
          'frame: it does not stay', (tester) async {
        await pump(tester, backend(), page);
        await tester.tap(key('swarm-project-menu'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-project-menu-$row'));

        host(tester).session!.inbox.reader(tab)!.revoke();
        await tester.pumpAndSettle();

        expect(find.byType(what), findsNothing);
        expect(find.byType(BottomSheet), findsNothing);
      });

      testWidgets("the project taken off the Swarm with $row open, the Swarm "
          'still read: it closes', (tester) async {
        final fake = backend();
        await fromMenu(tester, fake, 'swarm-project-menu-$row');
        expect(find.byType(what), findsOneWidget);
        final reader = host(tester).session!.inbox.reader(tab)!;

        fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
          ...changes(cursor: 'c3'),
          'head': part('head', 2, headData(projects: const [])),
        };
        await reader.refresh();
        await tester.pumpAndSettle();

        expect(reader.accessRevoked, isFalse);
        expect(find.byType(what), findsNothing);
        expect(find.byType(BottomSheet), findsNothing);
      });

      testWidgets('the account signing out with $row open: it closes', (
        tester,
      ) async {
        await fromMenu(tester, backend(), 'swarm-project-menu-$row');
        expect(find.byType(what), findsOneWidget);

        (host(tester).account as ValueNotifier<String?>).value = null;
        await tester.pumpAndSettle();

        expect(find.byType(what), findsNothing);
        expect(find.byType(BottomSheet), findsNothing);
      });

      testWidgets('leaving the page with $row open by a way that skips the '
          'sheet: it closes with the page', (tester) async {
        final nav = GlobalKey<NavigatorState>();
        final fake = backend();
        final features = ExperimentalFeaturesStore(
          storage: MemoryKeyValueStore(),
        )..value = {PhoneExperiment.swarm};
        final account = ValueNotifier<String?>(me);
        final swarm = SwarmHost(
          accountId: () => account.value,
          account: account,
          request: fake.request,
          notices: SilentSystemNotices(),
          features: features,
          readMarks: MemoryKeyValueStore(),
        )..foreground = false;
        addTearDown(swarm.dispose);
        late Route<void> pageRoute;
        await tester.pumpWidget(
          MaterialApp(
            navigatorKey: nav,
            builder: (context, child) =>
                SwarmScope(notifier: swarm, child: child!),
            home: const SizedBox(),
          ),
        );
        pageRoute = MaterialPageRoute<void>(builder: (_) => page);
        unawaited(nav.currentState!.push(pageRoute));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-project-menu'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-project-menu-$row'));
        await tester.pumpAndSettle();
        expect(find.byType(what), findsOneWidget);

        nav.currentState!.removeRoute(pageRoute);
        await tester.pumpAndSettle();

        expect(find.byType(SwarmProjectPage), findsNothing);
        expect(find.byType(what), findsNothing);
        expect(find.byType(BottomSheet), findsNothing);
      });
    }

    testWidgets('access taken away with a task opened over the Team: the sheet '
        'under it closes, and back shows nothing of it', (tester) async {
      await team(tester, backend());
      await tester.tap(key('swarm-task-g1'));
      await tester.pumpAndSettle();
      expect(find.text('Header is in.'), findsOneWidget);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(find.text('Header is in.'), findsNothing);
      expect(
        find.byType(SwarmProjectTeamSheet, skipOffstage: false),
        findsNothing,
      );
      await tester.tap(key('tty-back').first);
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(
        find.text('This project is no longer in the Swarm.'),
        findsOneWidget,
      );
    });

    testWidgets('access taken away with the week picker up over the '
        'Leaderboard: both close, and the pick is never read', (tester) async {
      final fake = backend();
      await leaderboard(tester, fake);
      await tester.tap(key('swarm-leaderboard-week'));
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-week-1'), findsOneWidget);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-week-1'), findsNothing);
      expect(find.byType(BottomSheet), findsNothing);
      expect(fake.paths.where((p) => p.contains('&week=')), isEmpty);
    });

    testWidgets('a first read that fails shows no menu; the read that recovers '
        'brings it, and it works', (tester) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Swarm is down.');
      await pump(tester, fake, page);

      expect(find.text('Swarm is down.'), findsOneWidget);
      expect(key('swarm-project-menu'), findsNothing);
      expect(find.textContaining('Loading'), findsNothing);

      fake.routes['/api/super-tabs/$tab/parts'] = load;
      await tester.fling(
        find.text('Swarm is down.'),
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-team'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectTeamSheet), findsOneWidget);
      expect(key('swarm-task-g1'), findsOneWidget);
    });

    testWidgets('a Swarm read that fails with the Team open keeps what it '
        'shows, and no Loading', (tester) async {
      final fake = backend();
      await team(tester, fake);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Swarm is down.');
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmProjectTeamSheet), findsOneWidget);
      expect(key('swarm-task-g1'), findsOneWidget);
      expect(find.textContaining('Loading'), findsNothing);
    });

    /// [backend] whose Mobile is private to the person and Diego, on its
    /// Leaderboard with Diego's week open.
    Future<FakeSwarm> diegoWeek(WidgetTester tester) async {
      final fake = backend();
      final load = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
        final read = (await load(body))! as Map<String, dynamic>;
        final head = (read['head'] as Map)['data'] as Map<String, dynamic>;
        final mobile = (head['projects'] as List).single as Map;
        mobile['visibility'] = 'private';
        mobile['members'] = [
          {'id': 'diego', 'generation': 'gen-diego'},
        ];
        return read;
      };
      await leaderboard(tester, fake);
      await tester.tap(key('swarm-leaderboard-person-diego'));
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-sheet'), findsOneWidget);
      expect(find.text('diego'), findsWidgets);
      return fake;
    }

    testWidgets("access taken away with a person's week open: the week "
        'closes, and nothing of them stays', (tester) async {
      await diegoWeek(tester);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-sheet'), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets("access taken away between the tap on a person and the week's "
        'first frame: it does not stay', (tester) async {
      await leaderboard(tester, backend());
      await tester.tap(key('swarm-leaderboard-person-diego'));

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-sheet'), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets("the project taken off the Swarm with a person's week open, "
        'the Swarm still read: the week closes', (tester) async {
      final fake = await diegoWeek(tester);
      final reader = host(tester).session!.inbox.reader(tab)!;

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'head': part('head', 2, headData(projects: const [])),
      };
      await reader.refresh();
      await tester.pumpAndSettle();

      expect(reader.accessRevoked, isFalse, reason: 'the Swarm is still read');
      expect(key('swarm-leaderboard-sheet'), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets("the account signing out with a person's week open: the "
        'week closes', (tester) async {
      await diegoWeek(tester);

      (host(tester).account as ValueNotifier<String?>).value = null;
      await tester.pumpAndSettle();

      expect(key('swarm-leaderboard-sheet'), findsNothing);
      expect(find.text('diego'), findsNothing);
    });

    testWidgets('access taken away with the chat open: its messages go, and '
        'nothing is marked read after', (tester) async {
      final fake = backend();
      await pump(tester, fake, page);
      expect(find.text('CI on #2154 is green.'), findsOneWidget);
      final posts = fake.calls.where((c) => c.method == 'POST').length;

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(find.text('CI on #2154 is green.'), findsNothing);
      expect(key('swarm-new-messages-line'), findsNothing);
      expect(find.byType(TextField), findsNothing, reason: 'no composer');
      expect(
        find.text('This project is no longer in the Swarm.'),
        findsOneWidget,
      );
      expect(fake.calls.where((c) => c.method == 'POST').length, posts);
    });

    testWidgets("access taken away while the chat's first read is on its way: "
        'the answer is dropped, and no Loading stays', (tester) async {
      final fake = backend();
      final gate = hold(fake, messages);
      await pump(tester, fake, page, settle: false);
      expect(find.byType(SwarmChatSkeleton), findsOneWidget);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.text('CI on #2154 is green.'), findsNothing);
      expect(find.byType(SwarmChatSkeleton), findsNothing);
      expect(
        find.text('This project is no longer in the Swarm.'),
        findsOneWidget,
      );
      expect(
        fake.calls.where((c) => c.method == 'POST' && c.path.endsWith('/read')),
        isEmpty,
      );
    });

    testWidgets("a chat's first read that fails says so with no Loading left, "
        "and is read again once, at the Swarm's next read", (tester) async {
      final fake = backend();
      final answer = fake.routes[messages]!;
      fake.routes[messages] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Messages are down.');
      await pump(tester, fake, page);
      int reads() => fake.paths.where((p) => p.startsWith(messages)).length;

      expect(find.text('Messages are down.'), findsOneWidget);
      expect(find.byType(SwarmChatSkeleton), findsNothing);
      final opened = reads();
      expect(
        opened,
        lessThanOrEqualTo(2),
        reason: 'its open, and the Swarm read that came with it',
      );
      await tester.pump(const Duration(minutes: 1));
      expect(reads(), opened, reason: 'not again on its own, in a loop');

      fake.routes[messages] = answer;
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(reads(), opened + 1);
      expect(find.text('CI on #2154 is green.'), findsOneWidget);
      expect(find.text('Messages are down.'), findsNothing);
    });

    testWidgets("a page carrying another chat's message shows none of it, "
        'says the read failed, and leaves no Loading', (tester) async {
      final fake = backend();
      fake.routes[messages] = (_) => {
        'messages': [
          {
            'id': 'msg-lead-1',
            'conversationId': leadChat,
            'text': 'CI on #2154 is green.',
            'sequence': 1,
            'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
          },
          {
            'id': 'msg-buddy-1',
            'conversationId': 'buddy-chat',
            'text': 'A word to my Buddy.',
            'sequence': 2,
            'author': {'kind': 'person', 'id': me, 'name': me},
          },
        ],
        'next': null,
      };
      await pump(tester, fake, page);

      expect(find.text('A word to my Buddy.'), findsNothing);
      expect(find.text('CI on #2154 is green.'), findsNothing);
      expect(find.text('Could not load messages. Try again.'), findsOneWidget);
      expect(find.byType(SwarmChatSkeleton), findsNothing);
    });
  });
}

/// A phone whose read marks come back only once [back] completes: its
/// other keys at once.
class _SlowMarks extends MemoryKeyValueStore {
  final back = Completer<void>();

  @override
  Future<String?> read(String key) async {
    if (key.startsWith('swarm_read_marks.')) await back.future;
    return super.read(key);
  }
}
