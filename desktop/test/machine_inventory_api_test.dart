import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _Requests {
  final machines = <HttpRequest>[];
  final shares = <HttpRequest>[];
  void receive(HttpRequest request) {
    if (request.uri.path == '/api/machines') {
      machines.add(request);
    } else if (request.uri.path == '/api/harness-shares') {
      shares.add(request);
    } else {
      request.response.statusCode = 404;
      unawaited(request.response.close());
    }
  }
}

Future<void> _until(bool Function() ready) async {
  for (var i = 0; i < 200 && !ready(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 2));
  }
  expect(ready(), isTrue);
}

Future<void> _reply(
  HttpRequest request,
  String name, {
  bool stale = false,
  bool fails = false,
}) async {
  request.response
    ..statusCode = fails ? 503 : 200
    ..headers.contentType = ContentType.json
    ..write(
      jsonEncode(
        fails
            ? {
                'success': false,
                'error': {'message': 'Fixture unavailable'},
              }
            : {
                'success': true,
                'data': {
                  'stale': stale,
                  'machines': [
                    {'machineId': name, 'name': name, 'authMode': 'remote'},
                  ],
                },
              },
      ),
    );
  await request.response.close();
}

void main() {
  late HttpServer server;
  late StreamSubscription<HttpRequest> subscription;
  late _Requests requests;
  late ApiClient api;
  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    requests = _Requests();
    subscription = server.listen(requests.receive);
    api = ApiClient(
      config: AppConfig(
        localCliBaseUrl: 'http://127.0.0.1:${server.port}',
        apiBaseUrl: 'http://unused.invalid',
      ),
      session: AuthSession(storage: MemoryStore()),
    );
  });
  tearDown(() async {
    await subscription.cancel();
    await server.close(force: true);
  });

  test('overlapping inventories keep their own freshness and the latest sharing cache', () async {
    final old = api.machines();
    await _until(() => requests.machines.length == 1);
    await _reply(requests.machines.first, 'owned-old');
    await _until(() => requests.shares.length == 1);
    final current = api.machines();
    await _until(() => requests.machines.length == 2);
    await _reply(requests.machines.last, 'owned-current', stale: true);
    await _until(() => requests.shares.length == 2);
    await _reply(requests.shares.last, 'shared-current');
    final latest = await current as MachineInventory;
    await _reply(requests.shares.first, 'shared-old');
    final previous = await old as MachineInventory;
    expect(previous.isStale, isFalse);
    expect(latest.isStale, isTrue);
    expect(api.lastMachinesStale, isTrue);
    final fallback = api.machines();
    await _until(() => requests.machines.length == 3);
    await _reply(requests.machines.last, 'owned-next');
    await _until(() => requests.shares.length == 3);
    await _reply(requests.shares.last, 'unused', fails: true);
    final snapshot = await fallback as MachineInventory;
    expect(snapshot.map((m) => m.machineId), ['owned-next', 'shared-current']);
    expect(snapshot.isStale, isTrue);
  });

  test('account reset stops an old request before it fetches sharing for the new account', () async {
    final old = api.machines();
    final rejected = expectLater(old, throwsStateError);
    await _until(() => requests.machines.isNotEmpty);
    api.resetAccountCache();
    await _reply(requests.machines.single, 'old-owned');
    await rejected;
    expect(requests.shares, isEmpty);
    expect(api.lastMachinesStale, isFalse);
  });

  test(
    'old sharing response cannot refill cache after an account reset',
    () async {
      final old = api.machines();
      final rejected = expectLater(old, throwsStateError);
      await _until(() => requests.machines.length == 1);
      await _reply(requests.machines.first, 'old-owned');
      await _until(() => requests.shares.length == 1);
      api.resetAccountCache();
      await _reply(requests.shares.first, 'old-shared');
      await rejected;
      final current = api.machines();
      await _until(() => requests.machines.length == 2);
      await _reply(requests.machines.last, 'new-owned');
      await _until(() => requests.shares.length == 2);
      await _reply(requests.shares.last, 'unused', fails: true);
      final snapshot = await current as MachineInventory;
      expect(snapshot.map((m) => m.machineId), ['new-owned']);
      expect(snapshot.isStale, isTrue);
    },
  );
}
