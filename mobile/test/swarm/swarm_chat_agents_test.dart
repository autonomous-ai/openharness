import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_chat_agents.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// The person's computers with the sessions running on them, as a test
/// scripts them.
class _Computers extends FakeComputers implements SwarmRunningSessions {
  _Computers() : super(const [(name: 'Studio', away: false)]);

  @override
  List<SwarmRunningSession> running = const [];
}

SwarmRunningSession session(
  String harnessId,
  String name, {
  String machineId = 'mac-1',
  String machine = 'Studio',
  String engine = 'claude',
}) => (
  machineId: machineId,
  machine: machine,
  harnessId: harnessId,
  name: name,
  engine: engine,
);

/// Add agent and Remove from Swarm on the phone (task 14), as Desktop's
/// Members offers them: Add agent in a chat's ⋮ and at the end of a
/// project's Team, with the Swarm's agents of the project and the sessions
/// running on the person's computers; Remove from Swarm on a long press of a
/// Team row, asked first in the desktop's words.
void main() {
  const chat = 'g1';
  const board = '/api/super-tabs/$tab/leaderboard?projectId=$project';
  late FakeSwarm swarm;
  late SwarmHost host;
  late _Computers computers;
  late List<Map<String, dynamic>> agents;
  late Set<String> removed;
  late List<String> chatAgents;
  late bool chatArchived;
  var version = 2;

  /// What the next command answers instead of the server, once.
  FutureOr<Object?> Function()? answer;

  Map<String, dynamic> groups(String id) => switch (id) {
    chat => {
      ...groupData(
        chat,
        title: 'Fix login flake',
        number: 7,
        agentIds: chatAgents,
      ),
      'archived': chatArchived,
    },
    'g-archived' => {
      ...groupData('g-archived', title: 'Old'),
      'archived': true,
    },
    'g-private' => groupData('g-private', title: 'Private', audience: [me]),
    _ => buddyChatData('g-buddy', agentIds: ['agent-buddy']),
  };
  const groupIds = [chat, 'g-archived', 'g-private', 'g-buddy'];

  Future<void> pump(
    WidgetTester tester, {
    String role = 'owner',
    String owner = me,
    Widget? home,
  }) async {
    version = 2;
    answer = null;
    removed = {};
    chatAgents = ['agent-lead', 'agent-builder'];
    chatArchived = false;
    agents = [
      agent('agent-lead', name: 'Lead', displayName: 'River'),
      agent('agent-builder', displayName: 'Nova'),
      agent('agent-ash', displayName: 'Ash'),
      {
        ...agent('agent-bea', displayName: 'Bea'),
        'contributorId': 'person-dee',
      },
      {...agent('agent-far', displayName: 'Far'), 'projectId': 'project-2'},
      buddyData('agent-buddy', displayName: 'Wren'),
    ];
    computers = _Computers();
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': owner},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        head: headData(ownerId: owner),
        agents: agents,
        groups: [for (final id in groupIds) groups(id)],
        machines: [
          {
            'machineId': 'mac-1',
            'name': 'Tony’s Mac',
            'contributorId': me,
            'engines': ['claude', 'codex'],
          },
        ],
      ),
      'members': [
        part(me, 1, person(me, role: role)),
        part('person-dee', 1, person('person-dee', role: 'collaborator')),
      ],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) {
      version++;
      return {
        ...changes(
          cursor: 'c$version',
          groups: [for (final id in groupIds) part(id, version, groups(id))],
        ),
        'agents': [
          for (final a in agents) part(a['id'] as String, version, a),
          for (final id in removed)
            {
              'key': id,
              'version': version,
              'changedAt': version,
              'deleted': true,
            },
        ],
      };
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    swarm.routes[board] = (_) => leaderboardData(people: const []);
    for (final id in [chat, leadChat]) {
      swarm.routes['/api/super-tabs/$tab/conversations/$id/messages'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
    }
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) async {
      final command = body!['command'] as Map<String, dynamic>;
      if (answer case final once?) {
        answer = null;
        return await once();
      }
      switch (command['type']) {
        case 'agent.remove':
          final id = command['agentId'] as String;
          agents.removeWhere((a) => a['id'] == id);
          removed.add(id);
          chatAgents = [...chatAgents]..remove(id);
        case 'conversation.agent' when command['conversationId'] == chat:
          chatAgents = [...chatAgents, command['agentId'] as String];
      }
      return {'ok': true};
    };
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      computers: computers,
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: Scaffold(
          body:
              home ??
              const SwarmConversationPage(swarmId: tab, conversationId: chat),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  SwarmReader reader() => host.session!.inbox.reader(tab)!;
  Finder key(String value) => find.byKey(ValueKey(value));
  double y(WidgetTester tester, Finder finder) => tester.getTopLeft(finder).dy;

  Future<void> addSheet(WidgetTester tester) async {
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add agent'));
    await tester.pumpAndSettle();
  }

  const title = 'Add agent to Phone Swarm';

  /// Two sessions on the Studio, one of them already the Swarm's Ash, and
  /// one on the Mini.
  void runSessions() => computers.running = [
    session('h-new', 'Fix flaky test'),
    session('harness-agent-ash', 'Ash session'),
    session(
      'h-codex',
      'Docs',
      machineId: 'mac-2',
      machine: 'Mini',
      engine: 'codex',
    ),
  ];

  /// The commands sent, in order.
  List<Map<String, dynamic>> sent() => swarm.commands;

  group('who may add an agent', () {
    testWidgets('an owner gets Add agent in an ordinary chat\'s ⋮, above '
        'Rename', (tester) async {
      await pump(tester);
      await tester.tap(key('swarm-chat-menu'));
      await tester.pumpAndSettle();
      expect(find.text('Add agent'), findsOneWidget);
      expect(
        y(tester, find.text('Add agent')),
        lessThan(y(tester, find.text('Rename'))),
      );
    });

    testWidgets('a viewer gets none', (tester) async {
      await pump(tester, role: 'viewer');
      await tester.tap(key('swarm-chat-menu'));
      await tester.pumpAndSettle();
      expect(find.text('Add agent'), findsNothing);
      expect(find.text('All new messages'), findsOneWidget);
    });

    testWidgets('never to an archived, a private or a Buddy chat; the '
        'project chat takes one', (tester) async {
      await pump(tester);
      expect(swarmCanAddAgent(reader(), chat), isTrue);
      expect(swarmCanAddAgent(reader(), leadChat), isTrue);
      expect(swarmCanAddAgent(reader(), 'g-archived'), isFalse);
      expect(swarmCanAddAgent(reader(), 'g-private'), isFalse);
      expect(swarmCanAddAgent(reader(), 'g-buddy'), isFalse);
      expect(swarmCanAddAgent(reader(), 'no-such-chat'), isFalse);
    });
  });

  group('the choices', () {
    testWidgets('an ordinary chat offers the project\'s agents not in it, by '
        'name, then each computer\'s sessions not in the Swarm under its '
        'name, each with its engine', (tester) async {
      await pump(tester);
      runSessions();
      await addSheet(tester);

      expect(find.text(title), findsOneWidget);
      for (final shown in ['Ash', 'Bea', 'Fix flaky test', 'Docs']) {
        expect(find.text(shown), findsOneWidget, reason: shown);
      }
      // In the chat already, a Buddy, another project's, and Ash's own
      // session, which is Ash.
      for (final hidden in ['River', 'Nova', 'Wren', 'Far', 'Ash session']) {
        expect(find.text(hidden), findsNothing, reason: hidden);
      }
      expect(find.text('agents'), findsOneWidget);
      expect(find.text('studio'), findsOneWidget);
      expect(find.text('mini'), findsOneWidget);
      expect(find.text('Claude'), findsNWidgets(3));
      expect(find.text('Codex'), findsOneWidget);
      final order = [
        for (final name in ['Ash', 'Bea', 'Fix flaky test', 'Docs'])
          y(tester, find.text(name)),
      ];
      expect(order, [...order]..sort());
      expect(sent(), isEmpty);
    });

    testWidgets('the project chat offers only sessions not in the Swarm: it '
        'holds no agent but its coordinator (#2207)', (tester) async {
      await pump(tester);
      runSessions();
      expect(
        [
          for (final c in swarmAgentChoices(
            reader(),
            leadChat,
            computers.running,
          ))
            c.name,
        ],
        ['Fix flaky test', 'Docs'],
      );
      expect(
        swarmAgentChoices(reader(), 'g-private', computers.running),
        isEmpty,
      );
    });
  });

  group('adding', () {
    testWidgets('an agent of the Swarm joins the chat with '
        'conversation.agent, and the Swarm is read again', (tester) async {
      await pump(tester);
      await addSheet(tester);
      final before = swarm.paths.length;
      await tester.tap(find.text('Ash'));
      await tester.pumpAndSettle();

      expect(find.text(title), findsNothing, reason: 'the sheet closes');
      expect(sent(), [
        {
          'type': 'conversation.agent',
          'conversationId': chat,
          'agentId': 'agent-ash',
          'present': true,
          'lead': false,
        },
      ]);
      final after = swarm.paths.sublist(before);
      final command = after.indexWhere((p) => p.endsWith('/commands'));
      expect(
        after.skip(command).where((p) => p.contains('/changes')),
        isNotEmpty,
      );
      expect(reader().snapshot!.conversation(chat)!.agentIds, [
        'agent-lead',
        'agent-builder',
        'agent-ash',
      ]);
      expect(computers.asked, isEmpty, reason: 'it runs in the Swarm already');
      expect(key('swarm-agent-failed'), findsNothing);
    });

    testWidgets('a running session is shared into the chat with agent.add, '
        'and its computer is woken to host it', (tester) async {
      await pump(tester);
      runSessions();
      await addSheet(tester);
      await tester.tap(find.text('Fix flaky test'));
      await tester.pumpAndSettle();

      expect(sent(), [
        {
          'type': 'agent.add',
          'conversationId': chat,
          'machineId': 'mac-1',
          'harnessId': 'h-new',
          'name': 'Fix flaky test',
          'lead': false,
          'configuration': {
            'engine': 'claude',
            'model': null,
            'effort': null,
            'contextWindow': null,
            'engineVersion': null,
          },
        },
      ]);
      expect([for (final a in computers.asked) a.$1], ['mac-1']);
      expect(computers.asked.single.$2, {'action': 'wake'});
    });

    testWidgets('a computer that does not answer the wake is named: the agent '
        'stays added, as nothing else may start its host', (tester) async {
      await pump(tester);
      runSessions();
      await addSheet(tester);
      computers.answer = (_, _) =>
          throw const SuperTabFailure('OFFLINE', 'Could not reach it.');
      await tester.tap(find.text('Fix flaky test'));
      await tester.pumpAndSettle();

      expect(sent().single['type'], 'agent.add');
      expect(computers.asked.single.$2, {'action': 'wake'});
      expect(
        find.text(
          "Studio didn't answer, so it may not have picked up Fix flaky test "
          'yet.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('the server\'s refusal is said at the foot of the screen, '
        'and wakes nothing', (tester) async {
      await pump(tester);
      runSessions();
      await addSheet(tester);
      answer = () => throw const SuperTabFailure(
        'TEAM_ACCOUNT_HELD',
        'This machine takes only that project\'s work for now.',
        statusCode: 403,
      );
      await tester.tap(find.text('Fix flaky test'));
      await tester.pumpAndSettle();

      expect(key('swarm-agent-failed'), findsOneWidget);
      expect(
        find.text('This machine takes only that project\'s work for now.'),
        findsOneWidget,
      );
      expect(computers.asked, isEmpty);
    });

    testWidgets('a call lost on the way says so', (tester) async {
      await pump(tester);
      await addSheet(tester);
      answer = () => throw const SocketException('reset');
      await tester.tap(find.text('Ash'));
      await tester.pumpAndSettle();
      expect(
        find.text('Could not reach this Swarm. Try again.'),
        findsOneWidget,
      );
    });

    testWidgets('a row on its way says Adding… and is not sent twice', (
      tester,
    ) async {
      await pump(tester);
      final gate = Completer<void>();
      answer = () async {
        await gate.future;
        return {'ok': true};
      };
      await addSheet(tester);
      await tester.tap(find.text('Ash'));
      await tester.pumpAndSettle();
      await addSheet(tester);

      expect(find.text('Adding…'), findsOneWidget);
      await tester.tap(find.text('Ash'));
      await tester.pumpAndSettle();
      expect(find.text(title), findsOneWidget, reason: 'a dim row stays');
      expect(sent(), hasLength(1));

      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('Adding…'), findsNothing);
      expect(sent(), hasLength(1));
    });

    testWidgets('a session that joined the Swarm since the sheet was drawn '
        'joins as its agent; a long name is cut to what the backend '
        'takes', (tester) async {
      await pump(tester);
      expect(
        await swarmAddAgent(
          reader(),
          chat,
          SwarmAgentChoice.session(session('harness-agent-ash', 'Ash')),
          computers: computers,
        ),
        isNull,
      );
      expect(sent().single, {
        'type': 'conversation.agent',
        'conversationId': chat,
        'agentId': 'agent-ash',
        'present': true,
        'lead': false,
      });

      final long = '  ${'a' * 159}😀 and more  ';
      await swarmAddAgent(
        reader(),
        chat,
        SwarmAgentChoice.session(session('h-long', long)),
      );
      final name = sent().last['name'] as String;
      expect(name, 'a' * 159, reason: 'never half an emoji');
    });

    testWidgets('the sheet goes once the chat can no longer take an agent: '
        'archived elsewhere', (tester) async {
      await pump(tester);
      await addSheet(tester);
      expect(find.text(title), findsOneWidget);
      chatArchived = true;
      await reader().refresh();
      await tester.pumpAndSettle();
      expect(find.text(title), findsNothing);
      expect(sent(), isEmpty);
    });

    testWidgets('nothing is sent where the reader may not add one', (
      tester,
    ) async {
      await pump(tester, role: 'viewer');
      expect(
        await swarmAddAgent(
          reader(),
          chat,
          SwarmAgentChoice.session(session('h-new', 'Fix flaky test')),
        ),
        'This action is no longer available.',
      );
      expect(sent(), isEmpty);
    });
  });

  group('Team: Remove from Swarm', () {
    const page = SwarmProjectPage(
      swarmId: tab,
      projectId: project,
      tabs: SwarmProjectTab.homeC,
    );

    Future<void> team(
      WidgetTester tester, {
      String role = 'owner',
      String owner = me,
    }) async {
      await pump(tester, role: role, owner: owner, home: page);
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-team'));
      await tester.pumpAndSettle();
    }

    Future<void> press(WidgetTester tester, String agentId) async {
      await tester.longPress(key('swarm-member-$agentId'));
      await tester.pumpAndSettle();
    }

    Future<void> askToRemove(WidgetTester tester, String agentId) async {
      await press(tester, agentId);
      await tester.tap(find.text('Remove from Swarm'));
      await tester.pumpAndSettle();
    }

    Finder confirm() => find.widgetWithText(FilledButton, 'Remove from Swarm');

    testWidgets('a long press asks in the desktop\'s words, then sends '
        'agent.remove; the agent is gone from the Team', (tester) async {
      await team(tester);
      await askToRemove(tester, 'agent-ash');

      expect(find.text('Remove Ash from this Swarm?'), findsOneWidget);
      expect(
        find.text(
          'Any open task needs to be assigned again or closed. Its session '
          'on Tony’s Mac will stop.',
        ),
        findsOneWidget,
      );
      expect(sent(), isEmpty);
      await tester.tap(confirm());
      await tester.pumpAndSettle();

      expect(sent(), [
        {'type': 'agent.remove', 'agentId': 'agent-ash'},
      ]);
      expect(key('swarm-member-agent-ash'), findsNothing);
      expect(reader().snapshot!.agent('agent-ash'), isNull);
      expect(key('swarm-agent-failed'), findsNothing);
    });

    testWidgets('its computer is named as the desktop names it: the '
        'person\'s own computer first, then the Swarm\'s record of it, '
        'else "its computer"', (tester) async {
      await team(tester);
      // On a computer used only for agents: the Swarm lists no pool for it.
      agents.add(agent('agent-cy', displayName: 'Cy', machineId: 'mac-9'));
      computers.own = const [
        (id: 'mac-9', name: 'Studio Mac', away: false),
        (id: 'mac-1', name: 'Tony’s MacBook', away: false),
      ];
      await reader().refresh();
      await tester.pumpAndSettle();
      String line(String machine) =>
          'Any open task needs to be assigned again or closed. Its session '
          'on $machine will stop.';

      Future<void> ask(String agentId) async {
        await tester.ensureVisible(key('swarm-member-$agentId'));
        await tester.pumpAndSettle();
        await askToRemove(tester, agentId);
      }

      Future<void> cancel() async {
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
      }

      await ask('agent-cy');
      expect(find.text(line('Studio Mac')), findsOneWidget);
      await cancel();

      // The person's own name for it stands over the Swarm's record.
      await ask('agent-ash');
      expect(find.text(line('Tony’s MacBook')), findsOneWidget);
      await cancel();

      computers.own = const [];
      await ask('agent-cy');
      expect(find.text(line('its computer')), findsOneWidget);
      await cancel();
      expect(sent(), isEmpty);
    });

    testWidgets('the agent leaves the Team at once, and comes back with the '
        'server\'s words when it refuses', (tester) async {
      await team(tester);
      final gate = Completer<void>();
      answer = () async {
        await gate.future;
        throw const SuperTabFailure(
          'WORK_ACTIVE',
          'Finish active work before stopping this worker.',
          statusCode: 409,
        );
      };
      await askToRemove(tester, 'agent-ash');
      await tester.tap(confirm());
      await tester.pumpAndSettle();
      expect(key('swarm-member-agent-ash'), findsNothing);
      expect(SwarmAgentWrites.of(reader()).removing('agent-ash'), isTrue);

      gate.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-member-agent-ash'), findsOneWidget);
      expect(
        find.text('Finish active work before stopping this worker.'),
        findsOneWidget,
      );
    });

    testWidgets('Cancel sends nothing', (tester) async {
      await team(tester);
      await askToRemove(tester, 'agent-ash');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(sent(), isEmpty);
      expect(key('swarm-member-agent-ash'), findsOneWidget);
    });

    testWidgets('a project\'s coordinator is held back, its row naming the '
        'role in a word', (tester) async {
      await team(tester);
      await press(tester, 'agent-lead');
      expect(find.text('Product Manager'), findsOneWidget);
      await tester.tap(find.text('Remove from Swarm'));
      await tester.pumpAndSettle();
      expect(find.text('Remove River from this Swarm?'), findsNothing);
      expect(sent(), isEmpty);
      expect(
        await swarmRemoveAgent(reader(), 'agent-lead'),
        'River is the Product Manager of project Mobile. Delete the project '
        'first.',
      );
      expect(sent(), isEmpty);
    });

    testWidgets('a collaborator removes only their own agents; the Swarm\'s '
        'owner removes any', (tester) async {
      await team(tester, role: 'collaborator', owner: 'person-dee');
      await press(tester, 'agent-bea');
      expect(find.text('Remove from Swarm'), findsNothing);
      expect(swarmAgentRights(reader(), 'agent-bea')?.remove, isFalse);
      expect(swarmAgentRights(reader(), 'agent-ash')?.remove, isTrue);
      expect(
        await swarmRemoveAgent(reader(), 'agent-bea'),
        'This action is no longer available.',
      );
      expect(sent(), isEmpty);
      await press(tester, 'agent-ash');
      expect(find.text('Remove from Swarm'), findsOneWidget);
    });

    testWidgets('the owner may remove another person\'s agent', (tester) async {
      await team(tester);
      expect(swarmAgentRights(reader(), 'agent-bea')?.remove, isTrue);
    });

    testWidgets('a viewer gets no menu', (tester) async {
      await team(tester, role: 'viewer');
      await press(tester, 'agent-ash');
      expect(find.text('Remove from Swarm'), findsNothing);
      expect(key('swarm-team-add-agent'), findsNothing);
    });
  });

  group('Team: Add agent', () {
    const page = SwarmProjectPage(
      swarmId: tab,
      projectId: project,
      tabs: SwarmProjectTab.homeC,
    );

    Future<void> team(WidgetTester tester) async {
      await pump(tester, home: page);
      await tester.tap(key('swarm-project-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-project-menu-team'));
      await tester.pumpAndSettle();
    }

    testWidgets('Add agent ends the Team\'s agents and shares a running '
        'session into the project\'s chat', (tester) async {
      await team(tester);
      runSessions();
      await tester.ensureVisible(key('swarm-team-add-agent'));
      expect(
        y(tester, key('swarm-member-agent-ash')),
        lessThan(y(tester, key('swarm-team-add-agent'))),
      );
      await tester.tap(key('swarm-team-add-agent'));
      await tester.pumpAndSettle();

      expect(find.text(title), findsOneWidget);
      expect(find.text('agents'), findsNothing, reason: '#2207');
      await tester.tap(find.text('Docs'));
      await tester.pumpAndSettle();
      expect(sent().single, {
        'type': 'agent.add',
        'conversationId': leadChat,
        'machineId': 'mac-2',
        'harnessId': 'h-codex',
        'name': 'Docs',
        'lead': false,
        'configuration': {
          'engine': 'codex',
          'model': null,
          'effort': null,
          'contextWindow': null,
          'engineVersion': null,
        },
      });
      expect([for (final a in computers.asked) a.$1], ['mac-2']);
      expect(computers.asked.single.$2, {'action': 'wake'});
    });

    testWidgets('with no session running it says so, and does nothing', (
      tester,
    ) async {
      await team(tester);
      await tester.ensureVisible(key('swarm-team-add-agent'));
      await tester.tap(key('swarm-team-add-agent'));
      await tester.pumpAndSettle();
      expect(find.text('No running agents'), findsOneWidget);
      await tester.tap(find.text('No running agents'));
      await tester.pumpAndSettle();
      expect(find.text(title), findsOneWidget);
      expect(sent(), isEmpty);
    });
  });

  test('the words are the desktop\'s', () {
    final roster = File('../desktop/lib/super_tabs/roster.dart')
        .readAsStringSync();
    final screen = File('../desktop/lib/screens/swarm_screen.dart')
        .readAsStringSync();
    expect(roster, contains("addTooltip: 'Add agent'"));
    expect(roster, contains("'Remove \$name from this Swarm?'"));
    expect(
      roster,
      contains(
        "'Any open task needs to be assigned again or closed. Its session on "
        "\$machine will stop.'",
      ),
    );
    expect(roster, contains("Text(checking ? 'Retry' : 'Remove from Swarm')"));
    expect(roster, contains("'its computer'"));
    expect(screen, contains("'Add agent to \${"));
  });
}
