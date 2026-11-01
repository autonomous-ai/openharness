import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Open terminal in a project chat's ⋮ (Tony, 11-01): first in Swarm Home
/// C's project menu, opening that project's PM's terminal on this phone by
/// the Buddy row's rule (its machine linked here and not reported offline),
/// otherwise dimmed with why: Stopped, Offline or Not linked. Never for a
/// viewer, never another project's PM, and the menu goes with access or the
/// project.
void main() {
  const changesPath = '/api/super-tabs/$tab/changes';
  const other = 'project-2';
  const otherChat = 'group-lead-2';

  Map<String, dynamic> projectData(String id, String name, String chat) => {
    'id': id,
    'name': name,
    'ownerId': me,
    'leadConversationId': chat,
    'visibility': 'public',
    'members': <Object>[],
    'updateMinutes': 5,
  };

  final bothProjects = [
    projectData(project, 'Mobile', leadChat),
    projectData(other, 'Desktop', otherChat),
  ];

  /// Two projects of one Swarm: Mobile, whose PM is River on mac-1 unless
  /// [pm] says otherwise, and Desktop, whose PM is also called River, on
  /// mac-2. Mobile's chat names [leadOf] as its Lead.
  FakeSwarm backend({
    String role = 'owner',
    Map<String, dynamic>? pm,
    String leadOf = 'agent-lead',
    List<Map<String, dynamic>> extra = const [],
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final read = firstLoad(
        head: headData(projects: bothProjects),
        groups: [
          {
            ...groupData(
              otherChat,
              title: 'Desktop',
              agentIds: ['agent-lead-2'],
              leadId: 'agent-lead-2',
            ),
            'projectId': other,
          },
        ],
        agents: [
          pm ?? agent('agent-lead', name: 'Lead', displayName: 'River'),
          {
            ...agent(
              'agent-lead-2',
              name: 'Lead',
              displayName: 'River',
              machineId: 'mac-2',
            ),
            'projectId': other,
          },
          ...extra,
        ],
      );
      // Mobile's own chat, with the Lead it names.
      (read['groups'] as List)[0] = part(
        leadChat,
        1,
        groupData(
          leadChat,
          title: 'Mobile',
          agentIds: [leadOf],
          leadId: leadOf,
        ),
      );
      return {
        ...read,
        'members': [part(me, 1, person(me, role: role))],
      };
    };
    fake.routes[changesPath] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    for (final chat in [leadChat, otherChat]) {
      fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) =>
          {'messages': <Object>[], 'next': null};
    }
    return fake;
  }

  /// The phone's machines as the shell sees them: [opens] those it can open
  /// now; every terminal it was asked to open lands in [opened].
  late Set<String> opens;
  late List<(String, String)> opened;
  late FakeComputers computers;

  setUp(() {
    opens = {'mac-1', 'mac-2'};
    opened = [];
    computers = FakeComputers(const [])
      ..own = const [
        (id: 'mac-1', name: 'Tonys-MacBook-Pro', away: false),
        (id: 'mac-2', name: 'Tonys-Studio', away: false),
      ];
  });

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    String projectId = project,
    ValueNotifier<String?>? account,
  }) async {
    account ??= ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account!.value,
      account: account,
      request: fake.request,
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
        builder: (context, child) => PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (machine, agent) => opened.add((machine, agent)),
          canOpenMachine: opens.contains,
          child: SwarmScope(notifier: host, child: child!),
        ),
        home: SwarmProjectPage(
          swarmId: tab,
          projectId: projectId,
          tabs: SwarmProjectTab.homeC,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  final row = key('swarm-project-menu-terminal');

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(key('swarm-project-menu'));
    await tester.pumpAndSettle();
  }

  bool menuOpen() => find.text('Leaderboard').evaluate().isNotEmpty;

  /// The word at the end of the Open terminal row, or null with none.
  String? word(WidgetTester tester) {
    for (final w in const ['Stopped', 'Offline', 'Not linked']) {
      if (find
          .descendant(of: row, matching: find.text(w))
          .evaluate()
          .isNotEmpty) {
        return w;
      }
    }
    return null;
  }

  bool enabled(WidgetTester tester) =>
      tester.widget<MenuItemButton>(row).onPressed != null;

  /// Taps Open terminal, then: whether the menu stayed open.
  Future<bool> tapRow(WidgetTester tester) async {
    await tester.tap(find.text('Open terminal'), warnIfMissed: false);
    await tester.pumpAndSettle();
    return menuOpen();
  }

  Future<void> refreshWith(
    FakeSwarm fake,
    SwarmHost host, {
    List<Map<String, dynamic>> agents = const [],
    List<Map<String, dynamic>> members = const [],
    List<Map<String, dynamic>> groups = const [],
    Map<String, dynamic>? head,
  }) async {
    fake.routes[changesPath] = (_) => {
      ...changes(cursor: 'c3', lastChangedAt: 200, groups: groups),
      'agents': agents,
      'members': members,
      'head': ?head,
    };
    await host.session!.inbox.reader(tab)!.refresh();
  }

  group('each state', () {
    testWidgets('PM running on a machine this phone opens: first in the '
        "menu, and opens that PM's terminal", (tester) async {
      await pump(tester, backend());
      await openMenu(tester);

      expect(
        tester.getTopLeft(row).dy,
        lessThan(tester.getTopLeft(key('swarm-project-menu-leaderboard')).dy),
        reason: 'above Leaderboard',
      );
      expect(word(tester), isNull);
      expect(enabled(tester), isTrue);

      expect(await tapRow(tester), isFalse, reason: 'the menu closes');
      expect(opened, [('mac-1', 'harness-agent-lead')]);
    });

    testWidgets('no PM in the project chat: dimmed, Stopped, and a tap does '
        'nothing', (tester) async {
      await pump(tester, backend(leadOf: 'agent-gone'));
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(enabled(tester), isFalse);
      expect(await tapRow(tester), isTrue, reason: 'the menu stays');
      expect(opened, isEmpty);
    });

    testWidgets('a PM being stopped: Stopped', (tester) async {
      await pump(
        tester,
        backend(
          pm: {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'workDecision': 'stop',
          },
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('its machine linked here but reported offline: Offline', (
      tester,
    ) async {
      opens = {'mac-2'};
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Offline');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('the Swarm says the PM is down: Offline, even where the '
        'phone could open the machine', (tester) async {
      await pump(
        tester,
        backend(
          pm: {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'downSince': '2026-11-01T07:00:00Z',
          },
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Offline');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('its machine not linked to this phone: Not linked', (
      tester,
    ) async {
      opens = {'mac-2'};
      computers.own = const [(id: 'mac-2', name: 'Tonys-Studio', away: false)];
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Not linked');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('a Team-account machine the phone cannot open: Not linked', (
      tester,
    ) async {
      // A Harness Team account's machine is never among the person's own.
      opens = {};
      computers.own = const [];
      await pump(
        tester,
        backend(
          pm: agent(
            'agent-lead',
            name: 'Lead',
            displayName: 'River',
            machineId: 'team-mac',
          ),
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Not linked');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });
  });

  group('privacy', () {
    testWidgets('a viewer has the menu, but no Open terminal', (tester) async {
      await pump(tester, backend(role: 'viewer'));
      await openMenu(tester);
      expect(find.text('Leaderboard'), findsOneWidget);
      expect(row, findsNothing);
      expect(find.text('Open terminal'), findsNothing);
    });

    testWidgets("two projects, each PM named River: each project's menu "
        'opens its own PM, never the other', (tester) async {
      await pump(tester, backend(), projectId: other);
      await openMenu(tester);
      expect(word(tester), isNull);
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-2', 'harness-agent-lead-2')]);

      opened.clear();
      await pump(tester, backend());
      await openMenu(tester);
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-1', 'harness-agent-lead')]);
    });

    testWidgets("a project chat naming another project's agent as its Lead "
        'opens nothing: Stopped', (tester) async {
      await pump(tester, backend(leadOf: 'agent-lead-2'));
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets("a project chat naming a person's Buddy as its Lead opens "
        'nothing: Stopped', (tester) async {
      await pump(
        tester,
        backend(
          leadOf: 'agent-wren',
          extra: [buddyData('agent-wren', displayName: 'Wren')],
        ),
      );
      await openMenu(tester);
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    test('swarmProjectPm refuses what is not the project\'s own PM', () {
      SuperTabSnapshot snapshot(String leadOf, Map<String, dynamic> lead) =>
          SuperTabSnapshot.fromJson({
            'id': tab,
            'name': 'Phone Swarm',
            'ownerId': me,
            'projects': bothProjects,
            'people': [person(me)],
            'invitations': <Object>[],
            'version': 1,
            'conversations': [
              groupData(leadChat, leadId: leadOf),
              {
                ...groupData(otherChat, leadId: 'agent-lead-2'),
                'projectId': other,
              },
            ],
            'agents': [
              lead,
              {...agent('agent-lead-2'), 'projectId': other},
            ],
          });
      expect(
        swarmProjectPm(
          snapshot('agent-lead', agent('agent-lead')),
          project,
        )?.id,
        'agent-lead',
      );
      expect(
        swarmProjectPm(snapshot('agent-lead', agent('agent-lead')), other)?.id,
        'agent-lead-2',
      );
      expect(
        swarmProjectPm(snapshot('agent-lead-2', agent('agent-lead')), project),
        isNull,
      );
      expect(
        swarmProjectPm(
          snapshot('agent-lead', buddyData('agent-lead')),
          project,
        ),
        isNull,
      );
      expect(
        swarmProjectPm(
          snapshot('agent-lead', agent('agent-lead')),
          'project-gone',
        ),
        isNull,
      );
      expect(swarmProjectPm(null, project), isNull);
    });
  });

  group('lifecycle', () {
    testWidgets('access lost with the menu open closes it', (tester) async {
      final host = await pump(tester, backend());
      await openMenu(tester);
      expect(row, findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(menuOpen(), isFalse);
      expect(find.text('Open terminal'), findsNothing);
      expect(opened, isEmpty);
    });

    testWidgets(
      'the project taken off the Swarm with the menu open closes it',
      (tester) async {
        final fake = backend();
        final host = await pump(tester, fake);
        await openMenu(tester);
        expect(row, findsOneWidget);

        await refreshWith(
          fake,
          host,
          head: part('head', 2, headData(projects: [bothProjects[1]])),
        );
        await tester.pumpAndSettle();
        expect(menuOpen(), isFalse);
        expect(find.text('Open terminal'), findsNothing);
        expect(opened, isEmpty);
      },
    );

    testWidgets('signing out with the menu open closes it', (tester) async {
      final account = ValueNotifier<String?>(me);
      await pump(tester, backend(), account: account);
      await openMenu(tester);
      expect(row, findsOneWidget);

      account.value = null;
      await tester.pumpAndSettle();
      expect(menuOpen(), isFalse);
      expect(find.text('Open terminal'), findsNothing);
      expect(opened, isEmpty);
    });

    testWidgets('losing write access with the menu open takes the row away', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openMenu(tester);
      expect(row, findsOneWidget);

      await refreshWith(
        fake,
        host,
        members: [part(me, 2, person(me, role: 'viewer'))],
      );
      await tester.pumpAndSettle();
      expect(row, findsNothing);
      expect(opened, isEmpty);
    });

    testWidgets('the PM stopped elsewhere with the menu open dims the row', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openMenu(tester);
      expect(word(tester), isNull);

      await refreshWith(
        fake,
        host,
        agents: [
          part('agent-lead', 9, {
            ...agent('agent-lead', name: 'Lead', displayName: 'River'),
            'workDecision': 'stop',
          }),
        ],
      );
      await tester.pumpAndSettle();
      expect(word(tester), 'Stopped');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('a machine the phone lost between the menu and the tap is '
        'not opened', (tester) async {
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), isNull);

      // The shell's own word changes without telling the menu.
      opens.clear();
      expect(await tapRow(tester), isFalse);
      expect(opened, isEmpty);
    });

    testWidgets("the project's PM replaced while the menu is open: the tap "
        'opens the one shown, and never the one it replaced', (tester) async {
      final fake = backend(
        extra: [agent('agent-nova', displayName: 'Nova', machineId: 'mac-2')],
      );
      final host = await pump(tester, fake);
      await openMenu(tester);

      await refreshWith(
        fake,
        host,
        groups: [
          part(
            leadChat,
            5,
            groupData(
              leadChat,
              title: 'Mobile',
              agentIds: ['agent-nova'],
              leadId: 'agent-nova',
            ),
          ),
        ],
      );
      await tester.pumpAndSettle();
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-2', 'harness-agent-nova')]);
    });

    testWidgets("the phone's computers answering late, with the menu open, "
        'enables the row', (tester) async {
      // A first read of the machines that had not answered: nothing linked.
      opens = {};
      computers.own = const [];
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), 'Not linked');

      opens.add('mac-1');
      computers
        ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: false)]
        ..notifyListeners();
      await tester.pumpAndSettle();
      expect(word(tester), isNull);
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-1', 'harness-agent-lead')]);
    });

    testWidgets('the machine going offline with the menu open dims the row', (
      tester,
    ) async {
      await pump(tester, backend());
      await openMenu(tester);
      expect(word(tester), isNull);

      opens.remove('mac-1');
      computers
        ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: true)]
        ..notifyListeners();
      await tester.pumpAndSettle();
      expect(word(tester), 'Offline');
      expect(await tapRow(tester), isTrue);
      expect(opened, isEmpty);
    });

    testWidgets('a first read that fails, then recovers on a pull, has the '
        'row and opens the PM', (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      var fail = true;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => fail
          ? throw const SuperTabFailure('INTERNAL', 'Swarm is down.')
          : parts(body);
      await pump(tester, fake);
      expect(key('swarm-project-menu'), findsNothing);
      expect(find.text('Loading…'), findsNothing, reason: 'no stuck Loading');

      fail = false;
      await tester.fling(find.byType(ListView), const Offset(0, 400), 1000);
      await tester.pumpAndSettle();
      await openMenu(tester);
      expect(word(tester), isNull);
      expect(await tapRow(tester), isFalse);
      expect(opened, [('mac-1', 'harness-agent-lead')]);
    });
  });
}
