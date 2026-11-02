import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/manage_page.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';
import 'support/super_tab_members.dart';
import 'swarm_state_test.dart' show createApp;

/// Manage (docs/plans/2026-11-02-quiet-swarm-design.md, screens 10, 10b, 10c).
void main() {
  Future<({SuperTabController c, ConversationServer server})> show(
    WidgetTester tester, {
    SuperTabManageTab tab = SuperTabManageTab.machines,
    String account = 'owner',
    void Function(ConversationServer server)? setUp,
    bool devices = true,
  }) async {
    final server = ConversationServer();
    server.state['machines'] = [
      {
        'machineId': 'm1',
        'name': 'Mac Studio',
        'contributorId': 'owner',
        'maxAgents': 4,
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'resources': {'cpuPercent': 1},
        },
      },
      {
        'machineId': 'm2',
        'name': 'Old Mac',
        'contributorId': 'owner',
        'maxAgents': 4,
        'observation': {'receivedAt': 1000, 'resources': <String, dynamic>{}},
      },
    ];
    setUp?.call(server);
    final c = server.controller(account: account);
    await c.refresh();
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    var current = tab;
    await tester.binding.setSurfaceSize(const Size(800, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, update) => Column(
              children: [
                SuperTabManageTabs(
                  selected: current,
                  devices: devices,
                  onChoose: (next) => update(() => current = next),
                ),
                Expanded(
                  child: SuperTabManagePage(
                    controller: c,
                    app: app,
                    tab: current,
                    onAddAgent: (_) {},
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
    return (c: c, server: server);
  }

  testWidgets('its four tabs, Devices only where this build has them', (
    tester,
  ) async {
    await show(tester);
    for (final label in const ['Machines', 'Models', 'Devices', 'Swarm']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    await tester.tap(find.text('Swarm'));
    await tester.pump();
    expect(find.text('Owner'), findsOneWidget);
  });

  testWidgets('without devices there is no Devices tab', (tester) async {
    await show(tester, devices: false);
    expect(find.text('Devices'), findsNothing);
  });

  group('Machines', () {
    testWidgets('one line each: name, owner, status', (tester) async {
      await show(tester);
      final row = find.byKey(const ValueKey('super-machine-entry-m1'));
      expect(
        find.descendant(of: row, matching: find.text('Mac Studio')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('online')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-machine-entry-m2')),
          matching: find.text('offline'),
        ),
        findsOneWidget,
      );
      expect(tester.getSize(row).height, lessThanOrEqualTo(44));
    });

    testWidgets('has Add machine, and no Machines heading of its own', (
      tester,
    ) async {
      await show(tester);
      expect(find.text('Add machine'), findsOneWidget);
      expect(find.byTooltip('Add machine'), findsNothing);
    });
  });

  group('Models', () {
    testWidgets('has Your models', (tester) async {
      await show(tester, tab: SuperTabManageTab.models);
      expect(find.text('Your models…'), findsOneWidget);
    });
  });

  group('Swarm', () {
    testWidgets('says its name, owner and people, with Manage people', (
      tester,
    ) async {
      final s = await show(tester, tab: SuperTabManageTab.swarm);
      expect(find.text(s.c.snapshot!.name), findsOneWidget);
      expect(find.text('Name'), findsOneWidget);
      expect(find.text('Owner'), findsOneWidget);
      expect(find.text('People'), findsOneWidget);
      expect(find.text('${s.c.snapshot!.people.length}'), findsOneWidget);
      expect(find.text('Manage people'), findsOneWidget);
    });

    testWidgets('its owner can delete it, and cannot leave', (tester) async {
      await show(tester, tab: SuperTabManageTab.swarm);
      expect(find.text('Delete Swarm…'), findsOneWidget);
      expect(find.text('Leave Swarm…'), findsNothing);
    });

    testWidgets('a member can leave it, and cannot delete it', (tester) async {
      await show(
        tester,
        tab: SuperTabManageTab.swarm,
        account: 'member',
        setUp: (server) => (server.state['people'] as List).add({
          'id': 'member',
          'email': 'member@example.test',
          'role': 'collaborator',
          'generation': 'g',
        }),
      );
      expect(find.text('Leave Swarm…'), findsOneWidget);
      expect(find.text('Delete Swarm…'), findsNothing);
    });
  });

  group('while Manage shows', () {
    Future<SuperTabController> inView(
      WidgetTester tester,
      List<String> opened,
      ValueNotifier<bool> terminals,
    ) async {
      final server = membersSwarm();
      final c = server.controller();
      await c.refresh();
      await tester.binding.setSurfaceSize(const Size(1300, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: ValueListenableBuilder(
              valueListenable: terminals,
              builder: (context, shown, _) => SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (agent) => opened.add(agent.id),
                machineName: (_) => 'Mac Studio',
                terminalsVisible: shown,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-manage')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-manage-tab-machines')), findsOne);
      return c;
    }

    Future<void> close(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    testWidgets('a terminal that opens takes the place of the Manage page', (
      tester,
    ) async {
      final terminals = ValueNotifier(false);
      final c = await inView(tester, [], terminals);
      terminals.value = true;
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-manage-tab-machines')),
        findsNothing,
      );
      await close(tester, c);
    });

    testWidgets('an agent clicked in the right column leaves it', (
      tester,
    ) async {
      final opened = <String>[];
      final terminals = ValueNotifier(false);
      final c = await inView(tester, opened, terminals);
      await openSuperTabMembers(tester);
      final agent = c.snapshot!.agents.first;
      await tester.tap(find.byKey(ValueKey('super-member-${agent.id}')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Open terminal'));
      await tester.pumpAndSettle();
      expect(opened, [agent.id]);
      expect(
        find.byKey(const ValueKey('super-manage-tab-machines')),
        findsNothing,
      );
      await close(tester, c);
    });
  });
}
