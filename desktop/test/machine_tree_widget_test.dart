import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:flutter_test/flutter_test.dart';

class ReloadTrackingNotifier extends AppNotifier {
  int machineRefreshes = 0;
  final List<String> agentReloads = [];

  ReloadTrackingNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  @override
  Future<void> ensureCliDaemonReady() async {}

  @override
  Future<bool> refreshMachines() async {
    machineRefreshes++;
    return true;
  }

  @override
  Future<void> reloadMachineData(String machineId) async {
    agentReloads.add(machineId);
  }
}

void main() {
  const machine = Machine(
    machineId: 'machine-1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'prod-mac',
    status: 'online',
  );

  AppNotifier notifierWithTree() {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = MachineState(machine)
      ..connectionStatus = ConnectionStatus.connected
      ..terminalCapabilityLoaded = true
      ..terminalCapabilityAvailable = true
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent.fromJson({
          'id': 'parent',
          'sessionId': 'session-parent',
          'name': 'backend-api',
          'engine': 'codex',
          'status': 'busy',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
        Agent.fromJson({
          'id': 'child',
          'sessionId': 'session-child',
          'parentAgentId': 'parent',
          'name': 'future-worker',
          'engine': 'engine-added-after-app-release',
          'status': 'active',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%2'},
            ],
          },
        }),
        Agent.fromJson({
          'id': 'herdr-only',
          'sessionId': 'session-herdr',
          'name': 'herdr-session',
          'engine': 'claude',
          'status': 'active',
          'terminal': {
            'runtimes': [
              {
                'backend': 'herdr',
                'endpointId': 'endpoint-a',
                'sessionName': 'default',
                'terminalId': 'terminal-a',
                'paneId': 'w1:p1',
              },
            ],
          },
        }),
      ];
    state.sessionAgentIds.addAll({
      'session-parent': 'parent',
      'session-child': 'child',
      'session-herdr': 'herdr-only',
    });
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = state;
    notifier.expandedMachines.add(machine.machineId);
    return notifier;
  }

  test('offline agent selection keeps the agent pending', () async {
    final notifier = notifierWithTree();
    final state = notifier.machineStates[machine.machineId]!;
    state.nodeOnline = false;

    await notifier.selectAgent(machine.machineId, 'parent');

    expect(state.activeAgentId, 'parent');
    expect(state.pendingOfflineAgentId, 'parent');
    expect(notifier.activeTerminal, isNull);
    notifier.dispose();
  });

  test('reselecting the active agent keeps its terminal controller', () async {
    final notifier = notifierWithTree();
    final active =
        TerminalSession(
            machineId: machine.machineId,
            agentId: 'parent',
            agentName: 'backend-api',
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-active';
    notifier.adoptSessionForTest(active);

    await notifier.selectAgent(machine.machineId, 'parent');

    expect(notifier.activeTerminal, same(active));
    expect(active.streamId, 'stream-active');
    expect(notifier.stateOf(machine.machineId)?.activeAgentId, 'parent');
    notifier.dispose();
  });

  test('decrypted events preserve session correlation metadata', () {
    final clear = eventWithClearPayload(
      {
        'type': 'turn_started',
        'agentId': 'agent-1',
        'dbSessionId': 'session-1',
        'payload': {'__e2e': {}},
      },
      'turn_started',
      {'userMessage': 'hello'},
    );

    expect(clear['agentId'], 'agent-1');
    expect(clear['dbSessionId'], 'session-1');
    expect(clear['payload'], {'userMessage': 'hello'});
  });

  test('rename and delete update the selected terminal session', () async {
    final notifier = notifierWithTree();
    final state = notifier.machineStates[machine.machineId]!;
    final terminal = TerminalSession(
      machineId: machine.machineId,
      agentId: 'parent',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    notifier.adoptSessionForTest(terminal);
    state.activeAgentId = 'parent';

    await notifier.handleEventForTest(machine.machineId, {
      'type': 'agent_renamed',
      'payload': {'agentId': 'parent', 'name': 'renamed-api'},
    });
    expect(terminal.agentName, 'renamed-api');
    expect(state.agents.first.name, 'renamed-api');

    await notifier.handleEventForTest(machine.machineId, {
      'type': 'agent_deleted',
      'payload': {'agentId': 'parent'},
    });
    expect(notifier.activeTerminal, isNull);
    expect(state.activeAgentId, isNull);
    expect(state.agents.any((agent) => agent.id == 'parent'), isFalse);
    notifier.dispose();
  });

  test(
    'renameAgent/deleteAgent reject an unknown machine or empty name',
    () async {
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      expect(
        await notifier.renameAgent('missing-machine', 'agent-1', 'new name'),
        'Machine not found',
      );
      expect(
        await notifier.deleteAgent('missing-machine', 'agent-1'),
        'Machine not found',
      );

      final seeded = notifierWithTree();
      notifier.machines = seeded.machines;
      notifier.machineStates.addAll(seeded.machineStates);
      seeded.machineStates.clear();
      seeded.dispose();

      expect(
        await notifier.renameAgent(machine.machineId, 'parent', '   '),
        'Name cannot be empty',
      );
      notifier.dispose();
    },
  );

  test('restartAgent rejects an unknown machine', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    expect(
      (await notifier.restartAgent('missing-machine', 'agent-1')).error,
      'Machine not found',
    );
    notifier.dispose();
  });

  test('renameMachine rejects an unknown machine or empty name', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    expect(
      await notifier.renameMachine('missing-machine', 'new name'),
      'Machine not found',
    );

    final seeded = notifierWithTree();
    notifier.machines = seeded.machines;
    notifier.machineStates.addAll(seeded.machineStates);
    seeded.machineStates.clear();
    seeded.dispose();

    expect(
      await notifier.renameMachine(machine.machineId, '   '),
      'Name cannot be empty',
    );
    notifier.dispose();
  });

  test('deleteMachine rejects an unknown machine', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    expect(
      await notifier.deleteMachine('missing-machine'),
      'Machine not found',
    );
    notifier.dispose();
  });

  test(
    'node_status offline marks the active terminal transport lost',
    () async {
      final notifier = notifierWithTree();
      final state = notifier.machineStates[machine.machineId]!;
      final terminal = TerminalSession(
        machineId: machine.machineId,
        agentId: 'parent',
        agentName: 'backend-api',
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      );
      terminal.status = TerminalSessionStatus.controlling;
      notifier.adoptSessionForTest(terminal);

      // First "online" after boot is not a reconnect (nodeOnline starts
      // null) — nothing should happen to an already-controlling terminal.
      await notifier.handleEventForTest(machine.machineId, {
        'type': 'node_status',
        'payload': {'online': true},
      });
      expect(state.nodeOnline, isTrue);
      expect(terminal.status, TerminalSessionStatus.controlling);

      // The adapter drops (e.g. `harness stop`) while our own websocket to
      // the backend stays up — the terminal has nothing to reattach to.
      await notifier.handleEventForTest(machine.machineId, {
        'type': 'node_status',
        'payload': {'online': false},
      });
      expect(state.nodeOnline, isFalse);
      expect(state.pendingOfflineAgentId, 'parent');
      expect(terminal.status, TerminalSessionStatus.error);
      notifier.dispose();
    },
  );

  test('a mid-session NO_PEER_LINK marks the open terminal lost without calling the node offline', () async {
    // The CLI closes with 4404 when the peer revokes trust while terminals
    // are open. The socket drop that follows must no longer paint the
    // machine offline (NO_PEER_LINK is a local lookup, not a verdict on the
    // other computer) — but the tiles still have to know, and what they
    // showed still has to be recorded for the reattach after relinking.
    final notifier = notifierWithTree();
    final state = notifier.machineStates[machine.machineId]!..nodeOnline = true;
    final terminal = TerminalSession(
      machineId: machine.machineId,
      agentId: 'parent',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    )..status = TerminalSessionStatus.controlling;
    notifier.adoptSessionForTest(terminal);

    notifier.localFailureForTest(machine.machineId, 4404, 'peer revoked trust');

    expect(state.needsLink, isTrue);
    expect(state.agentLoadStatus, AgentLoadStatus.needsLink);
    expect(state.nodeOnline, isTrue);
    expect(state.pendingOfflineAgentId, 'parent');
    expect(terminal.status, TerminalSessionStatus.error);
    notifier.dispose();
  });

  test('collapse only changes the tree and does not close active terminal', () {
    final notifier = notifierWithTree();
    final terminal = TerminalSession(
      machineId: machine.machineId,
      agentId: 'parent',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    notifier.adoptSessionForTest(terminal);

    notifier.toggleExpand(machine.machineId);

    expect(notifier.expandedMachines, isNot(contains(machine.machineId)));
    expect(identical(notifier.activeTerminal, terminal), isTrue);
    expect(terminal.status, TerminalSessionStatus.closed);
    notifier.dispose();
  });

  test(
    'global reload refreshes machines and every expanded agent tree',
    () async {
      final notifier = ReloadTrackingNotifier();
      notifier.expandedMachines.addAll(['machine-a', 'machine-b']);

      await notifier.retryMachines();

      expect(notifier.machineRefreshes, 1);
      expect(notifier.agentReloads, containsAll(['machine-a', 'machine-b']));
      notifier.dispose();
    },
  );
}
