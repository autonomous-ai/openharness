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

SuperTabClient _client(
  _Backend backend, {
  SuperTabReading? reading,
  void Function(SuperTabMention)? onMention,
  void Function(SuperTabController)? onSnapshot,
}) {
  final client = SuperTabClient(
    transport: backend.call,
    storage: MemoryStore(),
    onTabs: (_, _) {},
    onMention: onMention,
    onSnapshot: onSnapshot,
    discoveryInterval: const Duration(seconds: 15),
  );
  if (reading != null) client.reading = reading;
  return client;
}

void main() {
  _pushGroup();
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

  test('a Swarm released while it opens stops once it has opened', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = _client(backend, reading: SuperTabReading.desktop)
        ..bind('owner');
      client.open('tab');
      client.release('tab');
      async.elapse(const Duration(seconds: 1));
      backend.paths.clear();
      async.elapse(const Duration(seconds: 10));
      expect(backend.paths, isEmpty);
      expect(client.peek('tab'), isNull);
      client.dispose();
    });
  });
}

/// WS roadmap Phase 2a: the server's pushes (backend lib/swarmClientPushes.ts)
/// as the app hands them on (`AppNotifier`, a `swarm_changed` frame).
void _heard(SuperTabClient client, [Map<String, dynamic> payload = const {}]) =>
    client.swarmChanged(payload);

/// Each change newer than the last: a push no read has covered yet.
var _changedAt = DateTime.utc(2100).millisecondsSinceEpoch;
Map<String, dynamic> _change(
  String id, [
  List<String> parts = const ['main'],
]) => {'tabId': id, 'lastChangedAt': ++_changedAt, 'parts': parts};

void _pushGroup() {
  group('Swarms the server pushes', () {
    test('discovery reads every 2 minutes, and a second after a change, once per burst', () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = _client(backend)..bind('owner');
        async.elapse(const Duration(seconds: 1));
        _heard(client);
        // The word that it pushes asked for one discovery, at the 15 s gap.
        async.elapse(const Duration(seconds: 16));
        backend.paths.clear();
        async.elapse(const Duration(seconds: 60));
        expect(backend.discoveries, 0);
        for (final id in ['tab', 'other', 'tab']) {
          _heard(client, _change(id));
        }
        async.elapse(const Duration(seconds: 1));
        expect(backend.discoveries, 1);
        async.elapse(const Duration(seconds: 118));
        expect(backend.discoveries, 1);
        // The safety net is checked on the 15 s tick: the first after 2 minutes.
        async.elapse(const Duration(seconds: 15));
        expect(backend.discoveries, 2);
        client.dispose();
      });
    });

    test(
      'a change reads the Swarm open here at once, and nothing of one not open',
      () {
        fakeAsync((async) {
          final backend = _Backend();
          final client = _client(backend)..bind('owner');
          client.open('tab');
          async.elapse(const Duration(seconds: 1));
          _heard(client);
          // The word that it pushes read the open Swarm once, at the 3 s gap.
          async.elapse(const Duration(seconds: 5));
          backend.paths.clear();
          _heard(client, _change('tab'));
          _heard(client, _change('other'));
          async.flushMicrotasks();
          expect(backend.states('tab'), 1);
          expect(backend.states('other'), 0);
          client.dispose();
        });
      },
    );

    test('a machine\'s reading alone neither discovers nor reads at once', () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = _client(backend)..bind('owner');
        client.open('tab');
        async.elapse(const Duration(seconds: 1));
        _heard(client);
        backend.paths.clear();
        _heard(client, _change('tab', ['machine']));
        async.elapse(const Duration(milliseconds: 1500));
        expect(backend.discoveries, 0);
        expect(backend.states('tab'), 0);
        async.elapse(const Duration(seconds: 3));
        expect(backend.states('tab'), 1);
        client.dispose();
      });
    });

    test(
      'a Swarm opened after the server said it pushes reads only when told',
      () {
        fakeAsync((async) {
          final backend = _Backend();
          final client = _client(backend)..bind('owner');
          async.elapse(const Duration(seconds: 1));
          _heard(client);
          client.open('other');
          async.elapse(const Duration(seconds: 1));
          backend.paths.clear();
          async.elapse(const Duration(seconds: 30));
          expect(backend.states('other'), 0);
          client.dispose();
        });
      },
    );

    test('everything polls as before once the server\'s word is over 5 minutes old', () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = _client(backend)..bind('owner');
        client.open('tab');
        async.elapse(const Duration(seconds: 1));
        _heard(client);
        async.elapse(kSwarmPushLease);
        backend.paths.clear();
        async.elapse(const Duration(seconds: 30));
        expect(backend.discoveries, 2);
        expect(backend.states('tab'), 10);
        client.dispose();
      });
    });

    // Review of #2121, 5: the list read about once a second in a busy Swarm.
    test('discovery reads no more often than every 15 s, however busy', () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = _client(backend)..bind('owner');
        async.elapse(const Duration(seconds: 1));
        _heard(client);
        async.elapse(const Duration(seconds: 30));
        backend.paths.clear();
        for (var i = 0; i < 60; i++) {
          _heard(client, _change(i.isEven ? 'tab' : 'other'));
          async.elapse(const Duration(seconds: 1));
        }
        expect(backend.discoveries, inInclusiveRange(4, 5));
        client.dispose();
      });
    });

    // Review of #2121, 6: a daemon that reconnects only says it pushes again;
    // what changed meanwhile was not pushed.
    test('the server saying it pushes again reads the open Swarm and the list once', () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = _client(backend)..bind('owner');
        client.open('tab');
        async.elapse(const Duration(seconds: 1));
        _heard(client);
        async.elapse(const Duration(seconds: 50));
        backend.paths.clear();
        _heard(client);
        async.elapse(const Duration(seconds: 2));
        expect(backend.states('tab'), 1);
        expect(backend.discoveries, 1);
        client.dispose();
      });
    });

    test('a frame that names a Swarm wrongly changes nothing', () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = _client(backend)..bind('owner');
        client.open('tab');
        async.elapse(const Duration(seconds: 1));
        _heard(client);
        async.elapse(const Duration(seconds: 16));
        backend.paths.clear();
        _heard(client, {
          'tabId': 7,
          'parts': ['main'],
        });
        _heard(client, {'tabId': 'tab', 'parts': 'main'});
        async.elapse(const Duration(seconds: 2));
        expect(backend.paths, isEmpty);
        client.dispose();
      });
    });
  });
}
