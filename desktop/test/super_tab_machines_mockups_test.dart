import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';

import 'support/super_tab_fixture.dart';

Finder key(String name) => find.byKey(ValueKey(name));

Map<String, dynamic> machine(String id, String name, String owner, int age) => {
  'machineId': id,
  'name': name,
  'contributorId': owner,
  'observation': {
    'receivedAt': DateTime.now().millisecondsSinceEpoch - age * 1000,
    'resources': {
      'cpuPercent': 5,
      'diskTotalBytes': 1000000000000,
      'diskFreeBytes': 200000000000,
    },
  },
};

Future<SuperTabController> mount(
  WidgetTester tester, {
  ConversationServer? fixture,
  double width = 1200,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.reset);
  final server = fixture ?? ConversationServer();
  server.state['machines'] = [
    machine(
      'mine',
      width < 500
          ? 'A very long machine hostname that must truncate without increasing the row height'
          : 'My Mac',
      'owner',
      0,
    ),
    machine('build', 'Build Box', 'peer', 0),
    machine('sleep', 'Sleeping Mac', 'peer', 25),
    machine('old', 'Old Linux', 'peer', 7200),
  ];
  server.state['agents'] = [
    {
      'id': 'crew-one',
      'name': 'Builder',
      'machineId': 'mine',
      'harnessId': 'native-one',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
      'crew': {'role': 'Engineer', 'lane': 'desktop'},
    },
  ];
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: SuperTabMachines(
          controller: c,
          onAddAgent: (_) {},
          manage: true,
          ticks: false,
        ),
      ),
    ),
  );
  await tester.pump();
  addTearDown(c.dispose);
  return c;
}

void main() {
  testWidgets('Manage has title, counted filters and status groups', (
    tester,
  ) async {
    await mount(tester);
    expect(find.text('Machines'), findsOneWidget);
    expect(key('machines-search'), findsOneWidget);
    expect(find.text('All 4'), findsOneWidget);
    expect(find.text('Online 2'), findsOneWidget);
    expect(find.text('Asleep 1'), findsOneWidget);
    expect(find.text('Offline 1'), findsOneWidget);
    expect(find.text('YOUR MACHINE'), findsOneWidget);
    expect(find.text('ONLINE · 1'), findsOneWidget);
    expect(find.text('ASLEEP · 1'), findsOneWidget);
    expect(find.text('OFFLINE · 1'), findsOneWidget);
    expect(find.text('Sorted by status, then name'), findsOneWidget);
    expect(
      tester.getTopLeft(key('machines-line-mine')).dy,
      lessThanOrEqualTo(160),
    );
  });

  testWidgets(
    'Manage rows have leading dots, owner badge and aligned disk bars',
    (tester) async {
      await mount(tester);
      expect(find.text('OWNER'), findsOneWidget);
      for (final id in ['mine', 'build', 'sleep', 'old']) {
        expect(tester.getSize(key('machines-line-$id')).height, 56);
        expect(key('machines-crew-$id'), findsOneWidget);
        expect(key('machines-disk-$id'), findsOneWidget);
        expect(
          tester.getTopLeft(key('machines-dot-$id')).dx,
          lessThan(tester.getTopLeft(key('super-machine-name-$id')).dx),
        );
      }
      expect(
        tester.getTopLeft(key('machines-disk-mine')).dx,
        tester.getTopLeft(key('machines-disk-build')).dx,
      );
      expect(find.text('200 GB free'), findsNWidgets(4));
      expect(find.textContaining('last seen'), findsWidgets);
    },
  );

  testWidgets(
    'search combines with status filters and recovers from no matches',
    (tester) async {
      await mount(tester);
      await tester.tap(key('machines-filter-offline'));
      await tester.pump();
      expect(key('super-machine-row-old'), findsOneWidget);
      expect(key('super-machine-row-mine'), findsNothing);
      await tester.enterText(key('machines-search'), 'BUILD');
      await tester.pump();
      expect(
        find.text('No machines match your search and filter.'),
        findsOneWidget,
      );
      await tester.tap(key('machines-filter-all'));
      await tester.pump();
      expect(key('super-machine-row-build'), findsOneWidget);
      expect(key('super-machine-row-old'), findsNothing);
      await tester.enterText(key('machines-search'), '');
      await tester.pump();
      expect(key('super-machine-row-mine'), findsOneWidget);
    },
  );
  testWidgets('pinned machine status updates summary and filter counts', (
    tester,
  ) async {
    final server = ConversationServer();
    final c = await mount(tester, fixture: server);
    (server.state['machines'] as List)[0] = machine(
      'mine',
      'My Mac',
      'owner',
      25,
    );
    server.revision++;
    await tester.runAsync(c.refresh);
    await tester.pump();
    expect(find.text('Online 1'), findsOneWidget);
    expect(find.text('Asleep 2'), findsOneWidget);
    expect(find.text('1 online · 2 asleep · 1 offline'), findsOneWidget);
  });

  testWidgets('crew chip expands the existing machine details', (tester) async {
    final c = await mount(tester);
    expect(find.text('1 crew'), findsOneWidget);
    await tester.tap(key('machines-crew-mine'));
    await tester.pump();
    expect(c.isMachineExpanded('mine'), isTrue);
    expect(key('super-machine-crew-member-mine-0'), findsOneWidget);
    await c.flush();
  });

  testWidgets(
    'long names at narrow desktop width keep 56pt rows without overflow',
    (tester) async {
      await mount(tester, width: 420);
      expect(tester.takeException(), isNull);
      expect(tester.getSize(key('machines-line-mine')).height, 56);
    },
  );
}
