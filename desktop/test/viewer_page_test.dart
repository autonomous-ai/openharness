import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/viewer/viewer_location.dart';
import 'package:harness/viewer/viewer_page.dart';
import 'package:harness/widgets/link_machine_screen.dart';
import 'package:harness/widgets/web_pane_panel.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _App extends AppNotifier {
  _App({MemoryStore? storage})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
        configStore: null,
        paneLayoutStore: storage == null
            ? null
            : PaneLayoutStore(storage: storage),
        workspaceEnabled: () => false,
      );
  bool inventoryLoaded = true;
  String? inventoryError;
  @override
  bool get machineInventoryLoaded => inventoryLoaded;
  @override
  String? get machineListError => inventoryError;
  int retries = 0, inventoryRetries = 0, offlineRetries = 0;
  @override
  Future<void> retryMachines() async {
    inventoryRetries++;
  }

  @override
  Future<void> retryOfflineMachine(String machineId) async {
    offlineRetries++;
  }

  @override
  Future<void> reloadMachineData(String machineId) async {
    retries++;
  }
}

class _Desk extends ApiClient {
  _Desk()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  int reads = 0;
  @override
  Future<Map<String, dynamic>?> desk() async {
    reads++;
    throw StateError('A viewer must not join the desk');
  }
}

void main() {
  test(
    'companion never restores, claims, joins or overwrites the saved desk',
    () async {
      final storage = MemoryStore();
      await PaneLayoutStore(storage: storage).saveSwarms([
        Swarm(id: 'saved', name: 'Work')
          ..panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'other')),
      ], 'saved');
      final before = Map.of(storage.values);
      final desk = _Desk();
      final app = _App(storage: storage)..api = desk;
      addTearDown(app.dispose);
      await app.restorePaneLayoutForTest(claimOnAttach: true);
      await app.deskStartForTest();
      app.newSwarm(name: 'Transient');
      await app.flushPaneLayout();
      expect(app.allPanes, isEmpty);
      expect(app.deskSyncForTest.enabled, isFalse);
      expect(desk.reads, 0);
      expect(storage.values, before);
    },
  );

  testWidgets(
    'viewer follows its named harness, requires linking and never opens a terminal',
    (tester) async {
      final app = _App();
      const machine = Machine(
        machineId: 'm',
        name: 'Render server',
        authMode: MachineAuthMode.remote,
      );
      final state = MachineState(machine)
        ..nodeOnline = true
        ..needsLink = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      app.machineStates['m'] = state;
      app.machines = [machine];
      Future<void> mount() => tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: ViewerPage(
            app: app,
            location: const ViewerLocation('m', 'blender'),
          ),
        ),
      );
      await mount();
      expect(find.byType(LinkMachineScreen), findsOneWidget);
      state.needsLink = false;
      state.agents = [
        const Agent(id: 'blender', name: 'Chair', viewerName: '3D Viewer'),
      ];
      app.notifyListeners();
      await tester.pump();
      expect(find.textContaining('is starting'), findsOneWidget);
      state.agents = [
        const Agent(
          id: 'blender',
          name: 'Chair',
          viewerName: '3D Viewer',
          viewerUrl: 'http://127.0.0.1:19679/model',
        ),
      ];
      app.notifyListeners();
      await tester.pump();
      expect(find.byType(WebPanePanel), findsOneWidget);
      final pane = tester.widget<WebPanePanel>(find.byType(WebPanePanel)).pane;
      expect(pane.ownerAgentId, 'blender');
      expect(pane.agentId, isNull);
      expect(app.allPanes, isEmpty);
      state.agents = [];
      app.notifyListeners();
      await tester.pump();
      expect(find.textContaining('no longer available'), findsOneWidget);
      await tester.tap(find.textContaining('Retry'));
      await tester.pump();
      expect(app.retries, 1);
      state.nodeOnline = false;
      app.notifyListeners();
      await tester.pump();
      expect(find.text('Render server is offline.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'inventory, ownership, connection and viewer failures each recover without a terminal',
    (tester) async {
      final app = _App()..inventoryLoaded = false;
      addTearDown(app.dispose);
      Future<void> update() async {
        app.notifyListeners();
        await tester.pump();
      }

      Future<void> retry() async {
        await tester.tap(find.textContaining('Retry'));
        await tester.pump();
      }

      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: ViewerPage(app: app, location: const ViewerLocation('m', 'a')),
        ),
      );
      expect(find.text('Finding this machine…'), findsOneWidget);
      app.inventoryError = 'Inventory is unavailable';
      await update();
      expect(find.text('Inventory is unavailable'), findsOneWidget);
      await retry();
      expect(app.inventoryRetries, 1);
      app.inventoryError = null;
      app.inventoryLoaded = true;
      await update();
      expect(
        find.textContaining('not available to this account'),
        findsOneWidget,
      );
      await retry();
      expect(app.inventoryRetries, 2);
      app.machineStates['m'] = MachineState(
        const Machine(
          machineId: 'm',
          name: 'Shared',
          authMode: MachineAuthMode.remote,
          isShared: true,
        ),
      );
      await update();
      expect(find.textContaining('Sign in as the owner'), findsOneWidget);
      final machine = MachineState(
        const Machine(
          machineId: 'm',
          name: 'Renderer',
          authMode: MachineAuthMode.remote,
        ),
      )..nodeOnline = false;
      app.machineStates['m'] = machine;
      await update();
      expect(find.text('Renderer is offline.'), findsOneWidget);
      await retry();
      expect(app.offlineRetries, 1);
      machine.nodeOnline = true;
      machine.connectionStatus = ConnectionStatus.disconnected;
      await update();
      expect(find.textContaining('machine is disconnected'), findsOneWidget);
      await retry();
      expect(app.retries, 1);
      machine.connectionStatus = ConnectionStatus.connecting;
      machine.agentLoadStatus = AgentLoadStatus.loading;
      await update();
      expect(find.text('Connecting to Renderer…'), findsOneWidget);
      machine.connectionStatus = ConnectionStatus.connected;
      machine.agentLoadStatus = AgentLoadStatus.error;
      await update();
      expect(find.textContaining('machine is disconnected'), findsOneWidget);
      machine.agentLoadStatus = AgentLoadStatus.loaded;
      machine.agents = [const Agent(id: 'a', name: 'Fixture')];
      await update();
      expect(find.text('This harness has no viewer.'), findsOneWidget);
      await retry();
      expect(app.retries, 2);
      machine.agents = [
        const Agent(
          id: 'a',
          name: 'Fixture',
          viewerError: 'Renderer could not start',
        ),
      ];
      await update();
      expect(find.text('Renderer could not start'), findsOneWidget);
      machine.agents = [
        const Agent(
          id: 'a',
          name: 'Fixture',
          viewerUrl: 'http://127.0.0.1:19679/first',
        ),
      ];
      await update();
      final first = tester.widget<WebPanePanel>(find.byType(WebPanePanel)).pane;
      machine.agents = [
        const Agent(
          id: 'a',
          name: 'Fixture',
          viewerUrl: 'http://127.0.0.1:19679/restarted',
        ),
      ];
      await update();
      final next = tester.widget<WebPanePanel>(find.byType(WebPanePanel)).pane;
      expect(next, same(first));
      expect(next.url, endsWith('/restarted'));
      expect(app.allPanes, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      expect(tester.takeException(), isNull);
    },
  );
}
