import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _RestartConnection extends WsConn {
  _RestartConnection(this.reply)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final Map<String, dynamic> reply;
  final calls = <(String, Map<String, dynamic>)>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, payload));
    return reply;
  }
}

void main() {
  for (final (reply, message) in <(Map<String, dynamic>, String?)>[
    ({'resumed': true}, null),
    (
      {'resumed': false},
      'Started a new conversation. The previous session could not be resumed.',
    ),
    (
      {'error': 'AGENT_BUSY', 'detail': 'The engine could not restart.'},
      'The engine could not restart.',
    ),
  ]) {
    testWidgets('File restart targets the focused harness and reports $reply', (
      tester,
    ) async {
      final connection = _RestartConnection(reply);
      final app = createApp(connectionForTest: (_) => connection);
      app.machineStates['m']!.nodeOnline = true;
      final first = app.adoptSessionForTest(terminal('a0', []));
      final session = first.session;
      final second = app.adoptSessionForTest(terminal('a1', []));
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      await mount(tester, app, nativeTabs: true);
      expect(app.focusedPane, same(second));
      app.focusPane(first.id);
      await tester.pump();
      expect((updates.last['paneActions'] as Map)['restartAgent'], isTrue);
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('restartAgent'),
        ),
        (_) {},
      );
      await tester.pumpAndSettle();
      // Each pane header's model picker also asks for grid_models_list as it mounts; the restart is
      // the one request that is not that.
      final sent = connection.calls
          .where((call) => call.$1 == 'agent_restart')
          .toList();
      expect(sent, hasLength(1));
      expect(sent.single.$1, 'agent_restart');
      expect(sent.single.$2, {'agentId': 'a0', 'creationId': isA<String>()});
      expect(app.panes, [first, second]);
      expect(first.session, same(session));
      expect(find.byType(AlertDialog), findsNothing);
      if (message == null) {
        expect(find.byType(SnackBar), findsNothing);
      } else {
        expect(find.text(message), findsOneWidget);
      }
      app.machineStates['m']!.nodeOnline = false;
      app.notifyListeners();
      await tester.pump();
      expect((updates.last['paneActions'] as Map)['restartAgent'], isFalse);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
}
