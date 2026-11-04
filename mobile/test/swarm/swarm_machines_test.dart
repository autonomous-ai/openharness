import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/swarm/swarm_devices_page.dart';
import 'package:harness_mobile/swarm/swarm_machine_menu.dart';
import 'package:harness_mobile/swarm/swarm_machines.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

Map<String, dynamic> machinePool(
  String id,
  String name, {
  String? host,
  String owner = me,
  int? receivedAt,
  num cpu = 25,
  String deviceType = 'MacBook Pro',
}) => {
  'machineId': id,
  'name': name,
  'contributorId': owner,
  'hostMachineId': ?host,
  'engines': ['claude', 'codex'],
  'observation': {
    'receivedAt': receivedAt ?? DateTime.now().millisecondsSinceEpoch,
    'resources': {
      'cpuPercent': cpu,
      'gpuPercent': 40,
      'memoryTotalBytes': 16 * 1073741824,
      'memoryUsedBytes': 4 * 1073741824,
      'diskTotalBytes': 512 * 1073741824,
      'diskFreeBytes': 128 * 1073741824,
      'chip': 'Apple M2',
      'deviceType': deviceType,
      'os': 'macOS',
    },
    'quotas': [
      {
        'engine': 'claude',
        'known': true,
        'windows': [
          {
            'name': 'Session',
            'usedPercent': 20,
            'resetsAt': DateTime.now()
                .add(const Duration(hours: 2))
                .millisecondsSinceEpoch,
          },
        ],
      },
    ],
  },
};

void main() {
  late SwarmHost host;
  late FakeSwarm fake;
  Future<void> open(
    WidgetTester tester, {
    List<Map<String, dynamic>>? machines,
    List<Map<String, dynamic>>? agents,
    String role = 'owner',
    Map<String, dynamic>? localModels,
    String? memberName,
    void Function(FakeSwarm fake)? routes,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    final rows = machines ?? [machinePool('mac-1', 'Tony’s Mac')];
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        agents: agents,
        head: localModels == null
            ? null
            : {...headData(), 'localModels': localModels},
      ),
      'members': [
        part(me, 1, {...person(me, role: role), 'name': ?memberName}),
      ],
      'machines': [for (final m in rows) part(m['machineId'] as String, 1, m)],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => {'result': {}};
    routes?.call(fake);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => me,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
    addTearDown(host.dispose);
    await host.session!.inbox.refresh();
    await tester.pumpWidget(
      MaterialApp(
        builder: (_, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmDevicesPage(),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder key(String s) => find.byKey(ValueKey(s));

  testWidgets(
    "the Swarm's machines are on Your devices (Lead, 10-29), and collapse",
    (tester) async {
      await open(tester);
      expect(key('swarm-machine-$tab-mac-1'), findsOneWidget);
      expect(find.text('Machines'), findsOneWidget);
      await tester.tap(key('swarm-machines-$tab'));
      await tester.pumpAndSettle();
      expect(key('swarm-machine-$tab-mac-1'), findsNothing);
      await tester.tap(key('swarm-machines-$tab'));
      await tester.pumpAndSettle();
      expect(find.text('Tony’s Mac'), findsOneWidget);
    },
  );

  testWidgets(
    'tap shows capacity, allowance reset and running agents, without Remove or Configure',
    (tester) async {
      await open(tester);
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      // What is free, in Desktop's words and units (machine_details.dart).
      expect(find.text('Available capacity'), findsOneWidget);
      expect(find.text('CPU'), findsOneWidget);
      expect(find.text('75%'), findsOneWidget);
      expect(find.text('60%'), findsOneWidget);
      expect(find.text('13 GB of 17 GB'), findsOneWidget);
      expect(find.text('137 GB of 550 GB'), findsOneWidget);
      expect(find.text('Model allowances'), findsOneWidget);
      expect(find.text('Claude Code'), findsOneWidget);
      expect(find.text('Session'), findsOneWidget);
      expect(find.textContaining('80% left · resets in '), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SwarmMachineSheet),
          matching: find.text('River'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(SwarmMachineSheet),
          matching: find.text('Nova'),
        ),
        findsOneWidget,
      );
      // Management lives in the long-press menu; Details holds only Pause/Resume, for who lent the machine.
      for (final text in ['Remove', 'Remove from Swarm', 'Configure']) {
        expect(find.text(text), findsNothing);
      }
    },
  );

  testWidgets("a machine's agents leave Buddies out (Ken, 10-29)", (
    tester,
  ) async {
    await open(
      tester,
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        buddyData('agent-wren', displayName: 'Wren'),
        buddyData('agent-ivy', owner: 'person-dee', displayName: 'Ivy'),
        buddyData('agent-oak', owner: 'person-kai', displayName: 'Oak'),
      ],
    );
    expect(find.text('1 agent'), findsOneWidget);

    await tester.tap(key('swarm-machine-$tab-mac-1'));
    await tester.pumpAndSettle();
    for (final name in ['Wren', 'Ivy', 'Oak']) {
      expect(
        find.descendant(
          of: find.byType(SwarmMachineSheet),
          matching: find.text(name),
        ),
        findsNothing,
      );
    }
    expect(
      find.descendant(
        of: find.byType(SwarmMachineSheet),
        matching: find.text('River'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('Team account folds into Mac; its readings shown to teammates', (
    tester,
  ) async {
    await open(
      tester,
      machines: [
        machinePool('mac-1', 'Shared Mac', owner: 'other', cpu: 99),
        machinePool(
          'team-1',
          'Team account',
          owner: 'other',
          host: 'mac-1',
          cpu: 12,
        ),
      ],
      agents: [agent('dev', displayName: 'Robin', machineId: 'team-1')],
    );
    expect(key('swarm-machine-$tab-team-1'), findsNothing);
    await tester.tap(key('swarm-machine-$tab-mac-1'));
    await tester.pumpAndSettle();
    expect(find.text('88%'), findsOneWidget);
    expect(find.text('1%'), findsNothing);
    expect(find.text('Robin'), findsOneWidget);
  });

  testWidgets(
    'offline machine keeps identity and hides stale capacity and quotas',
    (tester) async {
      await open(
        tester,
        machines: [
          machinePool(
            'mac-1',
            'Away Mac',
            receivedAt: DateTime.now()
                .subtract(const Duration(minutes: 2))
                .millisecondsSinceEpoch,
          ),
        ],
      );
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      expect(find.text('Offline'), findsWidgets);
      expect(find.text('75%'), findsNothing);
      expect(find.textContaining('80% left'), findsNothing);
      // As Desktop's details: old readings leave their sections out, never shown as current.
      expect(find.text('Available capacity'), findsNothing);
      expect(find.text('Model allowances'), findsNothing);
      expect(find.text('Device'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(SwarmMachineSheet),
          matching: find.text('Away Mac'),
        ),
        findsNWidgets(2),
      );
      expect(find.text('Claude, Codex'), findsOneWidget);
    },
  );
  testWidgets(
    'an open sheet clears private readings when Swarm is turned off',
    (tester) async {
      await open(tester);
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      host.features.value = const {};
      await tester.pumpAndSettle();
      expect(find.text('75%'), findsNothing);
      expect(find.text('Access ended'), findsOneWidget);
    },
  );

  testWidgets(
    'a failed read hides current numbers instead of reporting offline',
    (tester) async {
      await open(tester);
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Unavailable');
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text("Can't reach Harness"), findsWidgets);
      expect(find.text('75%'), findsNothing);
      expect(find.text('Offline'), findsNothing);
    },
  );

  testWidgets('the owner reads their Mac rather than its Team account', (
    tester,
  ) async {
    await open(
      tester,
      machines: [
        machinePool('mac-1', 'My Mac', cpu: 31),
        machinePool('team-1', 'Team', host: 'mac-1', cpu: 98),
      ],
    );
    await tester.tap(key('swarm-machine-$tab-mac-1'));
    await tester.pumpAndSettle();
    expect(find.text('69%'), findsOneWidget);
    expect(find.text('2%'), findsNothing);
  });

  testWidgets(
    'expired allowances are unavailable and down agents are omitted',
    (tester) async {
      final pool = machinePool('mac-1', 'Mac');
      final observation = pool['observation'] as Map<String, dynamic>;
      observation['quotas'] = [
        {
          'engine': 'claude',
          'known': true,
          'windows': [
            {
              'name': 'Session',
              'usedPercent': 20,
              'resetsAt': DateTime.now()
                  .subtract(const Duration(minutes: 1))
                  .millisecondsSinceEpoch,
            },
          ],
        },
      ];
      await open(
        tester,
        machines: [pool],
        agents: [
          {
            ...agent('gone', displayName: 'Gone'),
            'downSince': '2026-01-01T00:00:00Z',
          },
        ],
      );
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      expect(find.textContaining('80% left'), findsNothing);
      // An allowance with no figure is left out, as Desktop's details leave it out.
      expect(find.text('Model allowances'), findsNothing);
      expect(find.text('Gone'), findsNothing);
      expect(find.text('No agents running'), findsOneWidget);
    },
  );
  testWidgets('an agent-only machine with no observation still opens safely', (
    tester,
  ) async {
    await open(tester, machines: []);
    await tester.tap(key('swarm-machine-$tab-mac-1'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final owner = host.session!.inbox.reader(tab)!.snapshot!.people.single;
    // The Swarm knows no name for it: Desktop names it by its owner.
    expect(
      find.descendant(
        of: find.byType(SwarmMachineSheet),
        matching: find.text("${owner.username}'s computer"),
      ),
      findsNWidgets(2),
    );
    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Available capacity'), findsNothing);
    expect(find.text('Engines'), findsNothing);
  });
  testWidgets(
    'hardware labels and values share a row, label left and value right',
    (tester) async {
      await open(tester);
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      final label = find.text('CPU');
      final value = find.text('75%');
      expect(
        tester.getTopLeft(label).dy,
        closeTo(tester.getTopLeft(value).dy, 1),
      );
      expect(
        tester.getTopRight(label).dx,
        lessThan(tester.getTopLeft(value).dx),
      );
    },
  );

  testWidgets('Mac Studio has a desktop icon and MacBook has a laptop icon', (
    tester,
  ) async {
    await open(
      tester,
      machines: [
        machinePool('mac-1', 'MacBook Pro'),
        machinePool('studio', 'MAC-Mac-Studio', deviceType: 'Mac Studio'),
      ],
    );
    expect(
      find.descendant(
        of: key('swarm-machine-$tab-studio'),
        matching: find.byIcon(LucideIcons.monitor300),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: key('swarm-machine-$tab-mac-1'),
        matching: find.byIcon(LucideIcons.laptop300),
      ),
      findsOneWidget,
    );
  });

  group('long-press menu (Huy, 11-02)', () {
    // No Product Manager on the machine, which would hold Remove back.
    final plain = [agent('agent-builder', displayName: 'Nova')];

    Future<void> press(WidgetTester tester, [String id = 'mac-1']) async {
      await tester.longPress(key('swarm-machine-$tab-$id'));
      await tester.pumpAndSettle();
    }

    Map<String, dynamic> preview({
      List<Map<String, dynamic>> agents = const [],
      List<Map<String, dynamic>> projects = const [],
      Map<String, dynamic>? blockedBy,
      int hiddenAgentCount = 0,
      int hiddenSoleSourceProjectCount = 0,
    }) => {
      'previewVersion': 2,
      'blockedBy': blockedBy,
      'agents': agents,
      'hiddenAgentCount': hiddenAgentCount,
      'soleSourceProjects': projects,
      'hiddenSoleSourceProjectCount': hiddenSoleSourceProjectCount,
    };

    int removalReads() => fake.calls
        .where((c) => c.path.contains('/machines/mac-1/removal'))
        .length;

    testWidgets(
      'the person who lent a machine sees Details, Pause and Remove',
      (tester) async {
        await open(tester, agents: plain);
        await press(tester);
        expect(find.text('Details'), findsOneWidget);
        expect(find.text('Pause new work'), findsOneWidget);
        expect(find.text('Remove from Swarm'), findsOneWidget);
        expect(find.byType(SwarmMachineSheet), findsNothing);
      },
    );

    testWidgets(
      'a machine that runs a Product Manager holds Remove back, and says so briefly',
      (tester) async {
        await open(tester);
        await press(tester);
        expect(find.text('Has a Product Manager'), findsOneWidget);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();
        expect(fake.calls.where((c) => c.path.endsWith('/removal')), isEmpty);
        expect(fake.commands, isEmpty);
        expect(find.text('Pause new work'), findsOneWidget);
      },
    );

    testWidgets('someone else’s machine offers Details alone', (tester) async {
      await open(
        tester,
        agents: plain,
        machines: [machinePool('mac-1', 'Dee’s Mac', owner: 'person-dee')],
      );
      await press(tester);
      expect(find.text('Details'), findsOneWidget);
      expect(find.text('Pause new work'), findsNothing);
      expect(find.text('Remove from Swarm'), findsNothing);
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmMachineSheet), findsOneWidget);
      expect(key('swarm-machine-pause'), findsNothing);
    });

    testWidgets(
      'a reader who may not write cannot remove, but still pauses their own',
      (tester) async {
        await open(tester, agents: plain, role: 'viewer');
        await press(tester);
        expect(find.text('Pause new work'), findsOneWidget);
        expect(find.text('Remove from Swarm'), findsNothing);
      },
    );

    testWidgets('a machine being removed offers neither Pause nor Remove', (
      tester,
    ) async {
      await open(
        tester,
        agents: plain,
        machines: [
          {
            ...machinePool('mac-1', 'Tony’s Mac'),
            'removal': {'state': 'cleaning'},
          },
        ],
      );
      await press(tester);
      expect(find.text('Details'), findsOneWidget);
      expect(find.text('Pause new work'), findsNothing);
      expect(find.text('Remove from Swarm'), findsNothing);
    });

    testWidgets(
      'Pause new work sends machine.pause; a paused machine offers Resume',
      (tester) async {
        await open(tester, agents: plain);
        await press(tester);
        await tester.tap(find.text('Pause new work'));
        await tester.pumpAndSettle();
        expect(fake.commands, [
          {'type': 'machine.pause', 'machineId': 'mac-1', 'paused': true},
        ]);
        await tester.pumpWidget(const SizedBox());
        await open(
          tester,
          machines: [
            {...machinePool('mac-1', 'Tony’s Mac'), 'paused': true},
          ],
        );
        await press(tester);
        expect(find.text('Resume new work'), findsOneWidget);
        await tester.tap(find.text('Resume new work'));
        await tester.pumpAndSettle();
        expect(fake.commands.last['paused'], isFalse);
      },
    );

    testWidgets(
      'Details carries Pause/Resume for the lender and sends the same command',
      (tester) async {
        await open(tester, agents: plain);
        await tester.tap(key('swarm-machine-$tab-mac-1'));
        await tester.pumpAndSettle();
        await tester.dragUntilVisible(
          key('swarm-machine-pause'),
          find.byType(SingleChildScrollView).last,
          const Offset(0, -200),
        );
        await tester.tap(key('swarm-machine-pause'));
        await tester.pumpAndSettle();
        expect(fake.commands, [
          {'type': 'machine.pause', 'machineId': 'mac-1', 'paused': true},
        ]);
      },
    );

    testWidgets('a refused pause says why and changes nothing', (tester) async {
      await open(
        tester,
        agents: plain,
        routes: (f) => f.routes['/api/super-tabs/$tab/commands'] = (_) =>
            throw SuperTabFailure(
              'OWNER_REQUIRED',
              'Only its contributor can change this machine.',
              statusCode: 403,
            ),
      );
      await press(tester);
      await tester.tap(find.text('Pause new work'));
      await tester.pumpAndSettle();
      expect(
        find.text('Only its contributor can change this machine.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'Remove asks with what stops and is deleted, then sends machine.remove',
      (tester) async {
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  preview(
                    agents: [
                      {
                        'name': 'Nova',
                        'projectName': 'Mobile',
                        'task': 'Fix sync',
                      },
                    ],
                    projects: [
                      {'name': 'Beacon'},
                    ],
                  ),
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();
        expect(
          fake.calls.singleWhere((c) => c.path.contains('/removal')).path,
          '/api/super-tabs/$tab/machines/mac-1/removal/v2',
        );
        expect(find.text('Remove Tony’s Mac from this Swarm?'), findsOneWidget);
        expect(find.textContaining('Nova · Mobile'), findsOneWidget);
        expect(
          find.textContaining('“Fix sync” loses its agent'),
          findsOneWidget,
        );
        expect(find.textContaining('Beacon'), findsOneWidget);
        expect(
          find.textContaining('Swarm folders on this machine will be deleted'),
          findsOneWidget,
        );
        expect(fake.commands, isEmpty);
        await tester.tap(
          find.widgetWithText(FilledButton, 'Remove from Swarm'),
        );
        await tester.pumpAndSettle();
        expect(fake.commands, [
          {'type': 'machine.remove', 'machineId': 'mac-1'},
        ]);
      },
    );

    testWidgets(
      'Remove counts hidden agents and projects without naming them',
      (tester) async {
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  preview(
                    agents: [
                      {
                        'name': 'Nova',
                        'projectName': 'Mobile',
                        'task': 'Fix sync',
                      },
                    ],
                    projects: [
                      {'name': 'Beacon'},
                    ],
                    hiddenAgentCount: 2,
                    hiddenSoleSourceProjectCount: 1,
                  ),
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();

        expect(find.textContaining('Nova · Mobile'), findsOneWidget);
        expect(
          find.textContaining('“Fix sync” loses its agent'),
          findsOneWidget,
        );
        expect(find.textContaining('Beacon'), findsOneWidget);
        expect(
          find.textContaining("2 agents of projects you can't see"),
          findsOneWidget,
        );
        expect(
          find.textContaining(
            "1 project you can't see has code only on this machine",
          ),
          findsOneWidget,
        );
        expect(find.textContaining('Secret'), findsNothing);
        expect(fake.commands, isEmpty);
      },
    );

    testWidgets(
      'a Buddy with no project is listed by its name alone, and Remove still works',
      (tester) async {
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  preview(
                    agents: [
                      {'name': 'Wren', 'projectName': ''},
                    ],
                  ),
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();
        expect(find.textContaining('from this Swarm?'), findsOneWidget);
        expect(find.text('Could not check this machine.'), findsNothing);
        expect(find.textContaining('Wren'), findsOneWidget);
        expect(find.textContaining('Wren ·'), findsNothing);
        await tester.tap(
          find.widgetWithText(FilledButton, 'Remove from Swarm'),
        );
        await tester.pumpAndSettle();
        expect(fake.commands, [
          {'type': 'machine.remove', 'machineId': 'mac-1'},
        ]);
      },
    );

    testWidgets('cancelling the question sends nothing', (tester) async {
      await open(
        tester,
        agents: plain,
        routes: (f) =>
            f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                preview(),
      );
      await press(tester);
      await tester.tap(find.text('Remove from Swarm'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(fake.commands, isEmpty);
    });

    testWidgets(
      'a Product Manager on the machine blocks it, with no question',
      (tester) async {
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  preview(
                    blockedBy: {'projectId': project, 'projectName': 'Mobile'},
                  ),
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();
        expect(find.textContaining('Delete the project first'), findsOneWidget);
        expect(
          find.textContaining('Remove Tony’s Mac from this Swarm?'),
          findsNothing,
        );
        expect(fake.commands, isEmpty);
      },
    );

    testWidgets(
      'an unreadable Product Manager blocks with the generic reason',
      (tester) async {
        const reason = "A Product Manager of a project you can't see runs on this machine.";
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  preview(blockedBy: {'reason': reason}),
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();

        expect(find.text(reason), findsOneWidget);
        expect(find.text('Could not check this machine.'), findsNothing);
        expect(
          find.textContaining('Remove Tony’s Mac from this Swarm?'),
          findsNothing,
        );
        expect(fake.commands, isEmpty);
      },
    );

    testWidgets(
      'fails closed when the backend lacks the versioned preview',
      (tester) async {
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) => {
                'blockedBy': null,
                'agents': <Object>[],
                'soleSourceProjects': <Object>[],
              },
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();

        expect(find.text('Could not check this machine.'), findsOneWidget);
        expect(
          find.text('Remove Tony’s Mac from this Swarm?'),
          findsNothing,
        );
        expect(fake.commands, isEmpty);
      },
    );

    testWidgets(
      'a failed read of what would happen shows no question and sends nothing, and retries later',
      (tester) async {
        var fail = true;
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  fail ? throw StateError('socket') : preview(),
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();
        expect(find.text('Could not check this machine.'), findsOneWidget);
        expect(find.textContaining('from this Swarm?'), findsNothing);
        expect(fake.commands, isEmpty);
        fail = false;
        await tester.pump(const Duration(seconds: 5));
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pumpAndSettle();
        expect(find.textContaining('from this Swarm?'), findsOneWidget);
        expect(removalReads(), 2);
      },
    );

    testWidgets(
      'access ending while the question is being read shows and sends nothing',
      (tester) async {
        final gate = Completer<Map<String, dynamic>>();
        await open(
          tester,
          agents: plain,
          routes: (f) =>
              f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                  gate.future,
        );
        await press(tester);
        await tester.tap(find.text('Remove from Swarm'));
        await tester.pump();
        host.session!.inbox.reader(tab)!.revoke();
        gate.complete(preview());
        await tester.pumpAndSettle();
        expect(find.textContaining('from this Swarm?'), findsNothing);
        expect(fake.commands, isEmpty);
      },
    );

    testWidgets('access ending while the question is open sends nothing', (
      tester,
    ) async {
      await open(
        tester,
        agents: plain,
        routes: (f) =>
            f.routes['/api/super-tabs/$tab/machines/mac-1/removal'] = (_) =>
                preview(),
      );
      await press(tester);
      await tester.tap(find.text('Remove from Swarm'));
      await tester.pumpAndSettle();
      host.session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Remove from Swarm'));
      await tester.pumpAndSettle();
      expect(fake.commands, isEmpty);
    });

    testWidgets('the menu closes when access ends under it', (tester) async {
      await open(tester, agents: plain);
      await press(tester);
      expect(find.text('Pause new work'), findsOneWidget);
      // The sheet's title beside the row's own name.
      expect(find.text('Tony’s Mac'), findsNWidgets(2));
      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();
      expect(find.text('Pause new work'), findsNothing);
      expect(find.text('Details'), findsNothing);
      // The sheet itself is gone, not just emptied.
      expect(find.text('Tony’s Mac'), findsNothing);
    });

    testWidgets(
      'a machine lost from the Swarm closes its menu, and an id from elsewhere offers nothing',
      (tester) async {
        await open(tester, agents: plain);
        final reader = host.session!.inbox.reader(tab)!;
        expect(swarmMachineRights(reader, 'someone-elses-machine'), isNull);
        expect(swarmMachineRights(reader, 'mac-1'), isNotNull);
      },
    );
  });

  group("details, as Desktop's machine details show them", () {
    Finder inSheet(Finder finder) =>
        find.descendant(of: find.byType(SwarmMachineSheet), matching: finder);

    Future<void> details(WidgetTester tester, [String id = 'mac-1']) async {
      await tester.tap(key('swarm-machine-$tab-$id'));
      await tester.pumpAndSettle();
    }

    double top(WidgetTester tester, String text) =>
        tester.getTopLeft(inSheet(find.text(text)).first).dy;

    testWidgets(
      'Owner and Status come first; Details names the computer, its hardware and engines',
      (tester) async {
        await open(tester);
        await details(tester);
        final owner = host.session!.inbox.reader(tab)!.snapshot!.people.single;
        expect(inSheet(find.text('Owner')), findsOneWidget);
        expect(inSheet(find.text(owner.username)), findsOneWidget);
        expect(inSheet(find.text('Online')), findsOneWidget);
        expect(top(tester, 'Owner'), lessThan(top(tester, 'Status')));
        expect(
          top(tester, 'Status'),
          lessThan(top(tester, 'Available capacity')),
        );
        expect(
          top(tester, 'Model allowances'),
          lessThan(top(tester, 'Details')),
        );
        for (final (label, value) in [
          ('Computer', 'Tony’s Mac'),
          ('Device', 'MacBook Pro'),
          ('Chip', 'Apple M2'),
          ('System', 'macOS'),
          ('Engines', 'Claude, Codex'),
        ]) {
          expect(inSheet(find.text(label)), findsOneWidget, reason: label);
          expect(
            tester.getTopLeft(inSheet(find.text(label))).dy,
            closeTo(tester.getTopLeft(inSheet(find.text(value)).last).dy, 1),
            reason: label,
          );
        }
        // Nothing the Swarm's models add while they are off.
        expect(key('swarm-machine-local-models-mac-1'), findsNothing);
        expect(find.text('Models for this Swarm'), findsNothing);
      },
    );

    testWidgets(
      "its state in Desktop's words: late is online, pauses and cleaning say so",
      (tester) async {
        final ago = DateTime.now()
            .subtract(const Duration(seconds: 25))
            .millisecondsSinceEpoch;
        final away = DateTime.now()
            .subtract(const Duration(minutes: 2))
            .millisecondsSinceEpoch;
        for (final (pool, status) in [
          (machinePool('mac-1', 'Mac', receivedAt: ago), 'Online'),
          (
            {...machinePool('mac-1', 'Mac'), 'paused': true},
            'New work paused',
          ),
          (
            {...machinePool('mac-1', 'Mac', receivedAt: away), 'paused': true},
            'Offline, new work paused',
          ),
          (
            {
              ...machinePool('mac-1', 'Mac'),
              'removal': {'state': 'cleaning'},
            },
            'Cleaning up',
          ),
        ]) {
          await open(tester, machines: [pool]);
          await details(tester);
          expect(inSheet(find.text(status)), findsOneWidget, reason: status);
          expect(inSheet(find.text('Late')), findsNothing);
          await tester.pumpWidget(const SizedBox());
        }
      },
    );

    testWidgets(
      'each allowance by its provider, the window that stops work first on top, low shares coloured',
      (tester) async {
        final pool = machinePool('mac-1', 'Mac');
        final later = DateTime.now().add(const Duration(days: 3, hours: 1));
        (pool['observation'] as Map<String, dynamic>)['quotas'] = [
          {
            'engine': 'claude',
            'known': true,
            'windows': [
              {
                'name': 'Session',
                'usedPercent': 20,
                'resetsAt': DateTime.now()
                    .add(const Duration(hours: 2, minutes: 30))
                    .millisecondsSinceEpoch,
              },
              {
                'name': 'Weekly',
                'usedPercent': 96.5,
                'resetsAt': later.millisecondsSinceEpoch ~/ 1000,
              },
            ],
          },
          // Its windows name nothing: its one figure stands for them.
          {
            'engine': 'codex',
            'known': true,
            'windows': [
              {'name': '', 'usedPercent': 50},
            ],
          },
          // An engine the details do not read.
          {
            'engine': 'opencode',
            'known': true,
            'windows': [
              {'name': 'Daily', 'usedPercent': 10},
            ],
          },
        ];
        await open(tester, machines: [pool]);
        await details(tester);
        expect(inSheet(find.text('Claude Code')), findsOneWidget);
        expect(inSheet(find.text('Codex')), findsOneWidget);
        expect(inSheet(find.text('50% left')), findsOneWidget);
        expect(inSheet(find.text('Daily')), findsNothing);
        final weekly = find.text('3.5% left · resets in 3d');
        expect(inSheet(weekly), findsOneWidget);
        expect(
          inSheet(find.textContaining('80% left · resets in 2h')),
          findsOneWidget,
        );
        expect(top(tester, 'Weekly'), lessThan(top(tester, 'Session')));
        expect(
          tester.widget<Text>(weekly).style?.color,
          AppPalette.usageCritical,
        );
        expect(
          tester
              .widget<Text>(find.textContaining('80% left · resets in'))
              .style
              ?.color,
          AppPalette.textPrimary,
        );
      },
    );

    testWidgets(
      "a teammate reads a Mac's allowances from the Mac, its capacity from its Team account",
      (tester) async {
        Map<String, dynamic> withClaude(Map<String, dynamic> pool, num used) {
          (pool['observation'] as Map<String, dynamic>)['quotas'] = [
            {
              'engine': 'claude',
              'known': true,
              'windows': [
                {'name': 'Session', 'usedPercent': used},
              ],
            },
          ];
          return pool;
        }

        await open(
          tester,
          machines: [
            withClaude(
              machinePool('mac-1', 'Shared Mac', owner: 'other', cpu: 99),
              20,
            ),
            withClaude(
              machinePool(
                'team-1',
                'Team account',
                owner: 'other',
                host: 'mac-1',
                cpu: 12,
              ),
              70,
            ),
          ],
        );
        await details(tester);
        expect(inSheet(find.text('88%')), findsOneWidget);
        expect(inSheet(find.text('80% left')), findsOneWidget);
        expect(inSheet(find.text('30% left')), findsNothing);
      },
    );

    testWidgets(
      'Models for this Swarm lists what a fresh reading serves, by kind',
      (tester) async {
        Map<String, dynamic> serving({int? receivedAt}) {
          final pool = machinePool('mac-1', 'Mac', receivedAt: receivedAt);
          (pool['observation'] as Map<String, dynamic>)['localModels'] = [
            {
              'grid': 'swarm-grid',
              'model': 'deepseek/deepseek-v3',
              'kind': 'api',
              'name': 'deepseek-v3 · OpenRouter',
            },
            {
              'grid': 'swarm-grid',
              'model': 'qwen3:8b',
              'kind': 'local',
              'name': 'Qwen3 8B',
            },
            {'grid': 'swarm-grid', 'model': 'llama:70b', 'starting': true},
            {'grid': 'another-grid', 'model': 'gemma', 'kind': 'shared'},
          ];
          return pool;
        }

        const models = {'grid': 'swarm-grid', 'enabled': true, 'ready': true};
        await open(tester, machines: [serving()], localModels: models);
        await details(tester);
        await tester.dragUntilVisible(
          key('swarm-machine-local-models-mac-1'),
          inSheet(find.byType(SingleChildScrollView)),
          const Offset(0, -200),
        );
        expect(find.text('Models for this Swarm'), findsOneWidget);
        expect(find.text('deepseek-v3'), findsOneWidget);
        expect(find.text('Qwen3 8B'), findsOneWidget);
        expect(find.textContaining('llama'), findsNothing);
        expect(find.textContaining('gemma'), findsNothing);
        await tester.pumpWidget(const SizedBox());

        // An offline machine's old reading serves nothing now.
        await open(
          tester,
          machines: [
            serving(
              receivedAt: DateTime.now()
                  .subtract(const Duration(minutes: 2))
                  .millisecondsSinceEpoch,
            ),
          ],
          localModels: models,
        );
        await details(tester);
        await tester.dragUntilVisible(
          key('swarm-machine-local-models-mac-1'),
          inSheet(find.byType(SingleChildScrollView)),
          const Offset(0, -200),
        );
        expect(find.text('None'), findsNWidgets(2));
        expect(find.text('Qwen3 8B'), findsNothing);
      },
    );

    testWidgets(
      'each served model names whose Buddy runs on it, by the name they set',
      (tester) async {
        final pool = machinePool('mac-1', 'Mac');
        (pool['observation'] as Map<String, dynamic>)['localModels'] = [
          {
            'grid': 'swarm-grid',
            'model': 'deepseek/deepseek-v3',
            'kind': 'api',
          },
          {
            'grid': 'swarm-grid',
            'model': 'qwen3:8b',
            'kind': 'local',
            'name': 'Qwen3 8B',
          },
        ];
        await open(
          tester,
          machines: [pool],
          memberName: 'Minh Nguyen',
          localModels: const {
            'grid': 'swarm-grid',
            'enabled': true,
            'ready': true,
          },
          agents: [
            // Not a Buddy: it says nothing of whose it is.
            {
              ...agent('agent-builder', displayName: 'Nova'),
              'gridModel': 'qwen3:8b',
            },
            {
              ...agent('agent-buddy', name: 'Buddy'),
              'buddyOf': {'personId': me},
              'gridModel': 'qwen3:8b',
            },
          ],
        );
        await details(tester);
        await tester.dragUntilVisible(
          key('swarm-machine-local-models-mac-1'),
          inSheet(find.byType(SingleChildScrollView)),
          const Offset(0, -200),
        );
        final used = inSheet(find.text("Used by Minh Nguyen's Buddy"));
        expect(used, findsOneWidget);
        // One line, under the model the Buddy runs on alone.
        expect(
          tester.getTopLeft(used).dy,
          greaterThan(tester.getTopLeft(inSheet(find.text('Qwen3 8B'))).dy),
        );
        expect(inSheet(find.text('deepseek-v3')), findsOneWidget);
        expect(inSheet(find.textContaining('Used by')), findsOneWidget);
      },
    );

    testWidgets('its owner by the name they set for the Swarm', (
      tester,
    ) async {
      await open(tester, memberName: 'Minh Nguyen');
      await details(tester);
      expect(inSheet(find.text('Owner')), findsOneWidget);
      expect(inSheet(find.text('Minh Nguyen')), findsOneWidget);
      expect(inSheet(find.text(me)), findsNothing);
      await tester.pumpWidget(const SizedBox());

      // A computer the Swarm knows only by its agents is named by its owner.
      await open(tester, machines: [], memberName: 'Minh Nguyen');
      await details(tester);
      expect(
        inSheet(find.text("Minh Nguyen's computer")),
        findsNWidgets(2),
      );
    });

    testWidgets(
      'out-of-range readings are no readings, and the project disk wins',
      (tester) async {
        final pool = machinePool('mac-1', 'Mac');
        final resources =
            (pool['observation'] as Map<String, dynamic>)['resources']
                as Map<String, dynamic>;
        resources
          ..['cpuPercent'] = 140
          ..remove('gpuPercent')
          ..['memoryUsedBytes'] = 32 * 1073741824
          ..['projectDiskTotalBytes'] = 100000000000
          ..['projectDiskFreeBytes'] = 500000000
          ..['chip'] = ''
          ..['os'] = 'x' * 121;
        await open(tester, machines: [pool]);
        await details(tester);
        for (final label in ['CPU', 'GPU', 'RAM', 'Chip', 'System']) {
          expect(inSheet(find.text(label)), findsNothing, reason: label);
        }
        expect(inSheet(find.text('500 MB of 100 GB')), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('Pause new work and Remove from Swarm stay as they were', (
      tester,
    ) async {
      await open(tester, agents: [agent('agent-builder', displayName: 'Nova')]);
      await details(tester);
      await tester.dragUntilVisible(
        key('swarm-machine-pause'),
        inSheet(find.byType(SingleChildScrollView)),
        const Offset(0, -200),
      );
      expect(find.text('Pause new work'), findsOneWidget);
      // Remove stays in the long-press menu, out of the read-only details.
      expect(inSheet(find.text('Remove from Swarm')), findsNothing);
    });
  });
}
