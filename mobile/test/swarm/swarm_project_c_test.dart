import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_project_tasks.dart';
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
      readMarks: MemoryKeyValueStore(),
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

  /// The texts of the row keyed [k] with a digit in them, its face aside.
  Finder figures(String k) => find.descendant(
    of: key(k),
    matching: find.textContaining(RegExp(r'\d'), findRichText: true),
  );

  group('Team, its tasks', () {
    /// The key of Juno's work in g2, waiting on the person.
    String workKey(WidgetTester tester) =>
        host(tester).session!.inbox.needs.whereType<SwarmWorkNeed>().single.key;

    testWidgets('on top: what waits on the person, then what is worked on, '
        "in the Tasks tab's rows, counted beside their caption", (
      tester,
    ) async {
      await team(tester, backend());

      expect(
        said(tester, 'swarm-team-tasks-caption'),
        'Tasks | 1 waiting on you · 1 working',
      );
      final waiting = 'swarm-waiting-${workKey(tester)}';
      expect(key(waiting), findsOneWidget);
      expect(tester.widget(key(waiting)), isA<SwarmWaitingRow>());
      expect(tester.widget(key('swarm-task-g1')), isA<SwarmWorkRow>());
      expect(key('swarm-task-g2'), findsNothing, reason: 'it waits on you');
      expect(key('swarm-reply-${workKey(tester)}'), findsOneWidget);
      double y(String k) => tester.getTopLeft(key(k)).dy;
      final order = [
        y('swarm-team-tasks-caption'),
        y(waiting),
        y('swarm-task-g1'),
        y('swarm-team-humans-caption'),
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

      expect(said(tester, 'swarm-team-tasks-caption'), 'Tasks');
      expect(key('swarm-team-no-tasks'), findsOneWidget);
      expect(find.text('No open tasks.'), findsOneWidget);
      expect(key('swarm-task-g1'), findsNothing);
    });
  });

  group('Team, its humans', () {
    testWidgets("ordered by this week's points, most first, though no row "
        'shows a number: the name and what they are on now', (tester) async {
      await team(tester, backend());

      expect(
        said(tester, 'swarm-team-humans-caption'),
        'Humans',
        reason: 'no points column to name (Dee: bare points mean nothing)',
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
      expect(heard(tester, 'swarm-member-person-person-me'), 'person-me, you');
      expect(
        heard(tester, 'swarm-member-person-diego'),
        'diego, 🎯 Reviewing PRs',
      );
      expect(
        heard(tester, 'swarm-member-person-ken'),
        'ken',
        reason: 'a status whose time has passed is not shown',
      );
      for (final id in ['person-me', 'diego', 'ken']) {
        expect(figures('swarm-member-person-$id'), findsNothing, reason: id);
      }
      expect(find.text('1,320'), findsNothing);
      expect(find.text('1320'), findsNothing);
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
    });

    testWidgets('a row opens their week', (tester) async {
      await team(tester, backend());

      await tester.tap(key('swarm-member-person-diego'));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('swarm-leaderboard-sheet')),
        findsOneWidget,
      );
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

    testWidgets('while the board is read, the people show at once by name, '
        'never a Loading that stays, and take its order when it answers', (
      tester,
    ) async {
      final fake = backend();
      final gate = hold(fake, board);
      await team(tester, fake);

      List<String> humans() => rowsAfter(
        tester,
        'swarm-team-humans-caption',
        'swarm-team-agents-caption',
      );
      expect(humans(), [
        'swarm-member-person-diego',
        'swarm-member-person-ken',
        'swarm-member-person-person-me',
      ]);
      expect(find.textContaining('Loading'), findsNothing);

      gate.complete();
      await tester.pumpAndSettle();
      expect(humans(), [
        'swarm-member-person-person-me',
        'swarm-member-person-diego',
        'swarm-member-person-ken',
      ]);
    });

    testWidgets('a board that cannot be read says so, and Try again reads it '
        'once', (tester) async {
      final fake = backend();
      final answer = fake.routes[board]!;
      fake.routes[board] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Board is down.');
      await team(tester, fake);

      expect(find.text('Board is down.'), findsOneWidget);
      expect(key('swarm-member-person-diego'), findsOneWidget);
      final reads = fake.paths.where((p) => p == board).length;

      fake.routes[board] = answer;
      await tester.tap(key('swarm-team-board-retry'));
      await tester.pumpAndSettle();

      expect(fake.paths.where((p) => p == board).length, reads + 1);
      expect(find.text('Board is down.'), findsNothing);
      expect(
        rowsAfter(
          tester,
          'swarm-team-humans-caption',
          'swarm-team-agents-caption',
        ).first,
        'swarm-member-person-person-me',
      );
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

      // Under the Tasks and the humans.
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

  group('Chat, its New messages line', () {
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

    testWidgets("direction B's chat has none", (tester) async {
      await pump(
        tester,
        chat([for (var i = 1; i <= 4; i++) said(i)], mark: 2),
        const SwarmProjectPage(swarmId: tab, projectId: project),
      );

      expect(find.text('Update 4.'), findsOneWidget);
      expect(line, findsNothing);
    });
  });
}
