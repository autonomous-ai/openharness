import 'dart:async';

import 'package:clock/clock.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';

/// What the web build reads with (`webWorkspaceChrome`).
const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  readsOnConnect: true,
  connectGrace: Duration(seconds: 10),
  messagesWithState: true,
);

bool _isStateRead(String path) =>
    path == '/api/super-tabs/tab/parts' ||
    path.startsWith('/api/super-tabs/tab/changes?');

/// Every read the controller made, in order.
class _Reads {
  _Reads(this.server);
  final ConversationServer server;
  final paths = <String>[];

  /// While set, each state read waits for a completer added here.
  List<Completer<void>>? holdState;

  Future<Map<String, dynamic>> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) {
    if (method == 'GET') paths.add(path);
    if (holdState case final held? when _isStateRead(path)) {
      final wait = Completer<void>();
      held.add(wait);
      return wait.future.then((_) => server.request(method, path, body: body));
    }
    return server.request(method, path, body: body);
  }

  int get states => paths.where(_isStateRead).length;
  int get messageReads => paths.where((p) => p.contains('/messages')).length;
  void clear() => paths.clear();
}

SuperTabController _controller(
  _Reads reads, {
  SuperTabReading reading = SuperTabReading.desktop,
}) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: reads.call,
  save: reads.server.save,
  reading: reading,
);

/// The server's word that it pushes, heard now (desktop super_tabs/client.dart).
void _pushes(SuperTabController c) =>
    c.pushUntil = clock.now().add(kSwarmPushLease);

/// WS roadmap Phase 2a: a server that pushes (backend lib/swarmClientPushes.ts)
/// says when a Swarm changed; the open Swarm reads then, and on a long safety
/// net, instead of every 3 s (Desktop) or 15 s (browser).
void main() {
  group('a Swarm the server pushes', () {
    test('is read only every 60 s while nothing changes', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer()..append('Hello'));
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        _pushes(c);
        reads.clear();
        async.elapse(const Duration(seconds: 59));
        expect(reads.states, 0);
        async.elapse(const Duration(seconds: 1));
        expect(reads.states, 1);
        c.dispose();
      });
    });

    test('is read at once when told of a change, state then messages', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        _pushes(c);
        async.elapse(const Duration(seconds: 10));
        reads.clear();
        server.append('A reply');
        c.told(main: true);
        async.flushMicrotasks();
        expect(reads.states, 1);
        expect(reads.messageReads, greaterThan(0));
        expect(c.messages('lead').last.text, 'A reply');
        c.dispose();
      });
    });

    // The Lead's rule (2026-10-29): a burst of pushes is one read, and one more
    // for a push heard while a read was out, which may have missed it.
    test(
      'reads once per burst: once more after a read that was out when told',
      () {
        fakeAsync((async) {
          final reads = _Reads(ConversationServer()..append('Hello'));
          final c = _controller(reads)..start();
          async.flushMicrotasks();
          _pushes(c);
          async.elapse(const Duration(seconds: 10));
          reads
            ..clear()
            ..holdState = [];
          c.told(main: true);
          async.flushMicrotasks();
          for (var i = 0; i < 3; i++) {
            c.told(main: true);
          }
          expect(reads.states, 1);
          reads.holdState!.single.complete();
          reads.holdState = null;
          async.flushMicrotasks();
          expect(reads.states, 2);
          async.elapse(const Duration(seconds: 10));
          expect(reads.states, 2);
          c.dispose();
        });
      },
    );

    test('reads a machine\'s reading no more often than the poll did', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer()..append('Hello'));
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        _pushes(c);
        async.elapse(const Duration(seconds: 10));
        reads.clear();
        c.told(main: false);
        c.told(main: false);
        async.flushMicrotasks();
        expect(reads.states, 0);
        async.elapse(const Duration(seconds: 2));
        expect(reads.states, 1);
        async.elapse(const Duration(seconds: 30));
        expect(reads.states, 1);
        c.dispose();
      });
    });

    // A receipt moves on the delivery's own record, which no Swarm push names.
    test(
      'keeps the poll while the person\'s own message waits for its receipt',
      () {
        fakeAsync((async) {
          final server = ConversationServer()..append('Build it');
          server.messages.last['deliveries'] = [
            {'id': 'd', 'agentId': 'lead-agent', 'status': 'queued'},
          ];
          final reads = _Reads(server);
          final c = _controller(reads)..start();
          async.flushMicrotasks();
          _pushes(c);
          reads.clear();
          async.elapse(const Duration(seconds: 9));
          expect(reads.states, 3);
          server.messages.last['deliveries'] = [
            {'id': 'd', 'agentId': 'lead-agent', 'status': 'answered'},
          ];
          async.elapse(const Duration(seconds: 3));
          reads.clear();
          async.elapse(const Duration(seconds: 30));
          expect(reads.states, 0);
          c.dispose();
        });
      },
    );

    test(
      'goes back to the 3 s poll once the server\'s word is over 5 minutes old',
      () {
        fakeAsync((async) {
          final reads = _Reads(ConversationServer()..append('Hello'));
          final c = _controller(reads)..start();
          async.flushMicrotasks();
          _pushes(c);
          async.elapse(kSwarmPushLease);
          reads.clear();
          async.elapse(const Duration(seconds: 9));
          expect(reads.states, 3);
          c.dispose();
        });
      },
    );

    test(
      'in the browser, reads nothing but the safety net while nothing changes',
      () {
        fakeAsync((async) {
          final reads = _Reads(ConversationServer()..append('Hello'));
          final c = _controller(reads, reading: _web)..start();
          async.flushMicrotasks();
          _pushes(c);
          reads.clear();
          async.elapse(const Duration(seconds: 45));
          expect(reads.paths, isEmpty);
          async.elapse(const Duration(seconds: 15));
          expect(reads.states, 1);
          c.dispose();
        });
      },
    );
  });
}
