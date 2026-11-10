import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart';
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
  String? name,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 900);
  addTearDown(tester.view.reset);
  final server = fixture ?? ConversationServer();
  server.state['machines'] = [
    machine(
      'mine',
      name ??
          (width < 500
              ? 'A very long machine hostname that must truncate without increasing the row height'
              : 'My Mac'),
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
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: c,
          builder: (context, _) =>
              SuperTabMachines(controller: c, onAddAgent: (_) {}, ticks: false),
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
    'Manage rows have leading dots, owner badge and aligned disk bars, and no crew (v3)',
    (tester) async {
      await mount(tester);
      expect(find.text('OWNER'), findsOneWidget);
      for (final id in ['mine', 'build', 'sleep', 'old']) {
        expect(tester.getSize(key('machines-line-$id')).height, 56);
        expect(key('machines-crew-$id'), findsNothing);
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
      // A crew member's machine (crew-one, from an older server) reads no crew.
      expect(
        find.textContaining(RegExp('crew', caseSensitive: false)),
        findsNothing,
      );
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

  testWidgets(
    'long names at narrow desktop width keep 56pt rows without overflow',
    (tester) async {
      await mount(tester, width: 420);
      expect(tester.takeException(), isNull);
      expect(tester.getSize(key('machines-line-mine')).height, 56);
    },
  );
  testWidgets('disk total changes redraw the aligned value and bar', (
    tester,
  ) async {
    final server = ConversationServer();
    final c = await mount(tester, fixture: server);
    final resources =
        (server.state['machines'] as List)[1]['observation']['resources']
            as Map;
    resources['diskTotalBytes'] = 2000000000000;
    server.revision++;
    await tester.runAsync(c.refresh);
    await tester.pump();
    expect(
      find.descendant(
        of: key('machines-disk-build'),
        matching: find.text('of 2 TB'),
      ),
      findsOneWidget,
    );
    final bar = tester.widget<LinearProgressIndicator>(
      key('machines-disk-bar-build'),
    );
    expect(bar.value, .1);
  });
  testWidgets('duplicate hostnames include their owners', (tester) async {
    final server = ConversationServer();
    final c = await mount(tester, fixture: server);
    (server.state['people'] as List).addAll([
      {
        'id': 'peer',
        'email': 'peer@example.com',
        'username': 'dee',
        'role': 'collaborator',
      },
      {
        'id': 'peer-two',
        'email': 'peer-two@example.com',
        'username': 'diego',
        'role': 'collaborator',
      },
    ]);
    final machines = server.state['machines'] as List;
    machines[1] = machine('build', 'MacBooks-MacBook-Pro', 'peer', 0);
    machines[2] = machine('sleep', 'MacBooks-MacBook-Pro', 'peer-two', 25);
    server.revision++;
    await tester.runAsync(c.refresh);
    await tester.pump();
    expect(
      tester.widget<Text>(key('super-machine-name-build')).data,
      'MacBooks-MacBook-Pro · dee',
    );
    expect(find.text('MacBooks-MacBook-Pro · diego'), findsOneWidget);
  });
  testWidgets('loading uses the real 56pt machine row height', (tester) async {
    final c = ConversationServer().controller();
    addTearDown(c.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabMachines(
            controller: c,
            onAddAgent: (_) {},
            ticks: false,
          ),
        ),
      ),
    );
    expect(tester.getSize(key('machines-loading-row-0')).height, 56);
  });

  testWidgets(
    'keyboard reaches a machine with a visible focus ring and expands it',
    (tester) async {
      final c = await mount(tester);
      var reached = false;
      for (var i = 0; i < 16; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        final target = FocusManager.instance.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<InkWell>();
        if (target?.key == const ValueKey('super-machine-mine')) {
          reached = true;
          break;
        }
      }
      expect(reached, isTrue);
      final material = tester.widget<Material>(key('machines-surface-mine'));
      expect((material.shape as RoundedRectangleBorder).side.width, 2);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(c.isMachineExpanded('mine'), isTrue);
      await c.flush();
    },
  );

  // The test font draws every letter 1em wide: these names fit the row, and not half of it.
  for (final (width, name) in [
    (880.0, 'Dee\'s MacBook Pro (M4)'),
    // In the app a window 880 wide leaves Manage a row this narrow, beside the Swarm's sidebar.
    (600.0, 'Dee\'s MBP16'),
  ]) {
    testWidgets('at $width wide a long machine name stays whole', (
      tester,
    ) async {
      await mount(tester, width: width, name: name);
      expect(
        tester
            .renderObject<RenderParagraph>(
              find.descendant(
                of: key('super-machine-name-mine'),
                matching: find.byType(RichText),
              ),
            )
            .didExceedMaxLines,
        isFalse,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('at twice the text size the disk figures grow with the text '
      'and stay whole and aligned', (tester) async {
    await mount(tester, textScale: 2);
    for (final id in ['mine', 'build', 'sleep', 'old']) {
      final texts = find.descendant(
        of: key('machines-disk-$id'),
        matching: find.byType(RichText),
      );
      expect(texts, findsNWidgets(2));
      for (final text in texts.evaluate()) {
        expect(
          (text.renderObject! as RenderParagraph).didExceedMaxLines,
          isFalse,
          reason: id,
        );
      }
      expect(
        tester.getTopLeft(key('machines-disk-$id')).dx,
        tester.getTopLeft(key('machines-disk-mine')).dx,
      );
    }
    expect(tester.takeException(), isNull);
  });
}
