import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/harness_monitor_controller.dart';
import 'package:harness/widgets/web_pane_panel.dart';

import 'support/harness_monitor.dart';
import 'support/workspace_tools.dart';
import 'swarm_screen_test.dart' show mount, terminal;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late MonitorConnection connection;
  late MonitorTestApp app;
  setUp(() {
    connection = MonitorConnection();
    app = MonitorTestApp(connection);
  });
  tearDown(() => app.dispose());

  test(
    'one monitor tab, 70/30 viewer and assistant, with no unsolicited prompt',
    () async {
      app.installed = false;
      app.stateOf('m')!.agents = [
        const Agent(id: 'source', name: 'Work', engine: 'codex'),
      ];
      app.adoptSessionForTest(terminal('source', []));
      final original = app.activeSwarmId;
      expect(await app.harnessMonitor.open(), isNull);
      final monitorTab = app.activeSwarmId, count = app.swarms.length;
      final viewer = app.panes.singleWhere((p) => p.isWeb);
      expect(monitorTab, isNot(original));
      expect(app.zoomedPaneId, isNull);
      expect(app.focusedPane, viewer);
      expect(app.activeSwarm.paneSizes['2:manual']!.tiles.first.width, .7);
      expect(app.panes.map((p) => p.isWeb), [true, false]);
      expect(app.activeSwarm.name, harnessMonitorName);
      expect(app.installs, 1);
      expect(connection.creations.single['engine'], 'opencode');
      expect(connection.creations.single['dsh'], harnessMonitorId);
      expect(connection.creations.single['prompt'], isNull);
      expect(app.sent, isEmpty);
      app.selectSwarm(original);
      expect(await app.harnessMonitor.open(), isNull);
      expect(app.activeSwarmId, monitorTab);
      expect(app.swarms, hasLength(count));
      expect(connection.creations, hasLength(1));
    },
  );

  test(
    'concurrent opens and a lost reply retain one durable creation',
    () async {
      connection.holdCreation = Completer<void>();
      connection.loseFirstReply = true;
      final one = app.harnessMonitor.open(), two = app.harnessMonitor.open();
      expect(identical(one, two), isTrue);
      connection.holdCreation!.complete();
      expect(await one, isNotNull);
      expect(await app.harnessMonitor.open(), isNull);
      expect(connection.creations, hasLength(1));
      expect(app.allPanes.where((p) => p.isWeb), hasLength(1));
    },
  );

  test(
    'installation failures leave the current tab and do not create an agent',
    () async {
      app.installed = false;
      app.installError = 'Install failed.';
      final original = app.activeSwarmId;
      expect(await app.harnessMonitor.open(), 'Install failed.');
      expect(app.activeSwarmId, original);
      expect(connection.creations, isEmpty);
    },
  );

  test(
    'assistant navigation is scoped to the active monitor and keeps its model',
    () async {
      await app.harnessMonitor.open();
      final viewer = app.panes.singleWhere((p) => p.isWeb);
      final terminal = app.panes.singleWhere((p) => !p.isWeb);
      expect(
        await app.handleHarnessMonitorAction(terminal, {'action': 'assistant'}),
        isNotNull,
      );
      expect(
        await app.handleHarnessMonitorAction(viewer, {
          'action': 'assistant',
          'chooseModel': true,
        }),
        isNull,
      );
      expect(app.zoomedPaneId, isNull);
      expect(app.focusedPane, terminal);
      expect(app.sent, isEmpty);
      app.showHarnessMonitor('m', 'manager');
      expect(app.zoomedPaneId, isNull);
      expect(
        await app.handleHarnessMonitorAction(viewer, {
          'action': 'open',
          'machineId': 'other',
          'agentId': 'x',
        }),
        contains('Connect'),
      );
      app.newSwarm(name: 'Other');
      expect(
        await app.handleHarnessMonitorAction(viewer, {'action': 'assistant'}),
        contains('no longer active'),
      );
      expect(
        await app.handleHarnessMonitorAction(viewer, {'action': 'stop'}),
        isNotNull,
      );
    },
  );

  test('a dismissed viewer is restored on the next dock open', () async {
    await app.harnessMonitor.open();
    await app.closePane(app.panes.singleWhere((p) => p.isWeb).id);
    expect(app.viewerPaneShown('m', 'manager'), isFalse);
    expect(await app.harnessMonitor.open(), isNull);
    expect(app.viewerPaneShown('m', 'manager'), isTrue);
    expect(app.zoomedPaneId, isNull);
    expect(connection.creations, hasLength(1));
  });

  test('the monitor closes offline and reopens the same assistant', () async {
    await app.harnessMonitor.open();
    final tab = app.activeSwarm;
    final owner = app.stateOf('m')!;
    final agent = owner.agents.single;
    owner
      ..connectionStatus = ConnectionStatus.disconnected
      ..nodeOnline = false;

    await app.requestCloseSwarm(tab.id);

    expect(app.swarms, isNot(contains(tab)));
    expect(app.allPanes, isEmpty);
    expect(connection.closes, isEmpty);
    expect(owner.agents.single, same(agent));
    expect(owner.agents.single.isStopped, isFalse);

    owner
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true;
    expect(await app.harnessMonitor.open(), isNull);
    expect(app.activeSwarm.name, harnessMonitorName);
    expect(app.panes.singleWhere((p) => !p.isWeb).agentId, agent.id);
    expect(connection.creations, hasLength(1));
    expect(app.resumes, 0);
  });

  test(
    'an existing stopped monitor reopens in the same tab after focus changes',
    () async {
      await app.harnessMonitor.open();
      final monitorTab = app.activeSwarmId;
      app.stateOf('m')!.agents = [
        const Agent(
          id: 'manager',
          name: harnessMonitorName,
          engine: 'opencode',
          dsh: harnessMonitorId,
          status: 'stopped',
        ),
      ];
      app.newSwarm(name: 'Other work');
      app.selectedMachineId = 'other';
      final count = app.swarms.length;
      expect(await app.harnessMonitor.open(), isNull);
      expect(app.resumes, 1);
      expect(app.activeSwarmId, monitorTab);
      expect(app.swarms, hasLength(count));
      expect(connection.creations, hasLength(1));
      app.resumeThrows = true;
      expect(
        await app.harnessMonitor.open(),
        'Could not open Harness Monitor. Try again.',
      );
    },
  );

  test(
    'an existing offline monitor is selected without creating another one',
    () async {
      await app.harnessMonitor.open();
      final monitorTab = app.activeSwarmId;
      app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
      app.newSwarm(name: 'Other work');
      app.selectedMachineId = 'other';
      expect(await app.harnessMonitor.open(), isNull);
      expect(app.activeSwarmId, monitorTab);
      expect(app.resumes, 0);
      expect(connection.creations, hasLength(1));
    },
  );

  test(
    'Open refreshes the owning machine and reveals an existing tab',
    () async {
      app.stateOf('other')!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = true;
      app.adoptSessionForTest(terminal('target', []));
      // The view belongs to the remote machine even if its agent ID exists locally too.
      final target = app.panes.single;
      target.machineId = 'other';
      final original = app.activeSwarmId;
      connection.inventory = [
        {
          'id': 'target',
          'name': 'Remote work',
          'engine': 'codex',
          'terminal': {'available': true},
        },
      ];
      await app.harnessMonitor.open();
      final count = app.swarms.length;
      final source = app.panes.singleWhere((p) => p.isWeb);
      expect(
        await app.handleHarnessMonitorAction(source, {
          'action': 'open',
          'machineId': 'other',
          'agentId': 'target',
        }),
        isNull,
      );
      expect(connection.inventoryReads, 1);
      expect(app.activeSwarmId, original);
      expect(app.focusedPane, target);
      expect(app.swarms, hasLength(count));
      expect(app.resumes, 0);
    },
  );

  test('Open a stopped session with no pane selects a new tab', () async {
    app.stateOf('other')!
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true;
    await app.harnessMonitor.open();
    final monitorTab = app.activeSwarmId;
    final source = app.panes.singleWhere((p) => p.isWeb);
    connection.inventory = [
      {
        'id': 'closed',
        'name': 'Closed work',
        'engine': 'codex',
        'status': 'stopped',
        'resumeMode': 'conversation',
        'terminal': {'available': false},
      },
    ];
    app.onReopen = (machineId, agentId) {
      expect(machineId, 'other');
      expect(agentId, 'closed');
      connection.inventory = [
        {
          'id': 'closed',
          'name': 'Closed work',
          'engine': 'codex',
          'terminal': {'available': true},
        },
      ];
      app.stateOf(machineId)!.agents = [
        ...app.stateOf(machineId)!.agents.where((a) => a.id != agentId),
        Agent.fromJson(connection.inventory!.single),
      ];
    };
    expect(
      await app.handleHarnessMonitorAction(source, {
        'action': 'open',
        'machineId': 'other',
        'agentId': 'closed',
      }),
      isNull,
    );
    expect(app.resumes, 1);
    expect(app.activeSwarmId, isNot(monitorTab));
    expect(app.focusedPane?.agentId, 'closed');
    expect(app.focusedPane?.machineId, 'other');
    final reopenedTab = app.activeSwarmId;
    final count = app.swarms.length;
    app.selectSwarm(monitorTab);
    expect(
      await app.handleHarnessMonitorAction(source, {
        'action': 'open',
        'machineId': 'other',
        'agentId': 'closed',
      }),
      isNull,
    );
    expect(app.activeSwarmId, reopenedTab);
    expect(app.swarms, hasLength(count));
    expect(app.resumes, 1);
  });

  test(
    'a failed Open leaves the monitor selected and creates no empty tab',
    () async {
      app.stateOf('other')!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = true;
      await app.harnessMonitor.open();
      final source = app.panes.singleWhere((p) => p.isWeb);
      final tab = app.activeSwarmId, count = app.swarms.length;
      connection.inventory = [
        {
          'id': 'closed',
          'engine': 'codex',
          'status': 'stopped',
          'resumeMode': 'conversation',
          'terminal': {'available': false},
        },
      ];
      app.resumeError = 'Reconnect and try again.';
      expect(
        await app.handleHarnessMonitorAction(source, {
          'action': 'open',
          'machineId': 'other',
          'agentId': 'closed',
        }),
        app.resumeError,
      );
      expect(app.activeSwarmId, tab);
      expect(app.swarms, hasLength(count));
      expect(app.allPanes.any((p) => p.agentId == 'closed'), isFalse);
    },
  );

  for (final nativeTabs in [false, true]) {
    for (final resources in nativeTabs ? [false, true] : [false]) {
      testWidgets(
        'footer opens and reuses monitor (native=$nativeTabs resources=$resources)',
        (tester) async {
          const channel = MethodChannel('harness/swarm_tabs');
          tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            (_) async => null,
          );
          addTearDown(
            () => tester.binding.defaultBinaryMessenger
                .setMockMethodCallHandler(channel, null),
          );
          await mount(tester, app, nativeTabs: nativeTabs);
          Future<void> open() async {
            if (nativeTabs) {
              tester.binding.defaultBinaryMessenger.handlePlatformMessage(
                channel.name,
                const StandardMethodCodec().encodeMethodCall(
                  MethodCall(resources ? 'resourceMonitor' : 'harnessControls'),
                ),
                (_) {},
              );
            } else {
              await openWorkspaceManagement(tester, 'harnesses');
            }
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 350));
          }

          await open();
          expect(app.activeSwarm.name, harnessMonitorName);
          expect(find.byType(WebPanePanel), findsOneWidget);
          expect(app.zoomedPaneId, isNull);
          final count = app.swarms.length;
          app.selectedMachineId = 'other';
          await open();
          expect(app.swarms, hasLength(count));
          expect(connection.creations, hasLength(1));
          final viewer = app.panes.singleWhere((p) => p.isWeb);
          expect(find.text('Hide assistant'), findsNothing);
          tester
              .widget<WebPanePanel>(find.byType(WebPanePanel))
              .onToggleZoom!();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 350));
          expect(app.zoomedPaneId, viewer.id);
          tester
              .widget<WebPanePanel>(find.byType(WebPanePanel))
              .onToggleZoom!();
          await tester.pump(const Duration(milliseconds: 350));
          expect(app.zoomedPaneId, isNull);
          expect(app.activeSwarm.paneSizes['2:manual']!.tiles.first.width, .7);
          expect(tester.takeException(), isNull);
          final monitorTab = app.activeSwarm;
          if (nativeTabs) {
            tester.binding.defaultBinaryMessenger.handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                MethodCall('close', {'id': monitorTab.id}),
              ),
              (_) {},
            );
          } else {
            final mouse = await tester.createGesture(
              kind: PointerDeviceKind.mouse,
            );
            await mouse.addPointer(location: const Offset(1200, 700));
            await mouse.moveTo(
              tester.getCenter(find.byKey(ValueKey(monitorTab.id))),
            );
            await tester.pump();
            await tester.tap(
              find.byKey(ValueKey('tab-close:${monitorTab.id}')).hitTestable(),
            );
            await mouse.removePointer();
          }
          await tester.pumpAndSettle();
          expect(app.swarms, isNot(contains(monitorTab)));
          expect(connection.closes, isEmpty);
          expect(find.text('OK'), findsNothing);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }
}
