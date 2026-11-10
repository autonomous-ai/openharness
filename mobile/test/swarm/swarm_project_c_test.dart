import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
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
  bool boardRead(String p) => p.startsWith(board) && !p.contains('&week=');

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
        part('diego', 1, person('diego', role: 'collaborator')),
        part('ken', 1, person('ken', role: 'collaborator')),
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

  /// [data] of a group whose agent last reported progress [ago] before [at].
  Map<String, dynamic> progressed(
    Map<String, dynamic> data,
    DateTime at,
    Duration ago,
  ) => {
    ...data,
    'assignment': <String, dynamic>{
      ...data['assignment'] as Map<String, dynamic>,
      'progressAt': at.subtract(ago).millisecondsSinceEpoch,
    },
  };

  /// [fake] whose first read has Nova's g1 progress 4m 30s and Juno's g2
  /// 2h before [at].
  FakeSwarm timed(FakeSwarm fake, DateTime at) {
    final load = fake.routes['/api/super-tabs/$tab/parts']!;
    fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
      final read = (await load(body))! as Map<String, dynamic>;
      read['groups'] = [
        for (final g in (read['groups'] as List).cast<Map<String, dynamic>>())
          switch (g['key']) {
            'g1' => {
              ...g,
              'data': progressed(
                g['data'] as Map<String, dynamic>,
                at,
                const Duration(minutes: 4, seconds: 30),
              ),
            },
            'g2' => {
              ...g,
              'data': progressed(
                g['data'] as Map<String, dynamic>,
                at,
                const Duration(hours: 2),
              ),
            },
            _ => g,
          },
      ];
      return read;
    };
    return fake;
  }

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
      expect(fake.paths.where(boardRead).length, 1);
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

    testWidgets('a project made private to others while it is open closes '
        'it, with what it held', (tester) async {
      final fake = backend();
      final first = await fake.routes['/api/super-tabs/$tab/parts']!(null);
      await leaderboard(tester, fake);
      expect(find.byType(SwarmLeaderboardPage), findsOneWidget);

      final head = Map<String, dynamic>.of(
        ((first! as Map)['head'] as Map)['data'] as Map<String, dynamic>,
      );
      head['projects'] = [
        for (final p in (head['projects'] as List).cast<Map>())
          {...p, 'ownerId': 'diego', 'visibility': 'private', 'members': []},
      ];
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c2', lastChangedAt: 102),
        'head': part('head', 2, head),
      };
      await host(tester).session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmLeaderboardPage), findsNothing);
      expect(onBoard(tester), isEmpty);
    });

    testWidgets('shows only the points: no change against last week, up or '
        'down, drawn or heard', (tester) async {
      final fake = backend();
      fake.routes[board] = (_) => leaderboardData(
        people: [
          scoreData('diego', points: 28, rank: 1)..['prevWeekPoints'] = 20,
          scoreData('ken', points: 21, rank: 2)..['prevWeekPoints'] = 25,
        ],
      );
      await leaderboard(tester, fake);

      for (final (id, points) in [('diego', '28'), ('ken', '21')]) {
        expect(
          find.descendant(
            of: key('swarm-leaderboard-points-$id'),
            matching: find.text(points),
          ),
          findsOneWidget,
          reason: id,
        );
      }
      for (final id in ['diego', 'ken']) {
        expect(key('swarm-leaderboard-trend-$id'), findsNothing, reason: id);
        expect(
          key('swarm-leaderboard-trend-column-$id'),
          findsNothing,
          reason: 'no room kept for it: $id',
        );
        expect(
          heard(tester, 'swarm-leaderboard-person-$id'),
          isNot(contains('from last week')),
        );
      }
      expect(find.byIcon(LucideIcons.arrowUp300), findsNothing);
      expect(find.byIcon(LucideIcons.arrowDown300), findsNothing);
      expect(find.text('8'), findsNothing);
      expect(find.text('4'), findsNothing);
    });

    /// The Leaderboard sheet opened while the board is held on its way: its
    /// skeleton pulses, so nothing settles.
    Future<void> openHeld(WidgetTester tester, FakeSwarm fake) async {
      await pump(tester, fake, page);
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-leaderboard'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('while the board is read, skeleton rows stand for its people, '
        'one each, and nobody shows until it answers, in its order', (
      tester,
    ) async {
      final fake = backend();
      final gate = hold(fake, board);
      await openHeld(tester, fake);

      expect(key('swarm-leaderboard-loading'), findsOneWidget);
      for (final i in [0, 1, 2]) {
        expect(key('swarm-leaderboard-loading-$i'), findsOneWidget);
      }
      expect(key('swarm-leaderboard-loading-3'), findsNothing);
      expect(onBoard(tester), isEmpty);
      expect(find.textContaining('Loading'), findsNothing);
      expect(key('swarm-leaderboard-close'), findsOneWidget);
      expect(key('swarm-leaderboard-week'), findsOneWidget);

      gate.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(onBoard(tester), ['person-me', 'diego', 'ken']);
    });

    testWidgets('a skeleton row is as tall as the person named alone that '
        'replaces it', (tester) async {
      final fake = backend();
      fake.routes[board] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Board is down.');
      final gate = hold(fake, board);
      await openHeld(tester, fake);
      final skeleton = tester.getSize(key('swarm-leaderboard-loading-0'));

      gate.complete();
      await tester.pumpAndSettle();

      expect(
        tester.getSize(key('swarm-leaderboard-person-diego')).height,
        skeleton.height,
      );
    });

    testWidgets("another week's read has the skeleton, none of this week's "
        'numbers under its name', (tester) async {
      final fake = backend();
      await leaderboard(tester, fake);
      await tester.tap(key('swarm-leaderboard-week'));
      await tester.pumpAndSettle();
      final gate = Completer<void>();
      fake.routes.addAll({
        for (var back = 1; back < 4; back++)
          '$board&week=${swarmWeekOf(DateTime.now()) - back * swarmWeekMs}':
              (_) async {
                await gate.future;
                return leaderboardData(
                  people: [scoreData('ken', points: 7, rank: 1)],
                );
              },
      });
      await tester.tap(key('swarm-leaderboard-week-1'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(key('swarm-leaderboard-loading'), findsOneWidget);
      expect(onBoard(tester), isEmpty);

      gate.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(onBoard(tester).first, 'ken');
    });

    testWidgets('a pull over a board read keeps its rows, with no skeleton', (
      tester,
    ) async {
      final fake = backend();
      await leaderboard(tester, fake);
      final gate = hold(fake, board);

      await tester.fling(
        key('swarm-leaderboard-person-diego'),
        const Offset(0, 400),
        1000,
      );
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(onBoard(tester), ['person-me', 'diego', 'ken']);

      gate.complete();
      await tester.pumpAndSettle();
    });

    testWidgets('before its Swarm is read, the sheet has skeleton rows too', (
      tester,
    ) async {
      final fake = backend();
      final gate = hold(fake, '/api/super-tabs/$tab/parts');
      await pump(
        tester,
        fake,
        const Scaffold(
          body: SwarmLeaderboardPage(
            swarmId: tab,
            projectId: project,
            sheet: true,
          ),
        ),
        settle: false,
      );

      expect(key('swarm-leaderboard-loading'), findsOneWidget);
      expect(onBoard(tester), isEmpty);

      gate.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-leaderboard-loading'), findsNothing);
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
      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(onBoard(tester), contains('diego'));
      expect(find.textContaining('Loading'), findsNothing);
      final reads = fake.paths.where(boardRead).length;

      fake.routes[board] = answer;
      await tester.tap(key('swarm-leaderboard-retry'));
      await tester.pumpAndSettle();

      expect(fake.paths.where(boardRead).length, reads + 1);
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
      expect(key('swarm-leaderboard-loading'), findsNothing);
      expect(onBoard(tester), ['diego', 'ken', 'person-me']);
    });

    testWidgets('the board answer that lands after the sheet closed changes '
        'nothing, and opening it again reads it anew', (tester) async {
      final fake = backend();
      final gate = hold(fake, board);
      await openHeld(tester, fake);

      await tester.tap(key('swarm-leaderboard-close'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmLeaderboardPage), findsNothing);
      final reads = fake.paths.where(boardRead).length;
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.text('1320'), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-leaderboard'));
      await tester.pumpAndSettle();
      expect(fake.paths.where(boardRead).length, reads + 1);
      expect(find.text('1320'), findsOneWidget);
    });

    testWidgets('access taken away while it is open closes it, and the board '
        'answer on its way is dropped', (tester) async {
      final fake = backend();
      final gate = hold(fake, board);
      await openHeld(tester, fake);
      expect(key('swarm-leaderboard-loading'), findsOneWidget);

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

  group('the project screen', () {
    /// What the header's line under the name says, whole.
    String? teamLine(WidgetTester tester) => tester
        .widget<Text>(
          find.descendant(
            of: key('swarm-project-team-line'),
            matching: find.byType(Text),
          ),
        )
        .data;

    testWidgets('has no tab bar: its chat fills the screen under its header', (
      tester,
    ) async {
      await pump(tester, backend(), page);

      for (final name in ['chat', 'buddy', 'tasks', 'leaderboard', 'team']) {
        expect(key('swarm-project-tab-$name'), findsNothing, reason: name);
      }
      expect(find.text('CI on #2154 is green.'), findsOneWidget);
      expect(
        tester.getTopLeft(find.byType(SwarmConversationPage)).dy,
        tester.getBottomLeft(find.byType(SwarmTopBar)).dy,
      );
      expect(
        tester.getBottomLeft(find.byType(SwarmConversationPage)).dy,
        tester.getSize(find.byType(SwarmProjectPage)).height,
      );
      expect(
        key('swarm-project-team'),
        findsNothing,
        reason: "direction B's team button",
      );
    });

    testWidgets('⋮ at the end of the header, a finger wide and tall, says '
        'Menu, and opens Leaderboard on the menu surface', (
      tester,
    ) async {
      await pump(tester, backend(), page);

      final button = key('swarm-project-menu');
      expect(
        find.descendant(
          of: button,
          matching: find.byIcon(LucideIcons.ellipsisVertical300),
        ),
        findsOneWidget,
      );
      expect(find.byIcon(LucideIcons.menu300), findsNothing);
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
      expect(find.text('Team'), findsNothing);
      expect(find.text('Work'), findsNothing);
      expect(
        tester.getSize(key('swarm-project-menu-leaderboard')).height,
        greaterThanOrEqualTo(minTouchTarget),
      );
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
        expect(find.byType(SwarmConversationPage), findsOneWidget);
      });
    }

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
      await tester.tap(key('swarm-project-menu-leaderboard'));
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

      await tester.tap(key('swarm-leaderboard-close'));
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

    // Reactions are gone (anh Dee, 2026-11-09): the agents' 👀 ✅ 🚀 an
    // older server still sends show nowhere, and nothing offers one.
    testWidgets('no reactions under a message, and no add-reaction chip', (
      tester,
    ) async {
      final fake = talk();
      await pump(tester, fake, page);

      for (final emoji in ['eyes', 'check', 'rocket']) {
        expect(key('swarm-reaction-m4-$emoji'), findsNothing, reason: emoji);
      }
      expect(key('swarm-add-reaction-m4'), findsNothing);
      expect(find.text('👀'), findsNothing);
      expect(find.text('🚀'), findsNothing);
      expect(fake.commands.where((c) => c['type'] == 'message.react'), isEmpty);
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
    /// too: Ash, Mobile's agent, still holds work there, its last progress 3h
    /// ago; another agent named
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
              progressed(
                groupData(
                  'g3',
                  title: 'Desktop sign-in',
                  number: 3001,
                  agentIds: ['agent-ash'],
                  status: 'working',
                  workerId: 'agent-ash',
                  lastMessageSequence: 2,
                ),
                clock.now(),
                const Duration(hours: 3),
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

    for (final (row, what) in [('leaderboard', SwarmLeaderboardPage)]) {
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
