import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
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
      ...firstLoad(agents: agents),
      'members': [part(me, 1, person(me, role: role))],
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
      expect(find.text('CPU'), findsOneWidget);
      expect(find.text('25% in use'), findsOneWidget);
      expect(find.text('40% in use'), findsOneWidget);
      expect(find.text('12 GB free of 16 GB'), findsOneWidget);
      expect(find.text('128 GB free of 512 GB'), findsOneWidget);
      expect(find.textContaining('80% left'), findsWidgets);
      expect(find.textContaining('Resets'), findsWidgets);
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
    expect(find.text('12% in use'), findsOneWidget);
    expect(find.text('99% in use'), findsNothing);
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
      expect(find.text('25% in use'), findsNothing);
      expect(find.textContaining('80% left'), findsNothing);
      expect(find.textContaining('unavailable'), findsWidgets);
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
      expect(find.text('25% in use'), findsNothing);
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
      expect(find.text('25% in use'), findsNothing);
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
    expect(find.text('31% in use'), findsOneWidget);
    expect(find.text('98% in use'), findsNothing);
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
      expect(find.text('Allowance unavailable'), findsWidgets);
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
    expect(find.text('Current readings unavailable'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'hardware labels and values share a row, label left and value right',
    (tester) async {
      await open(tester);
      await tester.tap(key('swarm-machine-$tab-mac-1'));
      await tester.pumpAndSettle();
      final label = find.text('CPU');
      final value = find.text('25% in use');
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
      'blockedBy': blockedBy,
      'agents': agents,
      'hiddenAgentCount': hiddenAgentCount,
      'soleSourceProjects': projects,
      'hiddenSoleSourceProjectCount': hiddenSoleSourceProjectCount,
    };

    int removalReads() => fake.calls
        .where((c) => c.path.endsWith('/machines/mac-1/removal'))
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
        const reason = "A PM of a project you can't see runs here.";
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
}
