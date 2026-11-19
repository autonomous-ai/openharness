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
  final List<String?> declaredVersions = [];
  final Map<String, int> machineSelected = {};
  final List<WebSocket> clients = [];
  Map<String, dynamic> closeResponse = {'activity': 'idle'};

  /// Canned success replies by request type, answered before the refusals below.
  final Map<String, Map<String, dynamic>> replies = {};

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
      hub.declaredVersions.add(request.uri.queryParameters['v']);
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
        } else if (hub.replies[frame['type']] case final reply?) {
          ws.add(
            jsonEncode({
              'type': '${frame['type']}_result',
              'payload': {
                ...reply,
                'requestId': (frame['payload'] as Map)['requestId'],
              },
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
                'detail': request['refuseDetail'] ?? 'refused by the fixture',
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
      '← agent_messages failed agent_messages_result: MESSAGES_OFF':
          AppLogLevel.debug,
      '← agent_messages failed agent_messages_result: UNKNOWN_ACTION':
          AppLogLevel.debug,
      '← agent_create failed agent_create_result: UNSUPPORTED_ON_REMOTE':
          AppLogLevel.warn,
    });
  });

  // The daemon's detail can quote a prompt or a name: the UI shows it, the
  // logs keep only the frame and the code.
  test('a refusal is logged by its code, in the file and the Debug pane', () async {
    final dir = Directory.systemTemp.createTempSync('harness-ws-refusal-');
    final file = DailyLogFile(dir, 'app');
    final previousLog = appLog;
    final stream = LogStream();
    appLog = FanoutAppLog([FileAppLog(file), StreamAppLog(stream)]);
    addTearDown(() {
      file.flush();
      appLog = previousLog;
      dir.deleteSync(recursive: true);
    });
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
    Future<WsRequestFailure> refused(Map<String, dynamic> payload) async {
      try {
        await conn!.request('agent_messages', payload: payload);
      } on WsRequestFailure catch (failure) {
        return failure;
      }
      fail('agent_messages was not refused');
    }

    final shown = await refused({
      'action': 'shares',
      'refuseWith': 'NOT_ALLOWED',
      'refuseDetail': 'tab zebra-orchard is shared',
    });
    expect(shown.toString(), contains('zebra-orchard'));
    await refused({
      'action': 'shares',
      'refuseWith': 'no such zebra-orchard',
    });
    // The logging listener runs after the caller's own error handler.
    await pumpEventQueue();
    file.flush();

    final failures = [
      for (final e in stream.entries.reversed)
        if (e.message == '← agent_messages failed') e.error,
    ];
    expect(failures, [
      'agent_messages_result: NOT_ALLOWED',
      'agent_messages_result: <21 chars>',
    ]);
    for (final e in stream.entries) {
      expect(e.message, isNot(contains('zebra-orchard')));
      expect(e.error ?? '', isNot(contains('zebra-orchard')));
    }
    final text = file.currentFile.readAsStringSync();
    expect(text, contains('err=agent_messages_result: NOT_ALLOWED'));
    expect(text, isNot(contains('zebra-orchard')));
  });

  // Browser settings carry a proxy's host, its login and its exit address.
  test('no agent_browser request or its failure is logged', () async {
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
    await expectLater(
      conn!.request(
        'agent_browser_settings_save',
        payload: {
          'agentId': 'a1',
          'settings': {
            'proxy': {'host': 'proxy.example', 'username': 'ken'},
          },
        },
        timeout: const Duration(milliseconds: 50),
      ),
      throwsA(isA<WsRequestTimeout>()),
    );
    await Future<void>.delayed(Duration.zero);
    expect(
      stream.entries.where((e) => e.message.contains('agent_browser')),
      isEmpty,
    );
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
      declaredAppVersion = '1.3.0';
      addTearDown(() => declaredAppVersion = null);
      await conn!.connect();
      final result = await conn!.request('agents_list');
      expect(hub.protocols, ['access-token']);
      expect(hub.environments, ['prod']);
      // A native build is not the web (no presence surface), but says what it is and which build (WebSocket
      // roadmap Phase 0).
      expect(hub.declaredClients, ['desktop']);
      expect(hub.declaredVersions, ['1.3.0']);
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

  // The browser reads its version from the host's release file at start-up; a socket dialled while that read is out
  // waits for it a moment, so the web build's first sockets carry it too (the e2e harness counts them per kind).
  test('a socket waits up to a second for the version read, then dials with it', () async {
    hub = await FakeHub.start();
    final read = Completer<void>();
    appVersionRead = read.future;
    addTearDown(() {
      appVersionRead = null;
      declaredAppVersion = null;
    });
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    unawaited(conn!.connect());
    await Future<void>.delayed(const Duration(milliseconds: 100));
    declaredAppVersion = '1.3.58';
    read.complete();
    await conn!.request('agents_list');
    expect(hub.declaredVersions, ['1.3.58']);
  });

  test('a version read that never ends holds a dial for a second at most', () async {
    hub = await FakeHub.start();
    appVersionRead = Completer<void>().future;
    addTearDown(() => appVersionRead = null);
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    final started = DateTime.now();
    await conn!.connect();
    await conn!.request('agents_list');
    expect(DateTime.now().difference(started), lessThan(const Duration(seconds: 2)));
    expect(hub.declaredVersions, [null]);
  });

  // Review of #2044: a read that never ends costs the first dial its second, not every dial after it.
  test('after a version read times out once, later dials do not wait', () async {
    hub = await FakeHub.start();
    appVersionRead = Completer<void>().future;
    addTearDown(() => appVersionRead = null);
    WsConn dialer() => WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    final first = dialer();
    addTearDown(first.close);
    await first.connect();
    conn = dialer();
    final started = DateTime.now();
    await conn!.connect();
    await conn!.request('agents_list');
    expect(DateTime.now().difference(started), lessThan(const Duration(milliseconds: 500)));
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

  // The first recheck is the relay's own retry-after (30 s): a machine back online that a wake reached while the relay
  // still answered from its refusal parks again, and must not wait a minute more (review of #2027).
  test('a parked connection rechecks after 30 s, then 1, 2, 4, 8 and every 15 minutes', () {
    expect(
      [for (var n = 0; n < 7; n++) WsConn.parkedRecheckAfter(n).inSeconds],
      [30, 60, 120, 240, 480, 900, 900],
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
      var dials = 0;
      conn = WsConn(
        wsBaseUrl: 'wss://unused.example',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (status) {
          if (status == ConnectionStatus.reconnecting ||
              status == ConnectionStatus.connecting) {
            dials++;
          }
        },
        transportKind: WsTransportKind.localPlaintext,
        allowLocalTcpFixture: true,
        localWsUri: Uri.parse('ws://127.0.0.1:${server.port}/api/local-ws'),
        fixedReconnectDelay: const Duration(milliseconds: 100),
      );
      await conn!.connect();
      await Future<void>.delayed(const Duration(milliseconds: 650));
      expect(
        dials,
        greaterThanOrEqualTo(4),
        reason: 'backoff would allow one',
      );
    },
  );

  test(
    'a forced relay redial of a link that never came up keeps the backoff',
    () async {
      // An offline relayed machine: the daemon closes each select (1013 there; any code but the
      // special ones takes the same reconnect path, and Dart's server allows only 1000). A timed-out request or a
      // stalled pane forces a redial at most every 30 s, and that used to zero the backoff — so the
      // retries ran 1, 2, 4, 8, 16 s and started over, ~100 backend dials per machine per 10 min
      // (prod, 2026-10-27, #314).
      hub = await FakeHub.start(closeCodeOnSelect: 1000);
      int selects() =>
          hub.frames.where((f) => f['type'] == 'machine_select').length;
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
      // The first select, then the retry one second later; the next is due two seconds after it.
      while (selects() < 2) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await conn!.forceReconnect();
      await Future<void>.delayed(const Duration(milliseconds: 1000));
      expect(selects(), 2, reason: 'a forced redial must not jump the backoff');
    },
    timeout: const Timeout(Duration(seconds: 20)),
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
    // Dialled again, on its first connect's quick tries (test/first_connect_test.dart).
    expect(
      statuses.where((status) => status == ConnectionStatus.connecting),
      hasLength(greaterThan(1)),
    );
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

  // A frame line is written to ~/.harness/logs in release builds and kept for
  // weeks: it may show what happened, never what anybody typed, said or named.
  group('frame lines hold no content', () {
    const sentinel = 'zebra-orchard';
    late LogStream stream;
    late Map<String, Completer<void>> seen;

    Future<void> connect() async {
      final previousLog = appLog;
      stream = LogStream();
      appLog = StreamAppLog(stream);
      addTearDown(() => appLog = previousLog);
      seen = {};
      hub = await FakeHub.start();
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
          final arrived = seen[frame['type']];
          if (arrived != null && !arrived.isCompleted) arrived.complete();
        },
      );
      await conn!.connect();
      await ready.future.timeout(const Duration(seconds: 5));
    }

    void expectNoContent() {
      for (final entry in stream.entries) {
        expect(entry.message, isNot(contains(sentinel)));
        expect(entry.error ?? '', isNot(contains(sentinel)));
      }
    }

    Iterable<String> linesStarting(String prefix) => stream.entries
        .map((e) => e.message)
        .where((message) => message.startsWith(prefix));

    final agent = {
      'id': 'a1',
      'name': 'the zebra-orchard agent',
      'engine': 'claude',
      'status': 'running',
      'cwd': '/Users/dev/zebra-orchard',
      'sessionId': 's1',
      'terminalAvailable': true,
    };

    // The shapes the AppNotifier senders send and the daemon answers.
    final requests = <(String, Map<String, dynamic>, Map<String, dynamic>)>[
      (
        'agent_create',
        {
          'engine': 'claude',
          'cwd': '/Users/dev/zebra-orchard',
          'bypassPermission': true,
          'permissionMode': 'default',
          'prompt': 'fix the zebra-orchard login',
          'name': 'the zebra-orchard agent',
          'creationId': 'c1',
        },
        {'creationId': 'c1', 'agent': agent},
      ),
      (
        'agent_fork',
        {
          'creationId': 'c2',
          'agentId': 'a1',
          'name': 'the zebra-orchard fork',
          'prompt': 'try zebra-orchard again',
        },
        {'creationId': 'c2', 'agent': agent},
      ),
      (
        'agent_update',
        {'agentId': 'a1', 'name': 'the zebra-orchard agent'},
        {
          'agent': {
            'id': 'a1',
            'name': 'the zebra-orchard agent',
            'lastOpenedAt': 1763251200000,
          },
        },
      ),
      (
        'cloud_send',
        {'agentId': 'a1', 'text': 'ship the zebra-orchard fix'},
        {'ok': true},
      ),
      (
        'session_search',
        {'query': 'where is zebra-orchard', 'limit': 20, 'from': 0, 'to': 1},
        {
          'hits': [
            {'sessionId': 's1', 'snippet': 'the zebra-orchard bug'},
          ],
          'ready': true,
        },
      ),
      (
        'session_tail',
        {'sessionId': 's1', 'beforeTurn': 3, 'maxChars': 4000},
        {
          'rows': [
            {'text': 'about zebra-orchard'},
          ],
          'hasMore': true,
          'total': 9,
          'lastAsk': {
            'turn': 7,
            'at': 1,
            'ask': 'why is zebra-orchard slow',
            'answer': 'zebra-orchard waits on a lock',
            'tools': 'read zebra-orchard logs',
          },
          'external': {'open': true, 'openIn': 'terminal'},
        },
      ),
      (
        'agent_messages',
        {
          'action': 'share_tab',
          'tabId': 'desk_1',
          'name': 'the zebra-orchard tab',
        },
        {'sharedTabId': 'st1'},
      ),
      (
        'git_pull_request',
        {
          'agentId': 'a1',
          'context': {
            'branch': 'fix/zebra-orchard login',
            'remote': 'git@github.com:acme/zebra-orchard.git',
          },
        },
        {
          'status': 'found',
          'number': 12,
          'url': 'https://github.com/acme/zebra-orchard/pull/12',
          'state': 'Open',
          'title': 'Fix the zebra-orchard login',
          'headBranch': 'fix/zebra-orchard login',
          'baseBranch': 'main',
        },
      ),
    ];

    for (final (type, payload, reply) in requests) {
      test('$type shows its keys, not their content', () async {
        await connect();
        hub.replies[type] = reply;

        await conn!.request(type, payload: payload);
        // The logging listener runs after the caller's own.
        await pumpEventQueue();

        final sent = linesStarting('→ $type ');
        expect(sent, hasLength(1));
        for (final key in payload.keys) {
          expect(sent.single, contains('$key: '));
        }
        expect(linesStarting('← $type '), hasLength(1));
        expectNoContent();
      });
    }

    test('route_decide is never logged', () async {
      await connect();
      hub.replies['route_decide'] = {
        'decided': 'session',
        'id': 's1',
        'reason': 'it mentions zebra-orchard',
        'trace': 'picked zebra-orchard',
      };

      await conn!.request(
        'route_decide',
        payload: {
          'text': 'open the zebra-orchard session',
          'sessions': {
            's1': {'title': 'the zebra-orchard session'},
          },
        },
      );
      await pumpEventQueue();

      expect(
        stream.entries.where(
          (e) =>
              e.message.contains('route_decide') ||
              e.message.contains(sentinel),
        ),
        isEmpty,
      );
    });

    // The shapes `_handleEvent`, `SessionPreviewStore.ingest`, `DaemonBrain`
    // and the CLI's engine events (`cli/src/engines/kit/events.ts`) carry.
    final events = <(String, Map<String, dynamic>)>[
      (
        'voice_route_request',
        {'voiceId': 'v1', 'text': 'open zebra-orchard', 'cmd': 'route'},
      ),
      (
        'turn_started',
        {'agentId': 'a1', 'userMessage': 'fix the zebra-orchard login'},
      ),
      ('user_message', {'agentId': 'a1', 'content': 'and zebra-orchard too'}),
      ('text_delta', {'agentId': 'a1', 'content': 'Looking at zebra-orchard'}),
      (
        'thinking_delta',
        {
          'agentId': 'a1',
          'content': 'zebra-orchard is slow because',
          'thinkingId': 't1',
        },
      ),
      (
        'thinking_title',
        {'agentId': 'a1', 'thinkingId': 't1', 'title': 'Reading zebra-orchard'},
      ),
      (
        'tool_start',
        {
          'agentId': 'a1',
          'id': 'tu1',
          'tool': 'Bash',
          'input': {'command': 'grep -r zebra-orchard src'},
        },
      ),
      (
        'tool_end',
        {
          'agentId': 'a1',
          'id': 'tu1',
          'tool': 'Bash',
          'output': 'src/zebra-orchard.ts: 3 matches',
          'outputTail': 'end of zebra-orchard',
          'isError': false,
          'summary': 'found zebra-orchard',
        },
      ),
      ('done', {'agentId': 'a1', 'result': 'fixed the zebra-orchard login'}),
      (
        'turn_summary',
        {
          'agentId': 'a1',
          'recap': 'fixed zebra-orchard',
          'text': 'the zebra-orchard login works',
          'notification': {'id': 'n1', 'kind': 'done'},
        },
      ),
      (
        'agent_created',
        {
          'agent': {
            'id': 'a1',
            'name': 'the zebra-orchard agent',
            'engine': 'claude',
            'status': 'is zebra-orchard',
            'cwd': '/Users/dev/zebra-orchard',
            'terminal': {'runtimes': <Object>[]},
          },
        },
      ),
      (
        'agent_synced',
        {
          'agent': {
            'id': 'a1',
            'name': 'the zebra-orchard agent',
            'engine': 'claude',
            'cwd': '/Users/dev/zebra-orchard',
            'terminalAvailable': true,
          },
        },
      ),
      ('agent_renamed', {'agentId': 'a1', 'name': 'zebra-orchard'}),
      (
        'daemon_say',
        {
          'id': 'say1',
          'line': 'zebra-orchard is done',
          'reply': 'nice, zebra-orchard',
          'mood': 'say',
          'from': 'pair',
          'about': {'machineId': 'm1', 'agentId': 'a1'},
          'harness': {
            'name': 'the zebra-orchard agent',
            'machineId': 'm1',
            'agentId': 'a1',
          },
        },
      ),
      (
        'daemon_brief',
        {
          'line': 'two on zebra-orchard',
          'items': [
            {
              'id': 'b1',
              'kind': 'agent',
              'line': 'zebra-orchard waits',
              'name': 'the zebra-orchard agent',
            },
          ],
        },
      ),
      (
        'daemon_talk_result',
        {
          'requestId': 'tr1',
          'ok': false,
          'error': 'could not reach zebra-orchard',
          'detail': 'zebra-orchard is offline',
          'agentId': 'a1',
        },
      ),
    ];

    for (final (type, payload) in events) {
      test('$type shows its keys, not their content', () async {
        await connect();
        final arrived = seen[type] = Completer<void>();

        hub.clients.single.add(jsonEncode({'type': type, 'payload': payload}));
        await arrived.future.timeout(const Duration(seconds: 5));

        final received = linesStarting('↓ $type ');
        expect(received, hasLength(1));
        switch (type) {
          case 'agent_renamed':
            expect(
              received.single,
              '↓ agent_renamed {agentId: a1, name: <13 chars>}',
            );
          case 'daemon_talk_result':
            expect(received.single, contains('error: <29 chars>'));
          case 'agent_created':
            expect(received.single, contains('status: <16 chars>'));
        }
        expectNoContent();
      });
    }
  });
}
