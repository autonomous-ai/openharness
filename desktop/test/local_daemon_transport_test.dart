import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/local_daemon_transport.dart';
import 'package:harness/ws/ws_conn.dart';

const _computerId = '0123456789abcdef0123456789abcdef';

/// A stand-in daemon: `/api/status`, `/api/auth/me` and the local WebSocket,
/// on whatever [HttpServer] it is given, counting what reached it.
class _Daemon {
  _Daemon(this.server, this.name) {
    server.listen((request) async {
      hits.add(request.uri.path);
      if (WebSocketTransformer.isUpgradeRequest(request)) {
        final ws = await WebSocketTransformer.upgrade(request);
        ws.listen((data) {
          final frame = jsonDecode(data as String) as Map<String, dynamic>;
          if (frame['type'] == 'machine_select') {
            selects++;
            ws.add(jsonEncode({'type': 'connected', 'payload': frame['payload']}));
          }
        });
        return;
      }
      request.response.headers.contentType = ContentType.json;
      if (request.uri.path == '/api/status') {
        request.response.write(
          jsonEncode({
            'computerId': _computerId,
            'localWs': {
              'path': '/api/local-ws',
              'protocolVersion': 1,
              'terminalProtocolVersion': 3,
              'e2ee': false,
            },
          }),
        );
      } else {
        request.response.write(
          jsonEncode({
            'success': true,
            'data': {'via': name},
          }),
        );
      }
      await request.response.close();
    });
  }

  final HttpServer server;
  final String name;
  final List<String> hits = [];
  int selects = 0;

  static Future<_Daemon> tcp() async =>
      _Daemon(await HttpServer.bind(InternetAddress.loopbackIPv4, 0), 'tcp');

  static Future<_Daemon> unix(String path) async => _Daemon(
    await HttpServer.bind(InternetAddress(path, type: InternetAddressType.unix), 0),
    'unix',
  );

  Future<void> close() => server.close(force: true);
}

void main() {
  late Directory scratch;
  late String socketPath;
  late File identityFile;
  final daemons = <_Daemon>[];

  setUp(() async {
    // Socket paths are capped near 104 bytes; the default temp dir is longer.
    scratch = await Directory('/tmp').createTemp('hsock-');
    socketPath = '${scratch.path}/daemon.sock';
    identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(_computerId);
  });

  tearDown(() async {
    for (final daemon in daemons.reversed) {
      await daemon.close();
    }
    daemons.clear();
    if (await scratch.exists()) await scratch.delete(recursive: true);
  });

  Future<_Daemon> start(Future<_Daemon> daemon) async {
    final started = await daemon;
    daemons.add(started);
    return started;
  }

  AppConfig configFor(_Daemon tcp) => AppConfig(
    apiBaseUrl: 'http://unused.invalid',
    localCliBaseUrl: 'http://127.0.0.1:${tcp.server.port}',
  );

  group('defaultDaemonSocketPath', () {
    test('is the socket for the daemon\'s port in the CLI data directory', () {
      expect(
        defaultDaemonSocketPath(18473, environment: {'HOME': '/Users/me'}, isWindows: false),
        '/Users/me/.harness/cli/data/daemon-18473.sock',
      );
      // Another port, another daemon, another socket.
      expect(
        defaultDaemonSocketPath(
          18474,
          environment: {'HOME': '/Users/me', 'ADAPTER_DATA_DIR': '/srv/h'},
          isWindows: false,
        ),
        '/srv/h/daemon-18474.sock',
      );
      expect(defaultDaemonSocketPath(18473, environment: {'HOME': '/Users/me'}, isWindows: true), isNull);
      expect(
        defaultDaemonSocketPath(18473, environment: {'HOME': '/${'x' * 100}'}, isWindows: false),
        isNull,
      );
    });

    test('is never looked for under flutter test', () {
      expect(
        LocalDaemonTransport.detect(Uri.parse('http://127.0.0.1:18473')).candidate,
        isNull,
      );
    });
  });

  group('discovery', () {
    test('asks the socket first and keeps the port untouched', () async {
      final tcp = await start(_Daemon.tcp());
      await start(_Daemon.unix(socketPath));
      final transport = LocalDaemonTransport(candidate: socketPath);
      final endpoint = await LocalCliDiscovery(
        config: configFor(tcp),
        identity: LocalMachineIdentity(computerIdFile: identityFile),
        transport: transport,
      ).discover();

      expect(endpoint?.socketPath, socketPath);
      expect(transport.socketPath, socketPath);
      // The WebSocket keeps its loopback name, so the pool's key is unchanged.
      expect(endpoint?.wsUri.toString(), 'ws://127.0.0.1:${tcp.server.port}/api/local-ws');
      expect(tcp.hits, isEmpty);
    });

    test('falls back to the port when there is no socket', () async {
      final tcp = await start(_Daemon.tcp());
      final transport = LocalDaemonTransport(candidate: socketPath)..useSocket();
      final endpoint = await LocalCliDiscovery(
        config: configFor(tcp),
        identity: LocalMachineIdentity(computerIdFile: identityFile),
        transport: transport,
      ).discover();

      expect(endpoint, isNotNull);
      expect(endpoint!.socketPath, isNull);
      expect(transport.socketPath, isNull);
      expect(tcp.hits, ['/api/status']);
    });
  });

  group('REST', () {
    test('goes over the socket, and back to the port once it is gone', () async {
      final tcp = await start(_Daemon.tcp());
      final unix = await start(_Daemon.unix(socketPath));
      final transport = LocalDaemonTransport(candidate: socketPath)..useSocket();
      final api = ApiClient(
        config: configFor(tcp),
        session: AuthSession(),
        localTransport: transport,
      );

      expect(await api.me(), {'via': 'unix'});
      expect(unix.hits, ['/api/auth/me']);

      await unix.close();
      daemons.remove(unix);
      // Closing the server removes its socket file; make sure nothing is left to dial.
      if (File(socketPath).existsSync()) File(socketPath).deleteSync();
      expect(await api.me(), {'via': 'tcp'});
      expect(transport.socketPath, isNull);
    });

    test('never sends a request for another address down the socket', () async {
      final tcp = await start(_Daemon.tcp());
      final other = await start(_Daemon.tcp());
      final unix = await start(_Daemon.unix(socketPath));
      final transport = LocalDaemonTransport(candidate: socketPath)..useSocket();
      final dio = Dio()
        ..httpClientAdapter = LocalDaemonHttpAdapter(
          transport,
          daemonBase: Uri.parse('http://127.0.0.1:${tcp.server.port}'),
        );

      final response = await dio.get<Map<String, dynamic>>(
        'http://127.0.0.1:${other.server.port}/api/elsewhere',
      );
      expect(response.data?['data'], {'via': 'tcp'});
      expect(other.hits, ['/api/elsewhere']);
      expect(unix.hits, isEmpty);
    });
  });

  group('local WebSocket', () {
    WsConn connFor(_Daemon tcp, LocalDaemonTransport transport) => WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse('ws://127.0.0.1:${tcp.server.port}/api/local-ws'),
      localTransport: transport,
    );

    Future<void> until(bool Function() done) async {
      for (var i = 0; i < 100 && !done(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }

    test('dials the socket when discovery chose it', () async {
      final tcp = await start(_Daemon.tcp());
      final unix = await start(_Daemon.unix(socketPath));
      final conn = connFor(tcp, LocalDaemonTransport(candidate: socketPath)..useSocket());
      addTearDown(conn.close);
      await conn.connect();
      await until(() => unix.selects > 0);

      expect(unix.selects, 1);
      expect(tcp.selects, 0);
      expect(unix.hits, ['/api/local-ws']);
    });

    test('goes back to the socket once it is there again', () async {
      // A dial during a daemon restart fails and drops the transport to the
      // port; the next connect must still find the socket the new daemon made.
      final tcp = await start(_Daemon.tcp());
      final unix = await start(_Daemon.unix(socketPath));
      final transport = LocalDaemonTransport(candidate: socketPath)..useTcp();
      final conn = connFor(tcp, transport);
      addTearDown(conn.close);
      await conn.connect();
      await until(() => unix.selects > 0);

      expect(unix.selects, 1);
      expect(tcp.selects, 0);
    });

    test('falls back to the port when the socket is not there', () async {
      final tcp = await start(_Daemon.tcp());
      final transport = LocalDaemonTransport(candidate: socketPath)..useSocket();
      final conn = connFor(tcp, transport);
      addTearDown(conn.close);
      await conn.connect();
      await until(() => tcp.selects > 0);

      expect(tcp.selects, 1);
      expect(transport.socketPath, isNull);
    });
  });
}
