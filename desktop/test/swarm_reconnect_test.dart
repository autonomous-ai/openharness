import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

class _ReconnectConnection extends WsConn {
  _ReconnectConnection()
    : super(
        wsBaseUrl: '',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final opened = <String>[];
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agents_list'
      ? {
          'agents': [
            for (final id in ['a0', 'a1'])
              {
                'id': id,
                'name': id,
                'engine': 'codex',
                'terminal': {
                  'runtimes': [
                    {'backend': 'tmux', 'paneId': id == 'a0' ? '%1' : '%2'},
                  ],
                },
              },
          ],
        }
      : {
          'protocolVersion': 3,
          'backend': 'tmux',
          'available': true,
          // A current daemon — see `AttachIntent`: without `noTakeover` a
          // reconnect may not reopen anything on its own.
          'features': {'noTakeover': true},
        };
  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (type == 'terminal_open') opened.add(payload['agentId'] as String);
    return true;
  }
}

void main() {
  testWidgets(
    'reconnection restores each tab without inserting or focusing another agent',
    (tester) async {
      final connection = _ReconnectConnection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!..nodeOnline = true;
      TerminalSession terminal(String id) => TerminalSession(
        machineId: 'm',
        agentId: id,
        agentName: id,
        engineId: 'codex',
        send: connection.sendTerminalFrame,
        sendBinary: (_) async => true,
      )..status = TerminalSessionStatus.controlling;
      app.adoptSessionForTest(terminal('a0'));
      final first = app.activeSwarm;
      app.newSwarm(name: 'Second');
      final secondPane = app.adoptSessionForTest(terminal('a1'));
      final second = app.activeSwarm;
      app.selectedMachineId = 'm';
      final before = [
        for (final tab in app.swarms) [for (final pane in tab.panes) pane.id],
      ];

      await app.handleEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': false},
      });
      expect(machine.pendingOfflineAgentId, 'a0');
      expect(
        app.allPanes.every(
          (pane) => pane.session?.status == TerminalSessionStatus.error,
        ),
        isTrue,
      );
      await app.handleEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': true},
      });
      for (var i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(machine.pendingOfflineAgentId, isNull);
      expect(connection.opened.toSet(), {'a0', 'a1'});
      expect([
        for (final tab in app.swarms) [for (final pane in tab.panes) pane.id],
      ], before);
      expect(first.panes.single.agentId, 'a0');
      expect(second.panes.single, same(secondPane));
      expect(app.activeSwarm, same(second));
      expect(app.focusedPane, same(secondPane));
      for (final pane in app.allPanes) {
        await pane.session?.close();
      }
    },
  );
}
