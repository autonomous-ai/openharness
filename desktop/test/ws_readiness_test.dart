import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

class _Hub {
  _Hub(this.server) {
    server.listen((request) async {
      final ws = await WebSocketTransformer.upgrade(request);
      ws.listen((raw) {
        final frame = jsonDecode(raw as String) as Map<String, dynamic>;
        frames.add(frame);
        final received = requests.putIfAbsent(
          frame['type'] as String,
          Completer<Map<String, dynamic>>.new,
        );
        if (!received.isCompleted) received.complete(frame);
        if (frame['type'] == 'machine_select' && !selected.isCompleted) {
          selected.complete(ws);
        }
      });
    });
  }
  final HttpServer server;
  final selected = Completer<WebSocket>();
  final frames = <Map<String, dynamic>>[];
  final requests = <String, Completer<Map<String, dynamic>>>{};
  Uri get uri => Uri.parse('ws://127.0.0.1:${server.port}/api/local-ws');

  Future<void> ready([String machine = 'm']) async {
    (await selected.future).add(
      jsonEncode({
        'type': 'connected',
        'payload': {'machineId': machine},
      }),
    );
  }

  Future<Map<String, dynamic>> receive(String type) =>
      requests.putIfAbsent(type, Completer<Map<String, dynamic>>.new).future;

  Future<void> reply(String type, Map<String, dynamic> payload) async {
    final request = await receive(type);
    (await selected.future).add(
      jsonEncode({
        'type': '${type}_result',
        'payload': {
          ...payload,
          'requestId': (request['payload'] as Map)['requestId'],
        },
      }),
    );
  }
}

void main() {
  late _Hub hub;
  late WsConn connection;
  setUp(() async {
    hub = _Hub(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));
    connection = WsConn(
      wsBaseUrl: 'ws://unused.invalid',
      autonomousEnv: 'test',
      machineId: 'm',
      accessTokenProvider: (_, _) async => throw StateError('No credentials'),
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
      transportKind: WsTransportKind.localPlaintext,
      allowLocalTcpFixture: true,
      localWsUri: hub.uri,
    );
  });
  tearDown(() async {
    await connection.close();
    await hub.server.close(force: true);
  });

  test(
    'readiness waits for this machine and releases concurrent callers',
    () async {
      await connection.connect();
      final first = connection.waitUntilReady(
        timeout: const Duration(seconds: 2),
      );
      final second = connection.waitUntilReady(
        timeout: const Duration(seconds: 2),
      );
      await hub.ready('another-machine');
      await expectLater(
        first.timeout(const Duration(milliseconds: 20)),
        throwsA(isA<TimeoutException>()),
      );
      expect(connection.isReady, isFalse);
      await hub.ready();
      await Future.wait([first, second]);
      await connection.waitUntilReady(timeout: Duration.zero);
      expect(connection.isReady, isTrue);
      expect(hub.frames.map((f) => f['type']), ['machine_select']);
    },
  );

  test('an expired readiness wait does not poison the next one', () async {
    await expectLater(
      connection.waitUntilReady(timeout: const Duration(milliseconds: 1)),
      throwsA(isA<WsRequestTimeout>()),
    );
    final next = connection.waitUntilReady(timeout: const Duration(seconds: 2));
    await connection.connect();
    await hub.ready();
    await next;
    expect(connection.isReady, isTrue);
  });

  test('closing rejects pending and future readiness waits', () async {
    await connection.connect();
    final waiting = expectLater(
      connection.waitUntilReady(timeout: const Duration(seconds: 2)),
      throwsA(isA<StateError>()),
    );
    await connection.close();
    await waiting;
    await expectLater(
      connection.waitUntilReady(timeout: const Duration(seconds: 2)),
      throwsA(isA<StateError>()),
    );
  });

  test(
    'the real transport sends both discovery requests before either reply',
    () async {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        connectionForTest: (_) => connection,
      )..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      const host = Machine(
        machineId: 'm',
        name: 'Fixture computer',
        authMode: MachineAuthMode.remote,
      );
      final machine = MachineState(host)..nodeOnline = true;
      app.machines = [host];
      app.machineStates['m'] = machine;
      final sawAgents = Completer<void>();
      app.addListener(() {
        if (machine.agents.isNotEmpty && !sawAgents.isCompleted) {
          sawAgents.complete();
        }
      });
      await connection.connect();
      var finished = false;
      final load = app.reloadMachineData('m').then((_) => finished = true);
      await hub.selected.future;
      expect(hub.frames.map((f) => f['type']), ['machine_select']);
      await hub.ready();
      await Future.wait([
        hub.receive('agents_list'),
        hub.receive('terminal_capabilities'),
      ]).timeout(const Duration(seconds: 2));
      await hub.reply('agents_list', {
        'agents': [
          {'id': 'a', 'name': 'Fixture agent', 'engine': 'codex'},
        ],
      });
      await sawAgents.future.timeout(const Duration(seconds: 2));
      expect(finished, isFalse);
      expect(machine.terminalCapabilityLoaded, isFalse);
      await hub.reply('terminal_capabilities', {
        'protocolVersion': 3,
        'backend': 'tmux',
        'available': true,
      });
      await load;
      expect(machine.terminalCapabilityAvailable, isTrue);
      expect(app.panes, isEmpty);
      await hub.receive('agent_recent');
      expect(hub.frames.map((f) => f['type']), [
        'machine_select',
        'terminal_capabilities',
        'agents_list',
        'agent_recent',
      ]);
      await hub.reply('agent_recent', {
        'agentId': 'a',
        'events': [],
        'asks': [],
      });
    },
  );

  test(
    'an unlinked machine rejects readiness without running requests',
    () async {
      await connection.connect();
      final waiting = expectLater(
        connection.waitUntilReady(timeout: const Duration(seconds: 2)),
        throwsA(isA<StateError>()),
      );
      await (await hub.selected.future).close(4404, 'NO_PEER_LINK');
      await waiting;
      expect(connection.isReady, isFalse);
      expect(connection.isClosed, isTrue);
      expect(hub.frames.map((f) => f['type']), ['machine_select']);
    },
  );
}
