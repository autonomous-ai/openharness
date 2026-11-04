/// A hidden Desktop window reads its Swarms only when the server says something changed
/// (task #2953, roadmap Phase 3 item 2).
///
/// Desktop keeps reading the Swarms it does not show, because their badges and
/// notices come from those reads. With the server pushing, a change is told and
/// read at once; the reads on a clock (the 60 s safety net of each open Swarm,
/// discovery's 2-minute one) were the hidden window's idle traffic. These pin
/// that they stop while the window is hidden and catch up once on return, and
/// that without pushes the 15 s away poll still runs, so no tag is missed.
library;

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';

import 'swarm_state_test.dart' show MemoryStore;
import 'support/super_tab_fixture.dart';

/// Two Swarms behind one backend.
class _Backend {
  final servers = {'tab': ConversationServer(), 'other': ConversationServer()};
  final paths = <String>[];

  _Backend() {
    servers['other']!.state['id'] = 'other';
  }

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    paths.add(path);
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

  int states(String id) => paths
      .where(
        (p) =>
            p == '/api/super-tabs/$id/parts' ||
            p.startsWith('/api/super-tabs/$id/changes?'),
      )
      .length;
  int get discoveries =>
      paths.where((p) => Uri.parse(p).path == '/api/super-tabs/list').length;
  int get reads => paths.length;
}

var _changedAt = DateTime.utc(2100).millisecondsSinceEpoch;

void main() {
  /// Desktop's client with Swarm 'tab' open and on screen.
  SuperTabClient desktop(FakeAsync async, _Backend backend) {
    final client = SuperTabClient(
      transport: backend.call,
      storage: MemoryStore(),
      onTabs: (_, _) {},
      discoveryInterval: const Duration(seconds: 15),
    )..reading = SuperTabReading.desktop;
    client
      ..bind('owner')
      ..show('tab');
    client.open('tab');
    async.elapse(const Duration(seconds: 1));
    return client;
  }

  test('hidden while the server pushes: no read on a clock for 10 minutes; '
      'shown: the Swarm and the list once each', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = desktop(async, backend);
      // The server's word that it pushes: on connect, then every 4 minutes
      // (backend lib/swarmClientPushes.ts PUSHES_REPEAT_MS), as a live socket hears it.
      client.swarmChanged(const {});
      final repeat = Timer.periodic(
        const Duration(minutes: 4),
        (_) => client.swarmChanged(const {}),
      );
      async.elapse(const Duration(seconds: 20));
      client.pageVisible = false;
      async.elapse(const Duration(seconds: 1));
      backend.paths.clear();
      async.elapse(const Duration(minutes: 10));
      expect(backend.paths, isEmpty, reason: 'nothing read on a clock');
      repeat.cancel();
      async.elapse(const Duration(seconds: 2));
      expect(backend.paths, isEmpty, reason: 'nothing read on a clock');

      client.pageVisible = true;
      async.elapse(const Duration(seconds: 2));
      expect(backend.states('tab'), 1, reason: 'the Swarm on screen, once');
      expect(backend.discoveries, 1, reason: 'the list, once');
      client.dispose();
    });
  });

  test(
    'hidden while the server pushes: a told change is still read at once',
    () {
      fakeAsync((async) {
        final backend = _Backend();
        final client = desktop(async, backend);
        client.swarmChanged(const {});
        async.elapse(const Duration(seconds: 20));
        client.pageVisible = false;
        async.elapse(const Duration(seconds: 1));
        backend.paths.clear();
        backend.servers['tab']!.append('A tag for you');
        client.swarmChanged({
          'tabId': 'tab',
          'lastChangedAt': ++_changedAt,
          'parts': const ['main'],
        });
        async.elapse(const Duration(seconds: 2));
        expect(backend.states('tab'), 1);
        client.dispose();
      });
    },
  );

  // Review of #3035: the word comes on every connect too, with the same payload. A word off the
  // 4-minute beat is a socket that reconnected, and a push may have been lost meanwhile: a hidden
  // window reads its open Swarms and the list once, so a tag's notice still comes.
  test('hidden while the server pushes: a word off the 4-minute beat (a '
      'reconnect) reads the open Swarm and the list once', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = desktop(async, backend);
      client.swarmChanged(const {});
      async.elapse(const Duration(seconds: 20));
      client.pageVisible = false;
      async.elapse(const Duration(seconds: 70));
      backend.paths.clear();
      // A tag lands while the socket is away, then the socket is back.
      backend.servers['tab']!.append('A tag for you');
      client.swarmChanged(const {});
      async.elapse(const Duration(seconds: 20));
      expect(backend.states('tab'), 1, reason: 'the open Swarm, once');
      expect(backend.discoveries, 1, reason: 'the list, once');
      backend.paths.clear();
      // Its own beat 4 minutes on is a repeat: nothing.
      async.elapse(const Duration(minutes: 4) - const Duration(seconds: 20));
      client.swarmChanged(const {});
      async.elapse(const Duration(seconds: 20));
      expect(backend.paths, isEmpty, reason: 'a repeat reads nothing');
      client.dispose();
    });
  });

  test('hidden with no push heard: the 15 s away poll still reads, so tags '
      'and notices still arrive', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = desktop(async, backend);
      client.pageVisible = false;
      async.elapse(const Duration(seconds: 1));
      backend.paths.clear();
      async.elapse(const Duration(minutes: 1));
      expect(backend.states('tab'), inInclusiveRange(3, 4));
      client.dispose();
    });
  });

  test('a glance away shorter than the safety net reads nothing on return', () {
    fakeAsync((async) {
      final backend = _Backend();
      final client = desktop(async, backend);
      client.swarmChanged(const {});
      async.elapse(const Duration(seconds: 20));
      backend.paths.clear();
      client.pageVisible = false;
      async.elapse(const Duration(seconds: 5));
      client.pageVisible = true;
      async.elapse(const Duration(seconds: 1));
      expect(backend.discoveries, 0);
      client.dispose();
    });
  });

  test('the safety net constants this pins', () {
    expect(kSwarmPushSafetyNet, const Duration(seconds: 60));
    expect(kSwarmDiscoverySafetyNet, const Duration(minutes: 2));
  });
}
