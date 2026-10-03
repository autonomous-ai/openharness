import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/teams/team_workspace.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;
import 'support/team_fixture.dart';

class ChannelConnection extends WsConn {
  ChannelConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final calls = <Map<String, dynamic>>[];
  final pending = Completer<Map<String, dynamic>>();
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'team') {
      calls.add(payload);
      return pending.future;
    }
    return {};
  }
}

void main() {
  for (final shared in [true, false]) {
    test(
      'tab reads use an owned available gateway when preferred is ${shared ? 'shared' : 'offline'}',
      () async {
        final connection = ChannelConnection();
        final gateways = <String>[];
        final app = createApp(
          connected: true,
          connectionForTest: (machineId) {
            gateways.add(machineId);
            return connection;
          },
        );
        final preferred = Machine(
          machineId: 'preferred',
          authMode: MachineAuthMode.remote,
          isShared: shared,
        );
        app.machineStates['preferred'] = MachineState(preferred)
          ..connectionStatus = shared
              ? ConnectionStatus.connected
              : ConnectionStatus.disconnected;
        final tabId = app.activeSwarmId;
        final controller = app.channelController(tabId, 'preferred');
        connection.pending.complete({
          'team': {
            ...teamFixture(),
            'machineId': 'm',
            'channel': {'tabId': tabId},
          },
        });
        await controller.refresh();
        expect(gateways, ['m']);
        expect(connection.calls, [
          {'action': 'channel_get', 'tabId': tabId},
        ]);
        expect(controller.error, isNull);
        app.dispose();
        await connection.close();
      },
    );
  }

  testWidgets('Cmd+Shift+A does not start cross-tab work', (tester) async {
    final connection = ChannelConnection();
    final app = createApp(connectionForTest: (_) => connection, connected: true)
      ..status = AppStatus.authenticated;
    final map = MemoryKeymap();
    final frames = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', frames));
    await mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyA, cmd: true, shift: true);
    await tester.pump();
    expect(connection.calls, isEmpty);
    expect(find.byType(TeamWorkspace), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
    await connection.close();
  });
}
