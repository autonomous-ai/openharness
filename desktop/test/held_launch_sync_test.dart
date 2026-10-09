import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// A daemon that holds an agent back, then starts it: what `agents_list` answers is [state].
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  var state = 'held';
  var lists = 0;
  var inFlight = 0, mostInFlight = 0;

  /// When set, `agents_list` answers only when the test completes it, with the state at the ask.
  Completer<void>? gate;
  Map<String, dynamic> agent() => {
    'id': 'a1',
    'name': 'fix the dial scroll',
    'engine': 'claude',
    'terminal': {'available': true},
    'launch': {
      'state': state,
      if (state == 'held') 'service': 'search',
      if (state == 'held')
        'detail': 'Waiting for the search service to verify this conversation.',
    },
  };
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agents_list') return const {};
    lists++;
    final answer = agent();
    inFlight++;
    if (inFlight > mostInFlight) mostInFlight = inFlight;
    try {
      await gate?.future;
    } finally {
      inFlight--;
    }
    return {
      'agents': [answer],
    };
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Daemon daemon;
  late AppNotifier app;
  setUp(() {
    daemon = _Daemon();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => daemon,
    )..heldLaunchSyncInterval = const Duration(milliseconds: 20);
    const m = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'This Mac',
    );
    app.machines = [m];
    app.machineStates['m'] = MachineState(m)
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
  });
  tearDown(() => app.dispose());

  Agent agent() => app.stateOf('m')!.agents.singleWhere((a) => a.id == 'a1');

  // On a fresh VM (2026-10-09) the daemon started reopened conversations it had held, and the app
  // showed them "Waiting" for a minute more: until its 60 s agent sync.
  test('a held harness is read again until the daemon has started it, then no more', () async {
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': daemon.agent()},
    });
    expect(agent().launchState, 'held');
    await Future<void>.delayed(const Duration(milliseconds: 70));
    expect(daemon.lists, greaterThan(0), reason: 'read again while held');
    expect(agent().launchState, 'held');

    daemon.state = 'ready';
    // Backing off from 20 ms while nothing changed: 40, then 80 ms to the next read.
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(agent().launchState, 'ready');
    final settled = daemon.lists;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(daemon.lists, settled, reason: 'nothing held: no more reads');
  });

  test(
    'a read asked before a push is thrown away, and reads never overlap',
    () async {
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {'agent': daemon.agent()},
      });
      daemon.gate = Completer<void>();
      // A read is asked while held, and answers only after the daemon's own push said ready.
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(daemon.inFlight, 1);
      daemon.state = 'ready';
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {'agent': daemon.agent()},
      });
      expect(agent().launchState, 'ready');
      daemon.gate!.complete();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(
        agent().launchState,
        'ready',
        reason: 'the older "held" answer is not applied',
      );
      expect(daemon.mostInFlight, 1);
    },
  );

  test('backs off while nothing changes', () async {
    app.heldLaunchSyncInterval = const Duration(milliseconds: 10);
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': daemon.agent()},
    });
    // 10, 20, 40, 80, then 100 ms apart: about five reads in 300 ms, not thirty.
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(daemon.lists, inInclusiveRange(4, 7));
  });

  test('a machine with nothing held is not read again', () async {
    daemon.state = 'ready';
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': daemon.agent()},
    });
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(daemon.lists, 0);
  });
}
