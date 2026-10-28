import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
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
      'deviceType': 'MacBook Pro',
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
      'machines': [for (final m in rows) part(m['machineId'] as String, 1, m)],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
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
        home: const SwarmPage(),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('swarm-menu')));
    await tester.pumpAndSettle();
  }

  Finder key(String s) => find.byKey(ValueKey(s));

  testWidgets(
    'contributed Machines under Projects collapse without hiding projects',
    (tester) async {
      await open(tester);
      expect(key('swarm-machine-$tab-mac-1'), findsOneWidget);
      expect(
        tester.getTopLeft(key('swarm-machines-$tab')).dy,
        greaterThan(
          tester.getTopLeft(key('swarm-drawer-project-$tab-$project')).dy,
        ),
      );
      await tester.tap(key('swarm-machines-$tab'));
      await tester.pumpAndSettle();
      expect(key('swarm-machine-$tab-mac-1'), findsNothing);
      expect(key('swarm-drawer-project-$tab-$project'), findsOneWidget);
      await tester.tap(key('swarm-machines-$tab'));
      await tester.pumpAndSettle();
      expect(find.text('Tony’s Mac'), findsOneWidget);
    },
  );

  testWidgets(
    'tap shows capacity, allowance reset and running agents, without management',
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
      for (final text in ['Remove', 'Configure', 'Pause']) {
        expect(find.text(text), findsNothing);
      }
    },
  );

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
}
