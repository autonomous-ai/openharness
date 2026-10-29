import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_project_team.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The project screen of Tony's Swarm Home, direction C (2026-10-30): the
/// project's #name over its team line, and two tabs, Chat and Team.
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
        scoreData(me, points: 1320, rank: 1),
        scoreData('diego', points: 1050, rank: 2),
        scoreData('ken', points: 640, rank: 3),
      ],
    );
    return fake;
  }

  /// [home] under a signed-in shell's Swarm, with Swarm turned on.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake,
    Widget home,
  ) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  const page = SwarmProjectPage(
    swarmId: tab,
    projectId: project,
    tabs: SwarmProjectTab.homeC,
  );

  /// The page on its Team tab.
  Future<SwarmHost> team(WidgetTester tester, FakeSwarm fake) async {
    final host = await pump(tester, fake, page);
    await tester.tap(key('swarm-project-tab-team'));
    await tester.pumpAndSettle();
    return host;
  }

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

  /// The member rows under the caption keyed [caption]'s card.
  List<String> rowsAfter(WidgetTester tester, String caption, String? next) {
    final top = tester.getBottomLeft(key(caption)).dy;
    final bottom = next == null
        ? double.infinity
        : tester.getTopLeft(key(next)).dy;
    final rows =
        tester.widgetList<SwarmMemberRow>(find.byType(SwarmMemberRow)).where((
          row,
        ) {
          final y = tester.getTopLeft(find.byWidget(row)).dy;
          return y >= top && y < bottom;
        }).toList()..sort(
          (a, b) => tester
              .getTopLeft(find.byWidget(a))
              .dy
              .compareTo(tester.getTopLeft(find.byWidget(b)).dy),
        );
    return [for (final row in rows) (row.key! as ValueKey<String>).value];
  }

  group('Team, its humans', () {
    testWidgets("by this week's points, most first, with no ranks, the "
        "viewer's own row saying so", (tester) async {
      await team(tester, backend());

      expect(
        said(tester, 'swarm-team-humans-caption'),
        'Humans | Points this week',
      );
      expect(
        rowsAfter(
          tester,
          'swarm-team-humans-caption',
          'swarm-team-agents-caption',
        ),
        [
          'swarm-member-person-person-me',
          'swarm-member-person-diego',
          'swarm-member-person-ken',
        ],
      );
      expect(
        heard(tester, 'swarm-member-person-person-me'),
        'person-me, you, 1,320 points',
      );
      expect(heard(tester, 'swarm-member-person-diego'), 'diego, 1,050 points');
      expect(find.text('1,320'), findsOneWidget);
      for (final rank in ['1', '2', '3']) {
        expect(find.text(rank), findsNothing, reason: 'no rank $rank');
      }
    });

    testWidgets('in the one row shape the agents share', (tester) async {
      await team(tester, backend());

      expect(
        rowsAfter(tester, 'swarm-team-agents-caption', null),
        hasLength(4),
      );
      final human = tester.getSize(key('swarm-member-person-diego'));
      final agent = tester.getSize(key('swarm-member-agent-ash'));
      expect(human.height, agent.height);
      expect(human.width, agent.width);
    });

    testWidgets('equal points, and none, go by name', (tester) async {
      final fake = backend();
      fake.routes[board] = (_) => leaderboardData(
        people: [
          scoreData('ken', points: 40, rank: 1),
          scoreData('diego', points: 40, rank: 1),
        ],
      );
      await team(tester, fake);

      expect(
        rowsAfter(
          tester,
          'swarm-team-humans-caption',
          'swarm-team-agents-caption',
        ),
        [
          'swarm-member-person-diego',
          'swarm-member-person-ken',
          'swarm-member-person-person-me',
        ],
      );
      expect(
        heard(tester, 'swarm-member-person-person-me'),
        'person-me, you, 0 points',
      );
    });

    testWidgets('a row opens their week', (tester) async {
      await team(tester, backend());

      await tester.tap(key('swarm-member-person-diego'));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('swarm-leaderboard-sheet')),
        findsOneWidget,
      );
      expect(find.text('1050 this week'), findsOneWidget);
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
      await team(tester, fake);

      expect(key('swarm-member-person-ken'), findsNothing);
      expect(key('swarm-member-person-diego'), findsOneWidget);
    });

    testWidgets('while the board is read, the people show without points, '
        'never a Loading that stays', (tester) async {
      final fake = backend();
      final gate = hold(fake, board);
      await team(tester, fake);

      expect(heard(tester, 'swarm-member-person-diego'), 'diego');
      expect(find.textContaining('Loading'), findsNothing);

      gate.complete();
      await tester.pumpAndSettle();
      expect(heard(tester, 'swarm-member-person-diego'), 'diego, 1,050 points');
    });

    testWidgets('a board that cannot be read says so, and Try again reads it '
        'once', (tester) async {
      final fake = backend();
      final answer = fake.routes[board]!;
      fake.routes[board] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Board is down.');
      await team(tester, fake);

      expect(find.text('Board is down.'), findsOneWidget);
      expect(heard(tester, 'swarm-member-person-diego'), 'diego');
      final reads = fake.paths.where((p) => p == board).length;

      fake.routes[board] = answer;
      await tester.tap(key('swarm-team-board-retry'));
      await tester.pumpAndSettle();

      expect(fake.paths.where((p) => p == board).length, reads + 1);
      expect(find.text('Board is down.'), findsNothing);
      expect(heard(tester, 'swarm-member-person-diego'), 'diego, 1,050 points');
    });

    testWidgets('access taken away while it is open leaves nothing of the '
        'team, and the board answer on its way is dropped', (tester) async {
      final fake = backend();
      final gate = hold(fake, board);
      await team(tester, fake);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      gate.complete();
      await tester.pumpAndSettle();

      expect(find.byType(SwarmMemberRow), findsNothing);
      expect(find.byType(SwarmProjectTeam), findsNothing);
      expect(find.text('1,050'), findsNothing);
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

    testWidgets('has two tabs, Chat and Team, each half the width and a '
        "finger's height", (tester) async {
      await pump(tester, backend(), page);

      for (final name in ['buddy', 'tasks', 'leaderboard']) {
        expect(key('swarm-project-tab-$name'), findsNothing, reason: name);
      }
      final width = tester.getSize(find.byType(SwarmProjectPage)).width;
      for (final name in ['chat', 'team']) {
        final size = tester.getSize(key('swarm-project-tab-$name'));
        expect(size.height, greaterThanOrEqualTo(minTouchTarget), reason: name);
        expect(size.width, greaterThan(width / 2 - 16), reason: name);
      }
      expect(find.text('Chat'), findsOneWidget);
      expect(find.text('Team'), findsOneWidget);
      expect(
        key('swarm-project-team'),
        findsNothing,
        reason: 'the team is a tab, not a sheet from the header',
      );
    });

    testWidgets('opens on its chat, and Team shows the team in its place', (
      tester,
    ) async {
      await pump(tester, backend(), page);
      expect(find.text('CI on #2154 is green.'), findsOneWidget);
      expect(key('swarm-project-body-chat'), findsOneWidget);

      await tester.tap(key('swarm-project-tab-team'));
      await tester.pumpAndSettle();

      expect(key('swarm-project-body-team'), findsOneWidget);
      expect(find.text('CI on #2154 is green.'), findsNothing);
      expect(
        tester
            .widget<Semantics>(key('swarm-project-tab-team'))
            .properties
            .selected,
        isTrue,
      );
    });

    testWidgets('the four tabs of direction B stay as they were', (
      tester,
    ) async {
      await pump(
        tester,
        backend(),
        const SwarmProjectPage(swarmId: tab, projectId: project),
      );

      for (final name in ['chat', 'buddy', 'tasks', 'leaderboard']) {
        expect(key('swarm-project-tab-$name'), findsOneWidget, reason: name);
      }
      expect(key('swarm-project-tab-team'), findsNothing);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(key('swarm-project-team'), findsOneWidget);
    });
  });
}
