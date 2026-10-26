import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
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
    if (path.startsWith('/api/super-tabs?') || path == '/api/super-tabs') {
      return {
        'tabs': [
          {'id': 'tab', 'name': 'Pilot'},
          {'id': 'other', 'name': 'Other'},
        ],
        'next': null,
      };
    }
    if (path.endsWith('/mentions?state=waiting')) return {'mentions': []};
    final id = Uri.parse(path).pathSegments[2];
    return servers[id]!.request(method, path, body: body);
  }

  int states(String id) =>
      paths.where((p) => p == '/api/super-tabs/$id').length;
  int get discoveries =>
      paths.where((p) => Uri.parse(p).path == '/api/super-tabs').length;
}

SuperTabClient _client(_Backend backend, {SuperTabReading? reading}) {
  final client = SuperTabClient(
    transport: backend.call,
    storage: MemoryStore(),
    onTabs: (_, _) {},
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
}
