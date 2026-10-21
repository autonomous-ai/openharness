import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// This computer's connection, with the private pipe available or missing.
class _Conn extends WsConn {
  _Conn({required this.missing})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse('ws://127.0.0.1:1/ws'),
        trustedLocal: true,
      );

  bool missing;
  final sent = <String>[];
  bool ready = true;

  @override
  bool get isReady => ready;

  @override
  bool get trustedPipeMissing => missing;

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    sent.add(type);
    return true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'the daemon_* frames go only on harnessd\'s private connection',
    () async {
      final conn = _Conn(missing: true);
      final app = createApp(connectionForTest: (_) => conn, connected: true);
      addTearDown(app.dispose);
      app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
        computerId: '0123456789abcdef0123456789abcdef',
        wsUri: Uri.parse('ws://127.0.0.1:1/ws'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
      );
      app.adoptPoolConnectionForTest('m', conn);

      expect(app.daemonTrustedConnectionMissing, isTrue);
      expect(
        app.sendDaemonFrame('daemon_act', {'id': 's1', 'choice': 'y'}),
        isFalse,
      );
      await Future<void>.delayed(Duration.zero);
      expect(conn.sent, isEmpty);

      conn.missing = false;
      expect(app.daemonTrustedConnectionMissing, isFalse);
      expect(
        app.sendDaemonFrame('daemon_act', {'id': 's1', 'choice': 'y'}),
        isTrue,
      );
      await Future<void>.delayed(Duration.zero);
      expect(conn.sent, ['daemon_act']);
    },
  );

  test('a failed private-pipe connection reports why daemon frames are unavailable', () {
    final conn = _Conn(missing: true)..ready = false;
    final app = createApp(connectionForTest: (_) => conn, connected: true);
    addTearDown(app.dispose);
    app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
      computerId: '0123456789abcdef0123456789abcdef',
      wsUri: Uri.parse('ws://127.0.0.1:1/ws'),
      protocolVersion: 1,
      terminalProtocolVersion: 3,
    );
    app.adoptPoolConnectionForTest('m', conn);
    expect(app.daemonTrustedConnectionMissing, isTrue);
  });
}
