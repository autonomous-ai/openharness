import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/web/shell/web_chrome.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import 'support/web_swarm_backend.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// The Swarm state reads (first loads and change reads) the fixture's machine
/// has answered.
int _stateReads(SuperTabLaunchFixture f) => _connectionReads(f.connection);

int _connectionReads(SuperTabFixtureConnection connection) => connection.calls
    .where(
      (c) =>
          c.$1 == 'super_tabs' &&
          c.$2['method'] == 'GET' &&
          (c.$2['path'] == '/api/super-tabs/$tabId/parts' ||
              (c.$2['path'] as String).startsWith(
                '/api/super-tabs/$tabId/changes?',
              )),
    )
    .length;

/// A browser's app with one computer of its own, not connected yet, and a
/// Swarm tab restored on screen.
({AppNotifier app, SuperTabFixtureConnection connection}) _viewer() {
  final store = MemoryStore();
  final connection = SuperTabFixtureConnection(store);
  final session = AuthSession(storage: MemoryStore());
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: session,
    configStore: null,
    viewer: ViewerServices(
      config: AppConfig.dev,
      session: session,
      keys: ViewerKeyStore(storage: MemoryStore()),
    ),
    connectionForTest: (_) => connection,
    paneLayoutStore: PaneLayoutStore(storage: store),
  );
  connection.app = app;
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Studio Mac',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connecting
    ..agentLoadStatus = AgentLoadStatus.loaded;
  app.currentUser = const CurrentUserProfile(
    id: 'owner',
    email: 'owner@example.com',
  );
  app.bindSuperTab(app.activeSwarmId, tabId, 'Pilot');
  return (app: app, connection: connection);
}

/// The page hidden, the way a browser reports it: losing focus first.
void _hide(WidgetTester tester) {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
}

void _reveal(WidgetTester tester) {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
}

Future<void> _mount(
  WidgetTester tester,
  SuperTabLaunchFixture f, {
  WorkspaceChrome? chrome,
}) => _mountApp(tester, f.app, chrome: chrome);

Future<void> _mountApp(
  WidgetTester tester,
  AppNotifier app, {
  WorkspaceChrome? chrome,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: WorkspaceChromeScope(
          chrome: chrome,
          child: ListenableBuilder(
            listenable: app,
            builder: (_, _) => SuperTabWorkspace(
              app: app,
              canvas: const SizedBox.expand(),
              onAddAgent: (_) {},
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  group('Desktop: the daemon coming up reads the Swarm at once', () {
    late SuperTabLaunchFixture f;

    Future<void> opened() async {
      f = SuperTabLaunchFixture(local: true);
      f.app.superTabs.reading = SuperTabReading.desktop;
      f.app.machineStates['m']!.connectionStatus =
          ConnectionStatus.disconnected;
      f.app.connectionStatusForTest('m', ConnectionStatus.disconnected);
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
    }

    test('when this computer connects', () async {
      await opened();
      final before = _stateReads(f);
      f.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await Future<void>.delayed(Duration.zero);
      expect(_stateReads(f), before + 1);
      // Still connected: another status says nothing new.
      f.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await Future<void>.delayed(Duration.zero);
      expect(_stateReads(f), before + 1);
      f.app.superTabs.dispose();
    });

    test('and not while it is only connecting', () async {
      await opened();
      final before = _stateReads(f);
      f.app.connectionStatusForTest('m', ConnectionStatus.connecting);
      await Future<void>.delayed(Duration.zero);
      expect(_stateReads(f), before);
      f.app.superTabs.dispose();
    });

    test('when its backend comes back', () async {
      await opened();
      f.app.status = AppStatus.authenticated;
      f.app.noteBackendOnlineForTest(false);
      final before = _stateReads(f);
      f.app.noteBackendOnlineForTest(true);
      await Future<void>.delayed(Duration.zero);
      expect(_stateReads(f), before + 1);
      f.app.superTabs.dispose();
    });
  });

  testWidgets(
    'Desktop: a Swarm tab not shown, or a hidden app, polls every 15 s',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      await _mount(tester, f);
      final swarm = f.app.activeSwarmId;
      f.app.newSwarm();
      await tester.pump();
      final before = _stateReads(f);
      await tester.pump(const Duration(seconds: 30));
      expect(_stateReads(f) - before, 2);
      f.app.selectSwarm(swarm);
      _hide(tester);
      final hidden = _stateReads(f);
      await tester.pump(const Duration(seconds: 30));
      expect(_stateReads(f) - hidden, 2);
      _reveal(tester);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    },
  );

  testWidgets('web: another tab or a hidden page stops the Swarm tab reading', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    await _mount(tester, f, chrome: webWorkspaceChrome(f.app));
    final swarm = f.app.activeSwarmId;
    await tester.pump(const Duration(seconds: 3));
    expect(_stateReads(f), greaterThanOrEqualTo(2));
    f.app.newSwarm();
    await tester.pump();
    // The web keeps the view it read for the next open (#180 fix 4).
    await tester.pump();
    expect(
      f.store.values.keys.where((k) => k.startsWith('super_tab.view.')),
      isNotEmpty,
    );
    var before = _stateReads(f);
    await tester.pump(const Duration(seconds: 30));
    expect(_stateReads(f), before);
    f.app.selectSwarm(swarm);
    await tester.pump();
    await tester.pump();
    expect(_stateReads(f), before + 1);
    _hide(tester);
    await tester.pump();
    before = _stateReads(f);
    await tester.pump(const Duration(seconds: 30));
    expect(_stateReads(f), before);
    _reveal(tester);
    await tester.pump();
    expect(_stateReads(f), before + 1);
    await tester.pumpWidget(const SizedBox());
    f.dispose();
  });

  // At the app's level: a viewer's connect also loads the machine's data and
  // its device log, whose timers a widget test would have to wait out. The web
  // reads Swarm from the backend itself (docs/specs/2026-10-30-web-swarm-direct.md):
  // a machine still connecting does not hold the tab, and its connect is no
  // reason to read again.
  test('web: the Swarm tab reads from the backend while the machine is still '
      'connecting, and its connect reads nothing more', () async {
    final v = _viewer();
    final backend = WebSwarmBackend(v.connection.server);
    v.app.api = backend;
    v.app.superTabs
      ..reading = webWorkspaceChrome(v.app).superTabReading
      ..show(tabId);
    final c = await v.app.superTabs.open(tabId);
    await pumpEventQueue();
    expect(c.error, isNull);
    expect(c.snapshot, isNotNull);
    final reads = backend.calls.length;
    v.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await pumpEventQueue();
    expect(backend.calls, hasLength(reads));
    expect(_connectionReads(v.connection), 0);
    v.app.dispose();
  });

  test('web with Desktop reading: the Swarm loads from the backend and the '
      'machine is asked nothing', () async {
    final v = _viewer();
    final backend = WebSwarmBackend(v.connection.server);
    v.app.api = backend;
    final c = await v.app.superTabs.open(tabId);
    await pumpEventQueue();
    expect(c.error, isNull);
    expect(c.snapshot, isNotNull);
    v.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await pumpEventQueue();
    expect(_connectionReads(v.connection), 0);
    v.app.dispose();
  });
}
