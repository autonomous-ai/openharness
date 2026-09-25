import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/ws/ws_conn.dart';

const _machine = Machine(
  machineId: 'm',
  name: 'Fixture computer',
  authMode: MachineAuthMode.remote,
  status: 'online',
);

const _agents = {
  'agents': [
    {
      'id': 'a',
      'name': 'Fixture agent',
      'engine': 'codex',
      'terminal': {
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%1'},
        ],
      },
    },
  ],
};
const _capabilities = {
  'protocolVersion': 3,
  'backend': 'tmux',
  'available': true,
  // A current daemon: it honours `takeover: false`, which is what lets these
  // panes attach with nobody asking (see `AttachIntent`).
  'features': {'noTakeover': true},
};

class DiscoveryConnection extends WsConn {
  DiscoveryConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final calls = <String>[];
  final agents = <Completer<Map<String, dynamic>>>[];
  final capabilities = <Completer<Map<String, dynamic>>>[];
  final themes = <Map<String, dynamic>>[];
  bool refuseTheme = false;
  final timeouts = <String, Duration>{};
  final sent = <String>[];
  final frames = <({String type, Map<String, dynamic> payload})>[];
  Completer<void>? readiness;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {
    await readiness?.future;
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    calls.add(type);
    timeouts[type] = timeout;
    final response = Completer<Map<String, dynamic>>();
    switch (type) {
      case 'agents_list':
        agents.add(response);
      case 'terminal_capabilities':
        capabilities.add(response);
      case 'theme_set':
        themes.add(payload);
        if (refuseTheme) {
          response.completeError(StateError('daemon predates theme_set'));
        } else {
          response.complete({'applied': true});
        }
      default:
        throw StateError('Unexpected request: $type');
    }
    return response.future;
  }

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    sent.add(type);
    frames.add((type: type, payload: Map.of(payload)));
    return true;
  }
}

Future<void> _tick() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late MachineState machine;
  late DiscoveryConnection connection;
  late bool disposed;

  setUp(() {
    disposed = false;
    connection = DiscoveryConnection();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      connectionForTest: (_) => connection,
    )..status = AppStatus.authenticated;
    machine = MachineState(_machine)..nodeOnline = true;
    app.machines = [_machine];
    app.machineStates['m'] = machine;
  });
  tearDown(() {
    if (!disposed) app.dispose();
  });

  test('agent inventory and capabilities are requested together', () async {
    final load = app.reloadMachineData('m');
    await _tick();
    final capabilitiesStarted = connection.capabilities.isNotEmpty;
    connection.agents.single.complete(_agents);
    await _tick();
    connection.capabilities.single.complete(_capabilities);
    await load;
    expect(capabilitiesStarted, isTrue);
    expect(machine.agents.single.id, 'a');
    expect(machine.terminalCapabilityAvailable, isTrue);
  });

  test('agents become visible before a slow capability response', () async {
    var sawAgents = false;
    app.addListener(() {
      if (machine.agents.isNotEmpty) sawAgents = true;
    });
    final load = app.reloadMachineData('m');
    await _tick();
    connection.agents.single.complete(_agents);
    await _tick();
    final visibleBeforeCapabilities = sawAgents;
    connection.capabilities.single.complete(_capabilities);
    await load;
    expect(visibleBeforeCapabilities, isTrue);
    expect(machine.agentLoadStatus, AgentLoadStatus.loaded);
  });

  test('handshake time stays inside the existing inventory budget', () async {
    connection.readiness = Completer<void>();
    final load = app.reloadMachineData('m');
    await Future<void>.delayed(const Duration(milliseconds: 5));
    expect(connection.calls, isEmpty);
    connection.readiness!.complete();
    await _tick();
    expect(connection.calls, ['terminal_capabilities', 'agents_list']);
    expect(
      connection.timeouts['agents_list']!,
      lessThan(const Duration(seconds: 10)),
    );
    expect(connection.timeouts['agents_list']!, greaterThan(Duration.zero));
    expect(
      connection.timeouts['terminal_capabilities'],
      const Duration(seconds: 8),
    );
    connection.agents.single.complete(_agents);
    connection.capabilities.single.complete(_capabilities);
    await load;
  });

  test('repeated reloads share both pending discovery requests', () async {
    final first = app.reloadMachineData('m');
    final second = app.reloadMachineData('m');
    await _tick();
    expect(connection.agents, hasLength(1));
    expect(connection.capabilities, hasLength(1));
    connection.agents.single.complete(_agents);
    connection.capabilities.single.complete(_capabilities);
    await Future.wait([first, second]);
    expect(machine.agentsLoadInFlight, isNull);
    expect(machine.terminalCapabilityLoadInFlight, isNull);
  });

  for (final agentsFirst in [true, false]) {
    test(
      'restored agent attaches once with ${agentsFirst ? 'agents' : 'capabilities'} first',
      () async {
        final pane = TerminalPane(id: 99, machineId: 'm', agentId: 'a');
        app.activeSwarm.panes.add(pane);
        final focus = app.focusedPaneId;
        final load = app.reloadMachineData('m');
        await _tick();
        if (agentsFirst) {
          connection.agents.single.complete(_agents);
        } else {
          connection.capabilities.single.complete(_capabilities);
        }
        await _tick();
        expect(pane.session, isNull);
        if (agentsFirst) {
          connection.capabilities.single.complete(_capabilities);
        } else {
          connection.agents.single.complete(_agents);
        }
        await load;
        await _tick();
        expect(pane.session, isNotNull);
        pane.session!.reportViewport(100, 30);
        await _tick();
        expect(
          connection.sent.where((type) => type == 'terminal_open'),
          hasLength(1),
        );
        expect(app.focusedPaneId, focus);
        expect(app.panes.single, same(pane));
      },
    );
  }

  test('unavailable capabilities leave discovered agents visible without attaching', () async {
    final pane = TerminalPane(id: 99, machineId: 'm', agentId: 'a');
    app.activeSwarm.panes.add(pane);
    final load = app.reloadMachineData('m');
    await _tick();
    connection.capabilities.single.completeError(StateError('Unsupported'));
    connection.agents.single.complete(_agents);
    await load;
    expect(machine.agents.single.id, 'a');
    expect(machine.agentLoadStatus, AgentLoadStatus.loaded);
    expect(machine.terminalCapabilityAvailable, isFalse);
    expect(machine.terminalCapabilityError, isNotNull);
    expect(pane.session, isNull);
    expect(connection.sent, isEmpty);
  });

  test(
    'inventory failure can retry while sharing the pending capability request',
    () async {
      final failed = app.reloadMachineData('m');
      await _tick();
      connection.agents.single.completeError(
        StateError('Inventory unavailable'),
      );
      await failed;
      expect(machine.agentsLoadError, contains('Inventory unavailable'));
      final retry = app.reloadMachineData('m');
      await _tick();
      expect(connection.capabilities, hasLength(1));
      expect(connection.agents, hasLength(2));
      connection.capabilities.single.complete(_capabilities);
      connection.agents.last.complete(_agents);
      await retry;
      expect(machine.agentsLoadError, isNull);
      expect(machine.terminalCapabilityAvailable, isTrue);
    },
  );

  test('a removed machine cannot send requests after late readiness', () async {
    connection.readiness = Completer<void>();
    final load = app.reloadMachineData('m');
    await _tick();
    app.machineStates.clear();
    connection.readiness!.complete();
    await load;
    expect(connection.calls, isEmpty);
    expect(app.panes, isEmpty);
  });

  for (final oldFails in [false, true]) {
    test(
      'reconnect replaces pending capability discovery (old failure=$oldFails)',
      () async {
        final old = app.reloadMachineData('m');
        await _tick();
        connection.agents.single.complete(_agents);
        await _tick();
        app.onMachineConnectedForTest('m');
        await _tick();
        expect(connection.agents, hasLength(2));
        expect(connection.capabilities, hasLength(2));
        connection.agents.last.complete(_agents);
        connection.capabilities.last.complete({
          ..._capabilities,
          'features': {'imagePaste': true},
        });
        await machine.agentsLoadInFlight;
        if (oldFails) {
          connection.capabilities.first.completeError(StateError('old daemon'));
        } else {
          connection.capabilities.first.complete({'available': false});
        }
        await old;
        expect(machine.terminalCapabilityAvailable, isTrue);
        expect(machine.terminalImagePasteAvailable, isTrue);
        expect(machine.terminalCapabilityError, isNull);
        expect(machine.agentsLoadError, isNull);
      },
    );
  }

  test(
    'an old inventory timeout cannot mark a reconnected machine offline',
    () async {
      final old = app.reloadMachineData('m');
      await _tick();
      app.onMachineConnectedForTest('m');
      await _tick();
      connection.agents.first.completeError(
        const WsRequestTimeout('agents_list'),
      );
      connection.capabilities.first.complete(_capabilities);
      await old;
      await _tick();
      expect(machine.nodeOnline, isTrue);
      expect(machine.agentsLoadError, isNull);
      expect(
        machine.agentsRefreshing ||
            machine.agentLoadStatus == AgentLoadStatus.loading,
        isTrue,
      );
    },
  );

  test('an offline transition invalidates a pending agent inventory', () async {
    final old = app.reloadMachineData('m');
    await _tick();
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    connection.agents.first.complete(_agents);
    connection.capabilities.first.complete(_capabilities);
    await old;
    expect(machine.nodeOnline, isFalse);
    expect(machine.agents, isEmpty);
    expect(machine.terminalCapabilityAvailable, isFalse);
    expect(machine.agentsRefreshing, isFalse);
  });

  testWidgets(
    'an old background inventory cannot overwrite reconnect discovery',
    (tester) async {
      try {
        app.onMachineConnectedForTest('m');
        await tester.pump();
        connection.agents.single.complete(_agents);
        connection.capabilities.single.complete(_capabilities);
        await tester.pump();
        await tester.pump(AppNotifier.agentSyncInterval);
        expect(connection.agents, hasLength(2));
        final oldPoll = connection.agents.last;
        app.onMachineConnectedForTest('m');
        await tester.pump();
        connection.agents.last.complete({
          'agents': [
            {'id': 'new-agent', 'name': 'New agent', 'engine': 'codex'},
          ],
        });
        connection.capabilities.last.complete(_capabilities);
        await tester.pump();
        expect(machine.agents.single.id, 'new-agent');
        oldPoll.complete(_agents);
        await tester.pump();
        expect(machine.agents.single.id, 'new-agent');
      } finally {
        app.dispose();
        disposed = true;
      }
    },
  );

  test(
    'a replacement connection releases its old terminal stream immediately',
    () async {
      final session =
          TerminalSession(
              machineId: 'm',
              agentId: 'a',
              agentName: 'Fixture',
              engineId: 'codex',
              send: connection.sendTerminalFrame,
              sendBinary: (_) async => true,
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'old-stream';
      session.terminal.write('Keep this output');
      final renderer = session.terminal;
      final pane = app.adoptSessionForTest(session);
      app.onMachineConnectedForTest('m');
      await _tick();
      expect(pane.session, same(session));
      expect(session.terminal, same(renderer));
      expect(session.terminal.buffer.getText(), contains('Keep this output'));
      expect(session.streamId, isNull);
      expect(session.status, TerminalSessionStatus.error);
    },
  );

  test(
    'a second reconnect does not wait for the first pending recovery',
    () async {
      machine.nodeOnline = false;
      machine.pendingOfflineAgentId = 'a';
      Future<void> online(bool value) => app.handleEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': value},
      });
      await online(true);
      await _tick();
      expect(connection.agents, hasLength(1));
      await online(false);
      await online(true);
      await _tick();
      expect(connection.agents, hasLength(2));
      expect(connection.capabilities, hasLength(2));
      connection.agents.last.complete(_agents);
      connection.capabilities.last.complete(_capabilities);
      await _tick();
      expect(machine.pendingOfflineAgentId, isNull);
      connection.agents.first.complete({'agents': []});
      connection.capabilities.first.complete({'available': false});
      await _tick();
      expect(machine.agents.single.id, 'a');
      expect(machine.terminalCapabilityAvailable, isTrue);
      expect(machine.pendingOfflineAgentId, isNull);
    },
  );

  group('pane colours reach the daemon', () {
    tearDown(() {
      grid.AppTheme.palette.value = HarnessPalette.graphite;
      terminalThemeStore.value = TerminalThemeChoice.matchApp;
    });

    test('are announced when a machine connects, as the colours the panes are painted with', () async {
      grid.AppTheme.palette.value = HarnessPalette.midnight;
      app.onMachineConnectedForTest('m');
      await _tick();
      connection.agents.single.complete(_agents);
      await _tick();
      connection.capabilities.single.complete(_capabilities);
      await _tick();

      expect(connection.themes, [
        {'background': '#171b29', 'foreground': '#f5f5f5'},
      ]);
      expect(connection.timeouts['theme_set'], const Duration(seconds: 5));
    });

    test('are re-announced to connected machines when the palette or terminal theme changes', () async {
      machine.connectionStatus = ConnectionStatus.connected;
      grid.AppTheme.palette.value = HarnessPalette.forest;
      await _tick();
      // Tango is its own scheme: what goes out is what the pane draws, not the app palette.
      terminalThemeStore.value = TerminalThemeChoice.tango;
      await _tick();

      expect(connection.themes, [
        {'background': '#18231e', 'foreground': '#f5f5f5'},
        {'background': '#300a24', 'foreground': '#ffffff'},
      ]);
    });

    test('a daemon that cannot take the colours is not an error', () async {
      connection.refuseTheme = true;
      machine.connectionStatus = ConnectionStatus.connected;
      grid.AppTheme.palette.value = HarnessPalette.slate;
      await _tick();
      await _tick();

      expect(connection.themes, hasLength(1));
      expect(app.lastError, isNull);
    });
  });
}
