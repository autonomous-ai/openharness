import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/reading.dart';

import 'swarm_state_test.dart' show MemoryStore;
import 'support/super_tab_fixture.dart';

const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  readsOnConnect: true,
  connectGrace: Duration(seconds: 10),
  messagesWithState: true,
);

/// Two Swarms behind one machine that may not be connected yet.
class _Backend {
  final servers = {'tab': ConversationServer(), 'other': ConversationServer()};
  final paths = <String>[];
  bool machine = true;

  _Backend() {
    servers['other']!.state['id'] = 'other';
  }

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    paths.add(path);
    if (!machine) {
      throw const SuperTabFailure(
        'MACHINE_UNAVAILABLE',
        'Connect one of your machines to open Swarm.',
      );
    }
    if (Uri.parse(path).path == '/api/super-tabs/list') {
      return {
        'tabs': [
          {'id': 'tab', 'name': 'Pilot'},
          {'id': 'other', 'name': 'Other'},
        ],
        'next': null,
      };
    }
    final id = Uri.parse(path).pathSegments[2];
    return servers[id]!.request(method, path, body: body);
  }

  /// Reads of the Swarm itself: first loads and change reads.
  int states(String id) => paths
      .where(
        (p) =>
            p == '/api/super-tabs/$id/parts' ||
            p.startsWith('/api/super-tabs/$id/changes?'),
      )
      .length;
  int get discoveries =>
      paths.where((p) => Uri.parse(p).path == '/api/super-tabs/list').length;
}

/// Holds the next read of a Swarm's saved state until [release]d: an open
/// that has not landed yet.
class _HeldStore extends MemoryStore {
  Completer<void>? _held;
  bool _holdsNext = false;

  void holdNextOpen() {
    _held = Completer<void>();
    _holdsNext = true;
  }

  void release() => _held!.complete();

  @override
  Future<String?> read(String key) async {
    if (_holdsNext && key == 'super_tab.owner.tab') {
      _holdsNext = false;
      await _held!.future;
    }
    return super.read(key);
  }
}

SuperTabClient _client(
  _Backend backend, {
  MemoryStore? storage,
  SuperTabReading? reading,
  void Function(SuperTabMention)? onMention,
  void Function(SuperTabController)? onSnapshot,
}) {
  final client = SuperTabClient(
    transport: backend.call,
    storage: storage ?? MemoryStore(),
    onTabs: (_, _) {},
    onMention: onMention,
    onSnapshot: onSnapshot,
    discoveryInterval: const Duration(seconds: 15),
  );
  if (reading != null) client.reading = reading;
  return client;
}

void main() {
  test('only the Swarm tab on screen polls; the others wait until shown', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = _client(backend, reading: _web)
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      client.open('other');
      async.elapse(const Duration(seconds: 1));
      backend.paths.clear();
      async.elapse(const Duration(seconds: 20));
      expect(backend.states('other'), 0);
      expect(backend.states('tab'), 7);
      client.show('other');
      async.flushMicrotasks();
      expect(backend.states('other'), 1);
      backend.paths.clear();
      async.elapse(const Duration(seconds: 30));
      expect(backend.states('tab'), 0);
      client.dispose();
    });
  });

  test('a hidden page reads nothing; showing it again reads at once', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = _client(backend, reading: _web)
        ..bind('owner')
        ..show('tab');
      client.open('tab');
      async.elapse(const Duration(seconds: 1));
      client.pageVisible = false;
      backend.paths.clear();
      async.elapse(const Duration(minutes: 2));
      expect(backend.states('tab'), 0);
      client.pageVisible = true;
      async.flushMicrotasks();
      expect(backend.states('tab'), 1);
      client.dispose();
    });
  });

  test('machines connecting together make one read and one discovery', () {
    fakeAsync((async) {
      final backend = _Backend()..machine = false;
      final client = _client(backend, reading: _web)
        ..bind('owner')
        ..show('tab');
      SuperTabController? opened;
      client.open('tab').then((c) => opened = c);
      async.elapse(const Duration(seconds: 1));
      expect(opened!.snapshot, isNull);
      backend
        ..machine = true
        ..paths.clear();
      client
        ..serverAvailable()
        ..serverAvailable()
        ..serverAvailable();
      async.flushMicrotasks();
      expect(backend.states('tab'), 1);
      expect(backend.discoveries, 1);
      expect(opened!.snapshot, isNotNull);
      client.dispose();
    });
  });

  for (final (name, reading) in [('web', _web), ('Desktop', null)]) {
    test(
      '$name: a tag in a Swarm opened earlier but not shown is counted and told once',
      () {
        fakeAsync((async) {
          final backend = _Backend();
          final told = <String>[];
          final client = _client(
            backend,
            reading: reading,
            onMention: (m) => told.add(m.id),
          )..bind('owner');
          client.show('tab');
          client.open('tab');
          client.open('other');
          async.elapse(const Duration(seconds: 5));
          final other = backend.servers['other']!..append('Please confirm.');
          other.tag(other.messages.last['id'] as String);
          async.elapse(const Duration(minutes: 2));
          expect(client.waitingTags('other'), 1);
          expect(told, ['mention-1']);
          // Shown again, the Swarm reads its own tags: not told a second time.
          client.show('other');
          async.elapse(const Duration(seconds: 10));
          expect(client.waitingTags('other'), 1);
          expect(told, ['mention-1']);
          client.dispose();
        });
      },
    );
  }

  test('web: a tag that arrives just after the Swarm goes away is told', () {
    fakeAsync((async) {
      final backend = _Backend();
      final told = <String>[];
      final client = _client(
        backend,
        reading: _web,
        onMention: (m) => told.add(m.id),
      )..bind('owner');
      final other = backend.servers['other']!..append('First.');
      other.tag(other.messages.last['id'] as String);
      client.show('other');
      client.open('other');
      client.open('tab');
      // On screen, the Swarm reads its own tags: the first is not news.
      async.elapse(const Duration(seconds: 20));
      expect(client.waitingTags('other'), 1);
      client.show('tab');
      async.flushMicrotasks();
      other.append('Second.');
      other.tag(other.messages.last['id'] as String);
      async.elapse(const Duration(seconds: 16));
      expect(client.waitingTags('other'), 2);
      expect(told, ['mention-2']);
      client.dispose();
    });
  });

  test('web: a tag marked done while shown does not come back on leaving', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = _client(backend, reading: _web)..bind('owner');
      final other = backend.servers['other']!..append('Please confirm.');
      other.tag(other.messages.last['id'] as String);
      client.show('tab');
      client.open('tab');
      client.open('other');
      async.elapse(const Duration(seconds: 20));
      expect(client.waitingTags('other'), 1);
      client.show('other');
      async.flushMicrotasks();
      // Marked done on screen: the Swarm's own read says none wait.
      other.mentions.single['resolvedAt'] = '2026-10-26T06:00:00Z';
      other.state['mentionsWaiting'] = 0;
      other.revision++;
      async.elapse(const Duration(seconds: 3));
      expect(client.waitingTags('other'), 0);
      client.show('tab');
      async.flushMicrotasks();
      expect(client.waitingTags('other'), 0);
      client.dispose();
    });
  });

  test('Desktop reading: a connect waits for the poll, every tab polls', () {
    fakeAsync((async) {
      final backend = _Backend()..machine = false;
      final client = _client(backend)..bind('owner');
      SuperTabController? opened;
      client.open('tab').then((c) => opened = c);
      client.open('other');
      async.elapse(const Duration(seconds: 1));
      backend
        ..machine = true
        ..paths.clear();
      client.serverAvailable();
      async.flushMicrotasks();
      expect(backend.paths, isEmpty);
      expect(opened!.error, 'Connect one of your machines to open Swarm.');
      client.pageVisible = false;
      async.elapse(const Duration(seconds: 30));
      expect(backend.states('tab'), 10);
      expect(backend.states('other'), 10);
      client.dispose();
    });
  });

  test('Desktop: a released Swarm reads and rebuilds nothing; opening it '
      'again reads afresh', () {
    fakeAsync((async) {
      final backend = _Backend();
      var snapshots = 0;
      final client = _client(
        backend,
        reading: SuperTabReading.desktop,
        onSnapshot: (_) => snapshots++,
      )..bind('owner');
      SuperTabController? first;
      client.open('tab').then((c) => first = c);
      async.elapse(const Duration(seconds: 1));
      expect(snapshots, greaterThan(0));
      client.release('tab');
      async.flushMicrotasks();
      backend.servers['tab']!.append('Said after the tab closed');
      backend.paths.clear();
      snapshots = 0;
      async.elapse(const Duration(seconds: 10));
      expect(backend.paths, isEmpty);
      expect(snapshots, 0);
      expect(client.peek('tab'), isNull);
      SuperTabController? second;
      client.open('tab').then((c) => second = c);
      async.elapse(const Duration(seconds: 1));
      expect(second, isNot(same(first)));
      expect(backend.states('tab'), greaterThan(0));
      expect(snapshots, greaterThan(0));
      client.dispose();
    });
  });

  test('a Swarm released while it opens never reads; its open fails', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = _client(backend, reading: SuperTabReading.desktop)
        ..bind('owner');
      Object? failure;
      client.open('tab').then<void>((_) {}, onError: (Object e) => failure = e);
      client.release('tab');
      async.elapse(const Duration(seconds: 10));
      expect(backend.states('tab'), 0);
      expect(
        failure,
        isA<SuperTabFailure>().having((f) => f.code, 'code', 'CLOSED'),
      );
      expect(client.peek('tab'), isNull);
      client.dispose();
    });
  });

  test('a Swarm closed and opened again before its first open lands polls '
      'once, with the new view', () {
    fakeAsync((async) {
      final backend = _Backend();
      final storage = _HeldStore()..holdNextOpen();
      final client = _client(
        backend,
        reading: SuperTabReading.desktop,
        storage: storage,
      )..bind('owner');
      client.open('tab').ignore();
      async.flushMicrotasks();
      client.release('tab');
      SuperTabController? reopened;
      client.open('tab').then((c) => reopened = c);
      async.elapse(const Duration(seconds: 1));
      storage.release();
      async.elapse(const Duration(seconds: 1));
      expect(reopened, isNotNull);
      expect(client.peek('tab'), same(reopened));
      backend.paths.clear();
      async.elapse(const Duration(seconds: 9));
      expect(backend.states('tab'), 3);
      client.dispose();
    });
  });

  test('a Swarm closed again before its reopen lands still protects its '
      'Product Manager', () {
    fakeAsync((async) {
      final backend = _Backend();
      final server = backend.servers['tab']!;
      server.state['agents'] = [
        {
          'id': 'pm',
          'name': 'Quinn',
          'machineId': 'm',
          'harnessId': 'native-pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      (server.state['conversations'] as List)[0]['leadId'] = 'pm';
      final storage = _HeldStore();
      final client = _client(
        backend,
        reading: SuperTabReading.desktop,
        storage: storage,
      )..bind('owner');
      client.open('tab');
      async.elapse(const Duration(seconds: 1));
      client.release('tab');
      expect(
        client.leadProtectionReasonForHarness('m', 'native-pm'),
        isNotNull,
      );
      storage.holdNextOpen();
      client.open('tab').ignore();
      async.flushMicrotasks();
      client.release('tab');
      storage.release();
      async.elapse(const Duration(seconds: 10));
      expect(client.peek('tab'), isNull);
      expect(
        client.leadProtectionReasonForHarness('m', 'native-pm'),
        isNotNull,
      );
      client.dispose();
    });
  });
}
