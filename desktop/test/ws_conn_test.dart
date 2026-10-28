import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:harness/core/models.dart' show Agent, ConnectionStatus;
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/ws/ws_pool.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/log_file.dart';
import 'package:harness/logging/log_stream.dart';
import 'package:harness/logging/log_stream_sinks.dart';
import 'package:flutter_test/flutter_test.dart';

import 'swarm_state_test.dart' show createApp;

class FakeHub {
  final HttpServer server;
  final bool rejectOldToken;
  final int? closeCodeOnSelect;

  /// The reason [closeCodeOnSelect] closes with: what the daemon's relay says, as it says it.
  String closeReasonOnSelect = 'rejected';

  /// Answers every select with this `machine_select_error` code instead, as the backend does.
  String? selectErrorOnSelect;
  final List<Map<String, dynamic>> frames = [];
  final List<String> protocols = [];
  final List<String?> environments = [];
  final List<String?> declaredClients = [];
  final Map<String, int> machineSelected = {};
  final List<WebSocket> clients = [];
  Map<String, dynamic> closeResponse = {'activity': 'idle'};

  FakeHub._(this.server, this.rejectOldToken, this.closeCodeOnSelect);
  int get port => server.port;

  static Future<FakeHub> start({
    bool rejectOldToken = false,
    int? closeCodeOnSelect,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final hub = FakeHub._(server, rejectOldToken, closeCodeOnSelect);
    server.listen((request) async {
      if (!WebSocketTransformer.isUpgradeRequest(request)) {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      final protocol = request.headers.value('sec-websocket-protocol') ?? '';
      hub.protocols.add(protocol);
      hub.environments.add(request.uri.queryParameters['autonomousEnv']);
      hub.declaredClients.add(request.uri.queryParameters['client']);
      final ws = await WebSocketTransformer.upgrade(
        request,
        protocolSelector: (protocols) =>
            protocols.isNotEmpty ? protocols.first : null,
      );
      hub.clients.add(ws);
      ws.listen((data) {
        final frame = jsonDecode(data as String) as Map<String, dynamic>;
        hub.frames.add(frame);
        if (frame['type'] == 'machine_select') {
          final machineId = (frame['payload'] as Map)['machineId'] as String;
          if (hub.closeCodeOnSelect != null) {
            ws.close(hub.closeCodeOnSelect!, hub.closeReasonOnSelect);
            return;
          }
          if (hub.selectErrorOnSelect != null) {
            ws.add(
              jsonEncode({
                'type': 'machine_select_error',
                'payload': {
                  'machineId': machineId,
                  'error': hub.selectErrorOnSelect,
                },
              }),
            );
            return;
          }
          if (hub.rejectOldToken && protocol == 'tok-old') {
            ws.close(4401, 'auth expired');
            return;
          }
          hub.machineSelected[machineId] =
              (hub.machineSelected[machineId] ?? 0) + 1;
          ws.add(
            jsonEncode({
              'type': 'connected',
              'payload': {'machineId': machineId},
            }),
          );
        } else if (frame['type'] == 'agent_create') {
          // A REFUSAL — the shape every CLI-side "no" arrives in: a `<type>_result` frame carrying
          // an error code, never a returned map with an `error` key. See WsRequestFailure.
          ws.add(
            jsonEncode({
              'type': 'agent_create_result',
              'payload': {
                'requestId': (frame['payload'] as Map)['requestId'],
                'error': 'UNSUPPORTED_ON_REMOTE',
                'detail': 'this machine cannot create agents',
              },
            }),
          );
        } else if (frame['type'] == 'agent_messages') {
          // How a daemon answers `shares` and the rest with Agent Messages
          // off, or, from an older CLI, for an action it does not know.
          final request = frame['payload'] as Map;
          ws.add(
            jsonEncode({
              'type': 'agent_messages_result',
              'payload': {
                'requestId': request['requestId'],
                'error': request['refuseWith'] ?? 'MESSAGES_OFF',
                'detail': 'refused by the fixture',
              },
            }),
          );
        } else if (frame['type'] == 'agent_close') {
          ws.add(
            jsonEncode({
              'type': 'agent_close_result',
              'payload': {
                'requestId': (frame['payload'] as Map)['requestId'],
                ...hub.closeResponse,
              },
            }),
          );
        } else if (frame['type'] == 'agents_list') {
          ws.add(
            jsonEncode({
              'type': 'agents_list_result',
              'payload': {
                'requestId': (frame['payload'] as Map)['requestId'],
                'agents': [
                  {'id': 'a1', 'name': 'Agent A', 'status': 'active'},
                ],
              },
            }),
          );
        }
      });
    });
    return hub;
  }

  Future<void> close() => server.close(force: true);
}

void main() {
  late FakeHub hub;
  WsConn? conn;

  tearDown(() async {
    await conn?.close();
    await hub.close();
  });

  test(
    'buffered diagnostics preserve live delivery, RPC completion and errors',
    () async {
      final dir = Directory.systemTemp.createTempSync('harness-ws-log-e2e-');
      final file = DailyLogFile(
        dir,
        'app',
        bufferInterval: const Duration(minutes: 1),
      );
      final previousLog = appLog;
      final stream = LogStream();
      appLog = FanoutAppLog([
        FileAppLog(file, bufferDebug: true),
        StreamAppLog(stream),
      ]);
      addTearDown(() {
        file.flush();
        appLog = previousLog;
        dir.deleteSync(recursive: true);
      });
      hub = await FakeHub.start();
      final received = <int>[];
      final delivered = Completer<void>();
      final ready = Completer<void>();
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'test',
        machineId: 'fixture',
        accessTokenProvider: (_, _) async => 'fixture-token',
        onAuthFailure: (_) {},
        onStatus: (status) {
          if (status == ConnectionStatus.connected && !ready.isCompleted) {
            ready.complete();
          }
        },
        onEvent: (frame) {
          if (frame['type'] == 'agent_activity') {
            received.add((frame['payload'] as Map)['index'] as int);
            if (received.length == 40) delivered.complete();
          }
        },
      );
      await conn!.connect();
      await ready.future.timeout(const Duration(seconds: 5));
      for (var i = 0; i < 40; i++) {
        hub.clients.single.add(
          jsonEncode({
            'type': 'agent_activity',
            'payload': {'index': i},
          }),
        );
      }
      await delivered.future.timeout(const Duration(seconds: 5));
      expect(received, List.generate(40, (i) => i));
      expect(
        stream.entries.where((e) => e.message.startsWith('↓ agent_activity')),
        hasLength(40),
      );
      expect(file.currentFile.existsSync(), isFalse);
      final inventory = await conn!.request('agents_list');
      expect((inventory['agents'] as List).single['id'], 'a1');
      expect(file.currentFile.existsSync(), isFalse);
      await expectLater(
        conn!.request('agent_create'),
        throwsA(isA<WsRequestFailure>()),
      );
      final text = file.currentFile.readAsStringSync();
      expect('↓ agent_activity'.allMatches(text), hasLength(40));
      expect(text, contains('← agents_list'));
      expect(text, contains('← agent_create failed'));
      expect(text, isNot(contains('fixture-token')));
    },
  );

  // `shares` is asked every 60 s, and with Agent Messages off (the account
  // default) every answer is MESSAGES_OFF: at WARN that was an immediate,
  // fsync'd app-log write each minute. Other refusals still warn.
  test('expected refusals are logged at DEBUG, others still at WARN', () async {
    final previousLog = appLog;
    final stream = LogStream();
    appLog = StreamAppLog(stream);
    addTearDown(() => appLog = previousLog);
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'test',
      machineId: 'fixture',
      accessTokenProvider: (_, _) async => 'fixture-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    await conn!.connect();
    for (final code in ['MESSAGES_OFF', 'UNKNOWN_ACTION']) {
      await expectLater(
        conn!.request(
          'agent_messages',
          payload: {'action': 'shares', 'refuseWith': code},
        ),
        throwsA(isA<WsRequestFailure>()),
      );
    }
    await expectLater(
      conn!.request('agent_create'),
      throwsA(isA<WsRequestFailure>()),
    );
    // The logging listener runs after the caller's own error handler.
    await Future<void>.delayed(Duration.zero);
    final failures = {
      for (final e in stream.entries)
        if (e.message.endsWith('failed')) '${e.message} ${e.error}': e.level,
    };
    expect(failures, {
      '← agent_messages failed agent_messages_result: MESSAGES_OFF — '
              'refused by the fixture':
          AppLogLevel.debug,
      '← agent_messages failed agent_messages_result: UNKNOWN_ACTION — '
              'refused by the fixture':
          AppLogLevel.debug,
      '← agent_create failed agent_create_result: UNSUPPORTED_ON_REMOTE — '
              'this machine cannot create agents':
          AppLogLevel.warn,
    });
  });

  test(
    'uses SSO subprotocol, environment, readiness, and machine_select',
    () async {
      hub = await FakeHub.start();
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => 'access-token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      await conn!.connect();
      final result = await conn!.request('agents_list');
      expect(hub.protocols, ['access-token']);
      expect(hub.environments, ['prod']);
      // A native build is not the web: no presence surface declared.
      expect(hub.declaredClients, [null]);
      expect(hub.machineSelected['m1'], 1);
      expect((result['agents'] as List).first['id'], 'a1');
    },
  );

  // The regression this guards: `AppNotifier.createAgent` used to map the CLI's refusal codes to
  // sentences in a branch reading `result['error']` — on a reply that had already thrown, so the
  // branch could never run and the user got the wire code instead of the sentence. The code has to
  // survive the throw for that call site to have anything to map.
  test('a refusal reply throws WsRequestFailure carrying the code', () async {
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    await conn!.connect();
    await expectLater(
      conn!.request('agent_create', payload: {'engine': 'codex'}),
      throwsA(
        isA<WsRequestFailure>()
            .having((f) => f.code, 'code', 'UNSUPPORTED_ON_REMOTE')
            .having(
              (f) => f.detail,
              'detail',
              'this machine cannot create agents',
            )
            .having(
              (f) => f.responseType,
              'responseType',
              'agent_create_result',
            ),
      ),
    );
  });

  test(
    'local transport sends no credential and skips SSO environment',
    () async {
      hub = await FakeHub.start();
      var tokenProviderCalls = 0;
      conn = WsConn(
        wsBaseUrl: 'wss://unused.example',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async {
          tokenProviderCalls++;
          return 'sso-token';
        },
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        allowLocalTcpFixture: true,
        localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
      );
      await conn!.connect();
      final result = await conn!.request('agents_list');
      expect(tokenProviderCalls, 0);
      expect(hub.protocols, ['']);
      expect(hub.environments.single, isNull);
      final select = hub.frames.firstWhere(
        (frame) => frame['type'] == 'machine_select',
      );
      expect((select['payload'] as Map)['localProtocolVersion'], 1);
      expect((result['agents'] as List).first['id'], 'a1');
    },
  );

  for (final failure in [
    {'error': 'SESSION_NOT_IDLE', 'activity': 'working'},
    {'error': 'HISTORY_NOT_SAVED', 'detail': 'Not enough free disk space.'},
  ]) {
    test('close preserves ${failure['error']} across the real WebSocket', () async {
      hub = await FakeHub.start();
      hub.closeResponse = failure;
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        allowLocalTcpFixture: true,
        localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
      );
      final app = createApp(connected: true, connectionForTest: (_) => conn!);
      addTearDown(app.dispose);
      final agent = Agent(
        id: 'a0',
        engine: 'codex',
        name: 'Work',
        sessionId: 'conversation-a0',
        createdAt: DateTime.utc(2026, 10, 1),
        closeSupported: true,
        terminalAvailable: true,
      );
      app.stateOf('m')!.agents = [agent];
      await conn!.connect();
      final result = await app.prepareSessionClose('m', agent)('idle');
      for (final entry in failure.entries) {
        expect(result[entry.key], entry.value);
      }
      expect(app.stateOf('m')!.agents.single.isStopped, isFalse);
      expect(hub.frames.where((f) => f['type'] == 'agent_close'), hasLength(1));
      expect(hub.frames.where((f) => f['type'] == 'agents_list'), isEmpty);
    });
  }

  test('forceReconnect() sends forceReconnect:true on the next machine_select, only for local transport', () async {
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'sso-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
      transportKind: WsTransportKind.localPlaintext,
      allowLocalTcpFixture: true,
      localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    final selects = hub.frames
        .where((frame) => frame['type'] == 'machine_select')
        .toList();
    expect(selects, hasLength(1));
    expect(
      (selects.first['payload'] as Map).containsKey('forceReconnect'),
      isFalse,
    );

    await conn!.forceReconnect();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    final selectsAfter = hub.frames
        .where((frame) => frame['type'] == 'machine_select')
        .toList();
    expect(selectsAfter, hasLength(2));
    expect((selectsAfter[1]['payload'] as Map)['forceReconnect'], isTrue);
    expect(conn!.isReady, isTrue);
  });

  test('blocked encrypted RPC fails immediately and is never sent', () async {
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    conn!.onOutgoing = (type, payload) async {
      if (type == 'agents_list') throw StateError('E2EE is not ready');
      return payload;
    };
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 100));

    await expectLater(
      conn!.request('agents_list', timeout: const Duration(seconds: 5)),
      throwsA(isA<StateError>()),
    );
    expect(
      hub.frames.where((frame) => frame['type'] == 'agents_list'),
      isEmpty,
    );
  });

  test('4403 stops reconnecting and reports an environment mismatch', () async {
    hub = await FakeHub.start(closeCodeOnSelect: 4403);
    final failures = <String>[];
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: failures.add,
      onEvent: (_) {},
      onStatus: (_) {},
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(hub.protocols, hasLength(1));
    expect(failures.single, contains('environment'));
  });

  // AppNotifier's onStatus handler reads machine.needsLink to decide whether a
  // disconnect should be treated as the node going offline — it only sees the
  // right value if onLocalFailure (which sets needsLink) has already run.
  test('4404 reports onLocalFailure before onStatus(disconnected)', () async {
    hub = await FakeHub.start(closeCodeOnSelect: 4404);
    final calls = <String>[];
    conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'sso-token',
      onAuthFailure: (_) {},
      onLocalFailure: (code, reason) => calls.add('onLocalFailure'),
      onEvent: (_) {},
      onStatus: (status) => calls.add('onStatus:$status'),
      transportKind: WsTransportKind.localPlaintext,
      allowLocalTcpFixture: true,
      localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(
      calls,
      containsAllInOrder([
        'onLocalFailure',
        'onStatus:ConnectionStatus.disconnected',
      ]),
    );
    expect(conn!.isClosed, isTrue);
  });

  // Prod, 2026-10-28: a laptop removed from the account in September was still selected every few
  // seconds. Through this computer's daemon the refusal arrives as the relay's close, with the
  // backend's code for its reason; straight from the backend (the web viewer), as the frame.
  for (final (path, local) in [('daemon relay', true), ('backend', false)]) {
    test(
      'a machine refused as not on the account ($path) is not dialled again',
      () async {
        hub = await FakeHub.start(closeCodeOnSelect: local ? 1011 : null);
        hub.closeReasonOnSelect = 'NOT_YOUR_MACHINE';
        if (!local) hub.selectErrorOnSelect = 'NOT_YOUR_MACHINE';
        final failures = <String>[];
        final statuses = <ConnectionStatus>[];
        conn = WsConn(
          wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
          autonomousEnv: 'prod',
          machineId: 'm1',
          accessTokenProvider: (_, _) async => 'sso-token',
          onAuthFailure: (_) {},
          onLocalFailure: (code, reason) => failures.add(reason),
          onEvent: (_) {},
          onStatus: statuses.add,
          transportKind: local
              ? WsTransportKind.localPlaintext
              : WsTransportKind.cloudE2ee,
          allowLocalTcpFixture: true,
          localWsUri: local
              ? Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws')
              : null,
        );
        await conn!.connect();
        // Past the first two steps of the backoff (0.5–1 s, then 1–2 s).
        await Future<void>.delayed(const Duration(milliseconds: 3200));
        expect(hub.protocols, hasLength(1));
        expect(conn!.isClosed, isTrue);
        expect(statuses.last, ConnectionStatus.disconnected);
        if (local) expect(failures, ['NOT_YOUR_MACHINE']);
      },
    );
  }

  // Prod, 2026-10-28: relays living 0.4 s made 2,304 of 2,308 backend socket opens in 15 minutes.
  // A relayed machine that is off was redialled on the 15–30 s backoff for as long as the app ran,
  // each dial refused at once: about 2.7 a minute for every machine that was off. It now waits for
  // word that the machine is back, and rechecks on its own only every 1, 2, 4, 8, then 15 minutes.
  test('a relayed machine that is off waits to be woken instead of redialling', () async {
    // The reason is what counts: a current daemon closes with 1013, an older one with 1011 (a
    // dart:io server cannot send 1013, a reserved code).
    hub = await FakeHub.start(closeCodeOnSelect: 1011);
    hub.closeReasonOnSelect = 'MACHINE_OFFLINE';
    conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'sso-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
      transportKind: WsTransportKind.localPlaintext,
      allowLocalTcpFixture: true,
      localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 3200));
    expect(hub.protocols, hasLength(1));
    expect(conn!.isParked, isTrue);
    expect(conn!.isClosed, isFalse);

    conn!.wake('machine online');
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(hub.protocols, hasLength(2));
  });

  test('a parked connection rechecks after 1, 2, 4, 8 and then every 15 minutes', () {
    expect(
      [for (var n = 0; n < 7; n++) WsConn.parkedRecheckAfter(n).inMinutes],
      [1, 2, 4, 8, 15, 15, 15],
    );
  });

  test(
    'a fixed reconnect delay retries at that pace instead of backing off',
    () async {
      // Reject the handshake immediately: a closed TCP port's refusal latency
      // varies by OS. Backoff puts the second attempt 2s out, whereas the flat
      // delay retries each tick after a failed connection.
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      hub = FakeHub._(server, false, null);
      server.listen((request) async {
        request.response.statusCode = HttpStatus.serviceUnavailable;
        await request.response.close();
      });
      var reconnecting = 0;
      conn = WsConn(
        wsBaseUrl: 'wss://unused.example',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (status) {
          if (status == ConnectionStatus.reconnecting) reconnecting++;
        },
        transportKind: WsTransportKind.localPlaintext,
        allowLocalTcpFixture: true,
        localWsUri: Uri.parse('ws://127.0.0.1:${server.port}/api/local-ws'),
        fixedReconnectDelay: const Duration(milliseconds: 100),
      );
      await conn!.connect();
      await Future<void>.delayed(const Duration(milliseconds: 650));
      expect(
        reconnecting,
        greaterThanOrEqualTo(4),
        reason: 'backoff would allow one',
      );
    },
  );

  test('4403 on a local socket is reported, and the retry goes on', () async {
    // "machine mismatch": the daemon serves another id than the one selected. The app is told so it
    // can find out which; the socket keeps retrying (the answer may be a re-key of this very row)
    // instead of the silent 30s loop this used to be.
    hub = await FakeHub.start(closeCodeOnSelect: 4403);
    final failures = <String>[];
    final statuses = <ConnectionStatus>[];
    conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'sso-token',
      onAuthFailure: (_) {},
      onLocalFailure: (code, reason) => failures.add('$code:$reason'),
      onEvent: (_) {},
      onStatus: statuses.add,
      transportKind: WsTransportKind.localPlaintext,
        allowLocalTcpFixture: true,
      localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(failures, hasLength(1));
    expect(failures.single, startsWith('4403:'));
    expect(statuses, contains(ConnectionStatus.reconnecting));
    expect(conn!.isClosed, isFalse);
  });

  test(
    '4401 refreshes once and reconnects with the new access token',
    () async {
      hub = await FakeHub.start(rejectOldToken: true);
      var token = 'tok-old';
      var refreshes = 0;
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (force, _) async {
          if (force) {
            refreshes++;
            token = 'tok-new';
          }
          return token;
        },
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      await conn!.connect();
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(refreshes, 1);
      expect(hub.protocols, containsAllInOrder(['tok-old', 'tok-new']));
      expect(hub.machineSelected['m1'], 1);
    },
  );

  test(
    'debug transport drop uses a client-valid code and reconnects',
    () async {
      hub = await FakeHub.start();
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => 'access-token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      await conn!.connect();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(conn!.isReady, isTrue);

      await conn!.debugDropTransport();
      await Future<void>.delayed(const Duration(milliseconds: 1300));

      expect(hub.machineSelected['m1'], 2);
      expect(conn!.isReady, isTrue);
    },
  );

  test(
    'WsPool keeps one SSO connection per machine and closes independently',
    () async {
      hub = await FakeHub.start();
      final pool = WsPool(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        accessTokenProvider: (_, _) async => 'access-token',
        onAuthFailure: (_) {},
        onEvent: (_, _) {},
        onStatus: (_, _) {},
      );
      final c1a = pool.connFor('m1');
      final c1b = pool.connFor('m1');
      final c2 = pool.connFor('m2');
      expect(identical(c1a, c1b), isTrue);
      expect(identical(c1a, c2), isFalse);
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(hub.machineSelected['m1'], 1);
      expect(hub.machineSelected['m2'], 1);
      await pool.closeMachine('m1');
      expect(pool.has('m1'), isFalse);
      expect(pool.has('m2'), isTrue);
      await pool.closeAll();
    },
  );

  test('WsPool reuses a local socket asked for with the same reconnect policy, and swaps it on a change', () async {
    // The pool reuses a socket only when its own key and the socket's `endpointKey` agree. A key
    // computed on one side and not the other churned EVERY socket on EVERY lookup — measured in
    // the running app as `agents_list … failed: Bad state: WS closed` in a loop.
    hub = await FakeHub.start();
    final pool = WsPool(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (_) {},
      onEvent: (_, _) {},
      onStatus: (_, _) {},
    );
    final uri = Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws');
    final flat = pool.connFor(
      'm1',
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: uri,
      fixedReconnectDelay: const Duration(seconds: 1),
    );
    final again = pool.connFor(
      'm1',
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: uri,
      fixedReconnectDelay: const Duration(seconds: 1),
    );
    expect(identical(flat, again), isTrue, reason: 'same policy, same socket');
    final backoff = pool.connFor(
      'm1',
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: uri,
    );
    expect(
      identical(flat, backoff),
      isFalse,
      reason: 'a new policy is a new socket',
    );
    expect(flat.isClosed, isTrue);
    await pool.closeAll();
  });
}
