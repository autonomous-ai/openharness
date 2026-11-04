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
  int status = 503,
}) async {
  request.response
    ..statusCode = fails ? status : 200
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
    api.sharesChanged();
    final fallback = api.machines();
    await _until(() => requests.machines.length == 3);
    await _reply(requests.machines.last, 'owned-next');
    await _until(() => requests.shares.length == 3);
    await _reply(requests.shares.last, 'unused', fails: true);
    final snapshot = await fallback as MachineInventory;
    // The last shares that were read stand in, as they are: not a stale list that recovery reads again.
    expect(snapshot.map((m) => m.machineId), ['owned-next', 'shared-current']);
    expect(snapshot.isStale, isFalse);
  });

  group('harness shares, read through the owner daemons in seconds', () {
    var now = DateTime(2026, 10, 28, 12);
    setUp(() {
      now = DateTime(2026, 10, 28, 12);
      api = ApiClient(
        config: AppConfig(
          localCliBaseUrl: 'http://127.0.0.1:${server.port}',
          apiBaseUrl: 'http://unused.invalid',
        ),
        session: AuthSession(storage: MemoryStore()),
        clock: () => now,
      );
    });

    /// One machine read. [shared] answers its shares read with that machine, [status] fails it;
    /// with neither, no shares read is expected.
    Future<MachineInventory> load({String? shared, int? status}) async {
      final machines = requests.machines.length;
      final shares = requests.shares.length;
      var done = false;
      final pending = api.machines().whenComplete(() => done = true);
      await _until(() => requests.machines.length == machines + 1);
      await _reply(requests.machines.last, 'owned');
      final expected = shared != null || status != null;
      if (expected) {
        await _until(() => requests.shares.length == shares + 1);
        await _reply(
          requests.shares.last,
          shared ?? 'unused',
          fails: status != null,
          status: status ?? 503,
        );
      } else {
        await _until(() => done || requests.shares.length > shares);
      }
      expect(requests.shares.length, shares + (expected ? 1 : 0));
      return await pending as MachineInventory;
    }

    List<String> ids(MachineInventory list) => [
      for (final m in list) m.machineId,
    ];

    test('ten pushes a minute read them once; a push that says they changed reads them again', () async {
      expect(ids(await load(shared: 's1')), ['owned', 's1']);
      for (var i = 0; i < 10; i++) {
        now = now.add(const Duration(seconds: 6));
        final list = await load();
        expect(ids(list), ['owned', 's1']);
        expect(list.isStale, isFalse);
      }
      api.sharesChanged();
      expect(ids(await load(shared: 's2')), ['owned', 's2']);
      // And at most every five minutes otherwise.
      now = now.add(const Duration(minutes: 4, seconds: 59));
      await load();
      now = now.add(const Duration(seconds: 1));
      expect(ids(await load(shared: 's3')), ['owned', 's3']);
    });

    test('a failed read waits 1, 2, then 5 minutes, and keeps the last good shares meanwhile', () async {
      await load(shared: 's1');
      api.sharesChanged();
      // The daemon's 504 after 20 s (Diego's app log, 2026-10-28): every push started the same read again.
      expect(ids(await load(status: 504)), ['owned', 's1']);
      for (final wait in const [
        Duration(minutes: 1),
        Duration(minutes: 2),
        Duration(minutes: 5),
      ]) {
        now = now.add(wait - const Duration(seconds: 1));
        final kept = await load();
        expect(ids(kept), ['owned', 's1']);
        expect(kept.isStale, isFalse);
        now = now.add(const Duration(seconds: 1));
        if (wait.inMinutes < 5) await load(status: 502);
      }
      // Told meanwhile, it reads once the wait is over; a read that answers starts the waits over.
      expect(ids(await load(shared: 's2')), ['owned', 's2']);
      api.sharesChanged();
      await load(status: 504);
      now = now.add(const Duration(seconds: 59));
      await load();
      now = now.add(const Duration(seconds: 1));
      await load(shared: 's3');
    });

    test('with no shares read yet, a failure is a stale list, and the account changing starts over', () async {
      final first = await load(status: 504);
      expect(ids(first), ['owned']);
      expect(first.isStale, isTrue);
      expect(
        (await load()).isStale,
        isTrue,
        reason: 'still nothing good to show, and still waiting',
      );
      api.resetAccountCache();
      expect(ids(await load(shared: 'theirs')), ['owned', 'theirs']);
    });
  });

  test('a machine shared whole joins the list once added, and waits under Add machine before', () async {
    final listed = api.machines();
    await _until(() => requests.machines.length == 1);
    Map<String, dynamic> shared(String id, String via, bool added) => {
      'machineId': id,
      'name': id,
      'authMode': 'remote',
      'status': 'running',
      'share': {
        'ownerName': 'Dee',
        'ownerEmail': 'dee@acme.io',
        'via': via,
        'added': added,
      },
    };
    requests.machines.single.response
      ..statusCode = 200
      ..headers.contentType = ContentType.json
      ..write(
        jsonEncode({
          'success': true,
          'data': {
            'machines': [
              {'machineId': 'own', 'name': 'own', 'authMode': 'remote'},
            ],
            'sharedMachines': [
              shared('named', 'email', true),
              shared('team-added', 'domain', true),
              shared('team-waiting', 'domain', false),
              // Listed as the account's own too: the account's own row wins.
              shared('own', 'email', true),
            ],
          },
        }),
      );
    await requests.machines.single.response.close();
    await _until(() => requests.shares.length == 1);
    await _reply(requests.shares.single, 'unused', fails: true);
    final inventory = await listed as MachineInventory;
    expect(inventory.map((m) => m.machineId), ['own', 'named', 'team-added']);
    expect(inventory.first.isSharedMachine, isFalse);
    final named = inventory[1];
    expect(named.isSharedMachine, isTrue);
    expect(named.isShared, isFalse);
    expect(named.machineShare!.owner, 'Dee');
    expect(named.machineShare!.viaDomain, isFalse);
    expect(inventory[2].machineShare!.viaDomain, isTrue);
    expect(inventory.toAdd.map((m) => m.machineId), ['team-waiting']);
    expect(
      named.copyWith(name: 'Renamed').machineShare?.ownerEmail,
      'dee@acme.io',
    );
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
