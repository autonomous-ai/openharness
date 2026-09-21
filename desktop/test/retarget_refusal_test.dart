// What the app says when the daemon refuses to move an agent to another model — one sentence per
// refusal, in the app's own words: the daemon's `detail` is written for its log and names the grid.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/retarget_refusal.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// A connection whose daemon refuses every `agent_retarget` with [code].
class _Refusing extends WsConn {
  _Refusing(this.code)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final String code;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_retarget') {
      throw WsRequestFailure(
        responseType: 'agent_retarget_result',
        code: code,
        detail: 'cursor cannot run on grid kelvin-e2e: …', // the daemon's words, never shown
      );
    }
    return {};
  }
}

void main() {
  test(
    'a refused retarget reaches the user as a sentence, naming the engine',
    () async {
      // The daemon refuses before touching the pane, so the pane says nothing; the app used to
      // swallow the refusal too, and a click on a Local model for a Cursor agent did nothing at all.
      final app = createApp(
        connectionForTest: (_) => _Refusing('GRID_ENGINE_UNSUPPORTED'),
      );
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = const [
        Agent(
          id: 'c1',
          name: 'BTC Price Search',
          engine: 'cursor',
          terminalAvailable: true,
        ),
      ];

      await app.retargetAgentToGridModel('m', 'c1', 'qwen/qwen3.6-35b-a3b');

      expect(
        app.lastError,
        'Cursor can only run on its own login, not a Local model.',
      );
      expect(app.lastError, isNot(contains('grid')));
    },
  );

  test('moving home is reported the same way', () async {
    final app = createApp(connectionForTest: (_) => _Refusing('AGENT_BUSY'));
    addTearDown(app.dispose);
    await app.clearAgentGrid('m', 'a1');
    expect(app.lastError, contains('still responding'));
  });

  test('names the engine that can only run on its own login', () {
    expect(
      retargetRefusalMessage('GRID_ENGINE_UNSUPPORTED', engineLabel: 'Cursor'),
      'Cursor can only run on its own login, not a Local model.',
    );
  });

  test(
    'a busy agent is told to stop it or let it finish — never "mid-turn"',
    () {
      final sentence = retargetRefusalMessage(
        'AGENT_BUSY',
        engineLabel: 'Claude Code',
      );
      expect(sentence, contains('Stop it'));
      expect(sentence, contains('finish'));
      expect(sentence, isNot(contains('mid-turn')));
    },
  );

  test(
    'every refusal the daemon can raise has a sentence, and none says "grid"',
    () {
      const codes = [
        'GRID_ENGINE_UNSUPPORTED',
        'GRID_MODEL_REQUIRED',
        'GRID_UNAVAILABLE',
        'GRID_CONFIG_FAILED',
        'GRID_CLEAR_FAILED',
        'TMUX_TOO_OLD_FOR_GRID',
        'TMUX_UNAVAILABLE',
        'TMUX_FAILED',
        'AGENT_BUSY',
        'AGENT_NOT_FOUND',
        'NO_ACTIVE_PROCESS',
        'RETARGET_UNSUPPORTED_BACKEND',
        'RESPAWN_FAILED',
        'INVALID_GRID',
        'MISSING_AGENT_ID',
        'UNSUPPORTED_ON_REMOTE',
        'UNSUPPORTED',
        'SOMETHING_NEW',
      ];
      for (final code in codes) {
        final message = retargetRefusalMessage(code, engineLabel: 'Codex');
        expect(message, isNotEmpty, reason: code);
        expect(message.toLowerCase(), isNot(contains('grid')), reason: code);
        expect(message, isNot(contains(code)), reason: code);
      }
    },
  );
}
