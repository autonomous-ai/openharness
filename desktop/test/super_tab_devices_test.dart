import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/devices/devices_harness_controller.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';
import 'support/super_tab_devices_fixture.dart';

void main() {
  test(
    'Devices and expanded machines restore only for their account and Swarm',
    () async {
      final server = ConversationServer();
      server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Atlas',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      (server.state['conversations'] as List)[0]['agentIds'] = ['pm'];
      final c = server.controller();
      await c.refresh();
      c.setDraft('lead', 'Keep discussing this project.');
      c.selectGroupTerminals('lead');
      c.selectDevices();
      c.rememberDevicesLayout(
        PaneArrangement(const [
          Rect.fromLTRB(0, 0, .6, 1),
          Rect.fromLTRB(.6, 0, 1, 1),
        ]),
      );
      c.toggleMachineExpanded('m');
      await c.flush();
      c.dispose();
      final restored = server.controller(initial: server.saved);
      await restored.refresh();
      expect(restored.devicesSelected, isTrue);
      expect(restored.devicesLayout!.tiles.first.width, .6);
      expect(restored.isMachineExpanded('m'), isTrue);
      expect(restored.terminalAgents('lead'), isEmpty);
      expect(restored.draft('lead'), 'Keep discussing this project.');
      restored.select('lead');
      expect(restored.devicesSelected, isFalse);
      expect(restored.selectedId, 'lead');
      expect(restored.terminalAgents('lead'), isNotEmpty);
      final other = server.controller(initial: server.saved, account: 'other');
      expect(other.devicesSelected, isFalse);
      expect(other.devicesLayout, isNull);
      expect(other.isMachineExpanded('m'), isFalse);
      other.dispose();
      restored.dispose();
    },
  );

  Future<(SuperTabLaunchFixture, SuperTabController)> mount(
    WidgetTester tester, {
    bool hasDevice = false,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = superTabDevicesFixture();
    (f.connection as SuperTabDevicesConnection).hasDevice = hasDevice;
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: f.app,
            builder: (_, _) => SuperTabWorkspace(
              app: f.app,
              onAddAgent: (_) {},
              canvas: PaneGrid(
                notifier: f.app,
                swarmMode: true,
                devicesViewer: (_) => DevicesTab(notifier: f.app),
                devicesConversation: (_) => const Text('Devices chat setup'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (f, c);
  }

  testWidgets(
    'Devices opens in the center, keeps the same tab and preserves the project draft',
    (tester) async {
      final (f, c) = await mount(tester);
      final tab = f.app.activeSwarm;
      final before = f.app.swarms.map((s) => s.id).toList();
      final field = find.descendant(
        of: find.byKey(const ValueKey('super-composer')),
        matching: find.byType(TextField),
      );
      // Use the view's composer rather than any search field in the Devices page.
      final composer = field.evaluate().isEmpty
          ? find.byType(TextField).last
          : field;
      await tester.enterText(composer, 'An unfinished project message');
      await tester.tap(find.byKey(const ValueKey('super-your-devices')));
      await tester.pumpAndSettle();
      expect(f.app.activeSwarm, same(tab));
      expect(f.app.swarms.map((s) => s.id), before);
      expect(c.devicesSelected, isTrue);
      expect(find.byType(DevicesScreen), findsOneWidget);
      expect(find.text('Add your first device'), findsOneWidget);
      expect(find.text('Devices chat setup'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-chat')), findsNothing);
      expect(tab.panes, hasLength(2));
      final viewer = tab.panes.first;
      final chat = tab.panes.last;
      expect(viewer.isDevices, isTrue);
      expect(chat.isViewer, isFalse);
      final left = tester.getRect(
        find.byKey(ValueKey('pane-frame:${viewer.id}')),
      );
      final right = tester.getRect(
        find.byKey(ValueKey('pane-frame:${chat.id}')),
      );
      expect(left.right, lessThan(right.left));
      expect(left.width / (left.width + right.width), closeTo(.7, .01));
      await tester.tap(find.byKey(const ValueKey('super-your-devices')));
      await tester.pumpAndSettle();
      expect(tab.panes.first, same(viewer));
      expect(tab.panes.last, same(chat));
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      expect(c.devicesSelected, isFalse);
      expect(f.app.activeSwarm, same(tab));
      expect(find.byType(DevicesScreen), findsNothing);
      expect(find.text('An unfinished project message'), findsOneWidget);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_create'),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'late Devices conversation attachment cannot replace a project after navigating away',
    (tester) async {
      final (f, c) = await mount(tester);
      final tab = f.app.activeSwarm;
      final devices = DevicesHarnessController(f.app);
      addTearDown(devices.dispose);
      final loading = Completer<void>();
      final owner = f.app.stateOf('m')!;
      owner.agentsLoadInFlight = loading.future;
      owner.agents = [
        const Agent(
          id: 'devices-chat',
          name: 'Devices',
          engine: 'codex',
          dsh: devicesHarnessId,
          terminalAvailable: false,
        ),
      ];
      c.selectDevices();
      await tester.pumpAndSettle();
      final opening = devices.open(swarmId: tab.id);
      c.select('lead');
      await tester.pumpAndSettle();
      loading.complete();
      await opening;
      await tester.pumpAndSettle();
      expect(c.devicesSelected, isFalse);
      expect(
        tab.panes.where((pane) => pane.agentId == 'devices-chat'),
        isEmpty,
      );
      expect(tab.panes.where((pane) => pane.isDevices), isEmpty);
      c.selectDevices();
      await tester.pumpAndSettle();
      await devices.open(swarmId: tab.id);
      // The native session's loading animation intentionally keeps pumping.
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        tab.panes.where((pane) => pane.agentId == 'devices-chat'),
        hasLength(1),
      );
      expect(f.app.activeSwarm, same(tab));
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_create'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('embedded device controls update the selected device in place', (
    tester,
  ) async {
    final (f, c) = await mount(tester, hasDevice: true);
    final tab = f.app.activeSwarm;
    c.selectDevices();
    await tester.pumpAndSettle();
    final sound = find.byWidgetPredicate(
      (widget) =>
          widget is Switch && widget.key.toString().contains('devices-sound-'),
    );
    await tester.ensureVisible(sound);
    expect(tester.widget<Switch>(sound).value, isFalse);
    await tester.tap(sound);
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(sound).value, isTrue);
    expect(f.app.activeSwarm, same(tab));
    expect(
      f.connection.calls
          .where((call) => call.$1 == 'harness_device_settings')
          .single
          .$2['patch'],
      {'muted': false},
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets('revoking a Swarm while Devices is open removes its workspace', (
    tester,
  ) async {
    final (f, c) = await mount(tester);
    c.selectDevices();
    await tester.pumpAndSettle();
    c.revokeAccess('Access to this Swarm was removed.');
    await tester.pumpAndSettle();
    expect(c.devicesSelected, isFalse);
    expect(find.byType(DevicesScreen), findsNothing);
    expect(find.text('Access to this Swarm was removed.'), findsOneWidget);
    expect(f.app.activeSwarm.panes, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'messages arriving while Devices is visible stay unread until chat is shown',
    (tester) async {
      final (f, c) = await mount(tester);
      c.selectDevices();
      await tester.pumpAndSettle();
      f.connection.server.append('Please review the next change.');
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.unread(c.snapshot!.conversation('lead')!), isTrue);
      c.select('lead');
      await tester.pumpAndSettle();
      expect(find.text('Please review the next change.'), findsOneWidget);
      expect(c.unread(c.snapshot!.conversation('lead')!), isFalse);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );
}
