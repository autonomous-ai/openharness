import 'dart:async';

import 'package:clock/clock.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';

bool _isStateRead(String path) =>
    path == '/api/super-tabs/tab/parts' ||
    path.startsWith('/api/super-tabs/tab/changes?');

/// A Swarm of five machines, each reporting every 15 s, as a machine's
/// heartbeat does (cli/src/superTabs/machines.ts MACHINE_HEARTBEAT_MS). What
/// the app heard and read is counted, and each count is printed for the PR.
class _Rig {
  _Rig(this.async, {bool away = false}) {
    server.append('Hello');
    server.state['machines'] = [
      for (final id in _ids)
        {
          'machineId': id,
          'name': id,
          'contributorId': 'owner',
          'maxAgents': 4,
          'observation': {'receivedAt': _at(), 'resources': {'cpu': 1}},
        },
    ];
    c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      request: (method, path, {body}) {
        if (method == 'GET') paths.add(path);
        return failing ?? server.request(method, path, body: body);
      },
      save: server.save,
      reading: SuperTabReading.desktop,
    )..start();
    async.flushMicrotasks();
    c.pushUntil = clock.now().add(kSwarmPushLease);
    c.away = away;
    async.elapse(const Duration(seconds: 3));
    c.addListener(() => told++);
    paths.clear();
    told = 0;
  }

  static const _ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
  static int _at() => clock.now().millisecondsSinceEpoch;

  final FakeAsync async;
  final server = ConversationServer();
  late final SuperTabController c;
  final paths = <String>[];
  int told = 0;
  Future<Map<String, dynamic>>? failing;

  Map<String, dynamic> machine(String id) =>
      (server.state['machines'] as List).cast<Map<String, dynamic>>().firstWhere(
        (m) => m['machineId'] == id,
      );

  /// [id] reports now, and the server says so with a machine's push.
  void beat(String id) {
    final m = machine(id);
    m['observation'] = {'receivedAt': _at(), 'resources': {'cpu': _at() % 97}};
    c.told(main: false, at: _at());
  }

  /// A minute of heartbeats: five machines, 15 s apart each, spread evenly.
  void minute() {
    for (var i = 0; i < 20; i++) {
      beat(_ids[i % 5]);
      async.elapse(const Duration(seconds: 3));
    }
  }

  int get states => paths.where(_isStateRead).length;
  int get messages => paths.where((p) => p.contains('/messages')).length;
  void close() => c.dispose();
}

void main() {
  group('a minute of heartbeats from five machines, on screen', () {
    test('reads no messages and tells the controller\'s listeners nothing', () {
      fakeAsync((async) {
        final r = _Rig(async);
        final before = r.c.snapshot;
        r.minute();
        // ignore: avoid_print
        print('COUNT on screen: state reads ${r.states}, messages reads '
            '${r.messages}, controller notifications ${r.told}');
        expect(r.states, greaterThan(0));
        expect(r.messages, 0);
        expect(r.told, 0);
        expect(identical(r.c.snapshot, before), isTrue);
        r.close();
      });
    });

    test('its machine\'s reading is new, and those listening hear of it', () {
      fakeAsync((async) {
        final r = _Rig(async);
        var heard = 0;
        r.c.machinesChanged.addListener(() => heard++);
        r.beat('m3');
        final at = r.machine('m3')['observation']['receivedAt'];
        async.elapse(const Duration(seconds: 3));
        expect(heard, 1);
        expect(r.c.snapshot!.pool('m3')!['observation']['receivedAt'], at);
        r.close();
      });
    });
  });

  group('a read a heartbeat came with something else in', () {
    void redraws(String what, void Function(_Rig r) change, {bool? messages}) {
      test('$what: everything redraws, and the chat is read', () {
        fakeAsync((async) {
          final r = _Rig(async);
          final before = r.c.snapshot;
          change(r);
          r.beat('m1');
          async.elapse(const Duration(seconds: 3));
          expect(r.told, greaterThan(0));
          expect(identical(r.c.snapshot, before), isFalse);
          expect(r.messages, greaterThan(0));
          r.close();
        });
      });
    }

    redraws('a new message', (r) => r.server.append('A reply'));
    redraws('a renamed machine', (r) => r.machine('m2')['name'] = 'Studio');
    redraws('a paused machine', (r) => r.machine('m2')['paused'] = true);
    redraws(
      'a new machine',
      (r) => (r.server.state['machines'] as List).add({
        'machineId': 'm6',
        'name': 'm6',
        'contributorId': 'owner',
        'maxAgents': 4,
      }),
    );
    redraws(
      'a machine gone',
      (r) => (r.server.state['machines'] as List).removeWhere(
        (m) => (m as Map)['machineId'] == 'm5',
      ),
    );
  });

  test('a read failing during a heartbeat still says so', () {
    fakeAsync((async) {
      final r = _Rig(async);
      r.failing = Future.error(
        const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503),
      )..ignore();
      r.beat('m1');
      async.elapse(const Duration(seconds: 3));
      expect(r.told, greaterThan(0));
      expect(r.c.backendUnreachable, isTrue);
      r.close();
    });
  });
}
