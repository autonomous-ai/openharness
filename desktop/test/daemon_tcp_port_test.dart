import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/config.dart';
import 'package:harness/ws/daemon_pipe_record.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/local_daemon_transport.dart';

// Windows, a PC with two people on it: the other user's daemon took the configured port first, so this
// user's daemon bound another and recorded it in daemon-<configured port>.json (CLI lib/daemonRecord.ts).
// The app follows the record, as the CLI's own clients do (savedDaemonPort), and never takes the other
// daemon for its own.
const _ours = '0123456789abcdef0123456789abcdef';
const _theirs = 'fedcba9876543210fedcba9876543210';

/// A daemon for [computerId]: `/api/status`, and any other path says [name]
/// and the query it got. [hits] collects every path asked.
Future<HttpServer> _daemon(
  String computerId,
  String name, [
  List<String>? hits,
]) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    hits?.add(request.uri.path);
    request.response.headers.contentType = ContentType.json;
    request.response.write(
      jsonEncode(
        request.uri.path == '/api/status'
            ? {
                'computerId': computerId,
                'localWs': {
                  'path': '/api/local-ws',
                  'protocolVersion': 1,
                  'terminalProtocolVersion': 3,
                  'e2ee': false,
                },
              }
            : {'via': name, 'query': request.uri.query},
      ),
    );
    await request.response.close();
  });
  return server;
}

void main() {
  late Directory scratch;
  late File identity;

  setUp(() {
    scratch = Directory.systemTemp.createTempSync('daemon-tcp-port-');
    identity = File('${scratch.path}/computer-id')..writeAsStringSync(_ours);
  });
  tearDown(() => scratch.deleteSync(recursive: true));

  LocalCliDiscovery discovery(
    int configuredPort,
    LocalDaemonTransport transport,
  ) => LocalCliDiscovery(
    config: AppConfig(
      apiBaseUrl: 'https://harness-api.autonomous.ai',
      localCliBaseUrl: 'http://127.0.0.1:$configuredPort',
    ),
    identity: LocalMachineIdentity(computerIdFile: identity),
    transport: transport,
  );

  group('readDaemonTcpPort', () {
    void record(String text) =>
        File('${scratch.path}/daemon-18473.json').writeAsStringSync(text);

    test('is the port the daemon bound, from the record named for the configured one', () {
      record(
        jsonEncode({
          'port': 51234,
          'pipe': r'\\.\pipe\harness-' + _ours,
          'pid': 4242,
        }),
      );
      expect(readDaemonTcpPort(dataDir: scratch.path, port: 18473), 51234);
      expect(readDaemonTcpPort(dataDir: scratch.path, port: 18474), isNull);
    });

    test('is null with no record, or with a record that names no port', () {
      expect(readDaemonTcpPort(dataDir: scratch.path, port: 18473), isNull);
      for (final text in [
        '{"port":0}',
        '{"port":70000}',
        '{"port":"51234"}',
        '{}',
        '[]',
        'not json',
      ]) {
        record(text);
        expect(
          readDaemonTcpPort(dataDir: scratch.path, port: 18473),
          isNull,
          reason: text,
        );
      }
    });
  });

  test("discovery follows the recorded port past another user's daemon on the configured one, and so does REST", () async {
    final theirs = await _daemon(_theirs, 'theirs');
    final ours = await _daemon(_ours, 'ours');
    addTearDown(() => theirs.close(force: true));
    addTearDown(() => ours.close(force: true));
    final transport = LocalDaemonTransport(recordedPort: () => ours.port);

    final endpoint = await discovery(theirs.port, transport).discover();
    expect(endpoint?.computerId, _ours);
    expect(
      endpoint?.wsUri.toString(),
      'ws://127.0.0.1:${ours.port}/api/local-ws',
    );

    final daemonBase = Uri.parse('http://127.0.0.1:${theirs.port}');
    final dio = Dio(BaseOptions(baseUrl: daemonBase.toString()))
      ..httpClientAdapter = LocalDaemonHttpAdapter(
        transport,
        daemonBase: daemonBase,
      );
    addTearDown(() => dio.close(force: true));
    final answer = await dio.get<Map<String, dynamic>>(
      '/api/auth/me',
      queryParameters: {'a': '1'},
    );
    expect(answer.data, {'via': 'ours', 'query': 'a=1'});
  });

  test(
    'before the daemon has recorded a port, the configured one is not asked',
    () async {
      final hits = <String>[];
      final theirs = await _daemon(_theirs, 'theirs', hits);
      addTearDown(() => theirs.close(force: true));
      final probe = await discovery(
        theirs.port,
        LocalDaemonTransport(recordedPort: () => null),
      ).probe();
      expect(probe.state, LocalCliProbeState.down);
      expect(probe.reason, 'the daemon has not recorded its port yet');
      expect(hits, isEmpty);
    },
  );

  test(
    'off Windows there is no record to read: the configured port is the port',
    () {
      final base = Uri.parse('http://127.0.0.1:18473');
      final transport = LocalDaemonTransport();
      expect(transport.refreshTcpBase(base), base);
      expect(transport.tcpBase(base), base);
    },
  );
}
