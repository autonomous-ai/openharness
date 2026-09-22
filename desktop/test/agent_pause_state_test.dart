import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/restart_connection.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late RestartConnection connection;
  const source = Agent(
    id: 'a0',
    name: 'Disposable harness',
    engine: 'codex',
    sessionId: 'original-history',
    terminalAvailable: true,
  );
  Map<String, dynamic> inventory({bool paused = true}) => {
    'agents': [
      {
        'id': source.id,
        'name': source.name,
        'engine': source.engine,
        'sessionId': source.sessionId,
        'status': paused ? 'stopped' : 'active',
        'terminal': {'available': !paused},
      },
    ],
  };
  setUp(() {
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection);
    app.stateOf('m')!
      ..agents = [source]
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true;
  });
  tearDown(() => app.dispose());

  test('thirty pause/resume cycles preserve identity and issue one command per transition', () async {
    for (var cycle = 0; cycle < 30; cycle++) {
      connection.inventory = Completer<Map<String, dynamic>>()
        ..complete(inventory());
      final pause = app.pauseAgent('m', 'a0');
      expect(app.pauseAgent('m', 'a0'), same(pause));
      connection.stopReplies.last.complete({'deleted': true});
      expect(await pause, isNull);
      expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
      final resume = app.resumeAgent('m', 'a0');
      expect(app.resumeAgent('m', 'a0'), same(resume));
      connection.restartReplies.last.complete(
        restartReceipt(
          connection.requests.last['creationId'] as String,
          sessionId: source.sessionId,
        ),
      );
      expect((await resume).error, isNull);
      expect(app.stateOf('m')!.agents.single.sessionId, source.sessionId);
      expect(app.stateOf('m')!.agents.single.isStopped, isFalse);
    }
    expect(connection.stops, hasLength(30));
    expect(connection.types, List.filled(30, 'agent_resume'));
    expect(connection.checks, isEmpty);
  });

  test(
    'a confirmed pause remains in inventory when its refresh fails',
    () async {
      connection.inventory = Completer<Map<String, dynamic>>();
      final pause = app.pauseAgent('m', 'a0');
      connection.stopReplies.single.complete({'deleted': true});
      await Future<void>.delayed(Duration.zero);
      expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
      expect(app.pendingAgentPause('m', 'a0'), same(pause));
      expect(
        (await app.resumeAgent('m', 'a0')).error,
        contains('still pausing'),
      );
      expect(connection.requests, isEmpty);
      connection.inventory!.completeError(StateError('inventory unavailable'));
      expect(await pause, isNull);
      expect(app.stateOf('m')!.agents.single.sessionId, source.sessionId);
      expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
      expect(app.pendingAgentPause('m', 'a0'), isNull);
    },
  );

  test(
    'a lost stop reply resolves through inventory without another stop',
    () async {
      connection.inventory = Completer<Map<String, dynamic>>()
        ..complete(inventory());
      final pause = app.pauseAgent('m', 'a0');
      connection.stopReplies.single.completeError(
        const WsRequestTimeout('agent_delete'),
      );
      expect(await pause, isNull);
      expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
      expect(connection.stops, ['a0']);
    },
  );

  test(
    'a native refusal keeps the live harness and its actionable error',
    () async {
      connection.inventory = Completer<Map<String, dynamic>>()
        ..complete(inventory(paused: false));
      final pause = app.pauseAgent('m', 'a0');
      connection.stopReplies.single.completeError(
        const WsRequestFailure(
          responseType: 'agent_delete_result',
          code: 'STOP_UNCONFIRMED',
          detail: 'Could not confirm that the harness stopped.',
        ),
      );
      expect(
        await pause,
        contains('Could not confirm that the harness stopped.'),
      );
      expect(app.stateOf('m')!.agents.single.isStopped, isFalse);
      expect(connection.stops, ['a0']);
    },
  );

  test(
    'an ambiguous stop reply cannot turn a live harness into paused',
    () async {
      connection.inventory = Completer<Map<String, dynamic>>()
        ..complete(inventory(paused: false));
      final pause = app.pauseAgent('m', 'a0');
      connection.stopReplies.single.complete({});
      expect(await pause, contains('Could not confirm'));
      expect(app.stateOf('m')!.agents.single.isStopped, isFalse);
    },
  );

  test('pause never sends a command for an unsupported or missing saved conversation', () async {
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'a0',
        name: 'Other engine',
        engine: 'opencode',
        sessionId: 'saved',
        terminalAvailable: true,
      ),
    ];
    expect(await app.pauseAgent('m', 'a0'), isNotNull);
    app.stateOf('m')!.agents = [
      const Agent(
        id: 'a0',
        name: 'Not saved yet',
        engine: 'claude',
        terminalAvailable: true,
      ),
    ];
    expect(await app.pauseAgent('m', 'a0'), isNotNull);
    expect(connection.stops, isEmpty);
  });
}
