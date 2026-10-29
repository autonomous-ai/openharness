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

/// Every read the controller made, in order.
class _Reads {
  _Reads(this.server);
  final ConversationServer server;
  final paths = <String>[];

  Future<Map<String, dynamic>> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) {
    if (method == 'GET') paths.add(path);
    return server.request(method, path, body: body);
  }

  int get states => paths.where(_isStateRead).length;
  int get messageReads => paths.where((p) => p.contains('/messages')).length;
  void clear() => paths.clear();
}

SuperTabController _controller(_Reads reads) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: reads.call,
  save: reads.server.save,
  reading: SuperTabReading.desktop,
);

const _poll = Duration(seconds: 3);

/// Stability roadmap 2.5: Desktop asks for less when nothing happens, and
/// when a Swarm is not the one in front.
void main() {
  group('a poll that finds the Swarm unchanged', () {
    test('reads the state and no messages', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer()..append('Hello'));
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        reads.clear();
        async.elapse(_poll);
        expect(reads.states, 1);
        expect(reads.messageReads, 0);
        async.elapse(_poll * 4);
        expect(reads.messageReads, 0);
        c.dispose();
      });
    });

    test('still shows a reply that arrived since the last poll', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        server.append('A reply');
        async.elapse(_poll);
        expect(c.messages('lead').map((m) => m.text), ['Hello', 'A reply']);
        c.dispose();
      });
    });

    test('still shows a reaction that was made since the last poll', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        final id = c.messages('lead').single.id;
        // Another reader's reaction, as the backend keeps it.
        unawaited(
          server.request(
            'POST',
            '/api/super-tabs/tab/commands',
            body: {
              'operationId': 'react-1',
              'command': {
                'type': 'message.react',
                'conversationId': 'lead',
                'messageId': id,
                'emoji': 'rocket',
                'on': true,
              },
            },
          ),
        );
        async.flushMicrotasks();
        async.elapse(_poll);
        expect(c.messages('lead').single.reactions, isNotEmpty);
        c.dispose();
      });
    });

    test(
      'keeps reading the messages while the own message awaits a receipt',
      () {
        fakeAsync((async) {
          final server = ConversationServer()..append('Hi');
          Map<String, dynamic> delivery(String status) => {
            'id': 'd1',
            'messageId': server.messages.last['id'],
            'agentId': 'agent',
            'status': status,
          };
          server.messages.last['deliveries'] = [delivery('queued')];
          final reads = _Reads(server);
          final c = _controller(reads)..start();
          async.flushMicrotasks();
          server.messages.last['deliveries'] = [delivery('answered')];
          async.elapse(_poll);
          expect(
            c.messages('lead').single.deliveries.single['status'],
            'answered',
          );
          reads.clear();
          async.elapse(_poll);
          expect(reads.messageReads, 0);
          c.dispose();
        });
      },
    );

    test('reads the messages again after a read of them failed', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        server.append('A reply');
        server.failReads = true;
        async.elapse(_poll);
        server.failReads = false;
        async.elapse(_poll);
        expect(c.messages('lead').map((m) => m.text), ['Hello', 'A reply']);
        c.dispose();
      });
    });
  });

  group('a Swarm that is not the one in front', () {
    test('is read every 15 s, not every 3 s', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer()..append('Hello'));
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        c.away = true;
        reads.clear();
        async.elapse(const Duration(seconds: 14));
        expect(reads.states, 0);
        async.elapse(const Duration(seconds: 1));
        expect(reads.states, 1);
        async.elapse(const Duration(seconds: 15));
        expect(reads.states, 2);
        c.dispose();
      });
    });

    test('is read at once when it comes to the front, then every 3 s', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer()..append('Hello'));
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        c.away = true;
        async.elapse(const Duration(seconds: 10));
        reads.clear();
        c.away = false;
        async.flushMicrotasks();
        expect(reads.states, 1);
        async.elapse(_poll * 3);
        expect(reads.states, 4);
        c.dispose();
      });
    });

    test('does not read again when it returns within one poll of a read', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer()..append('Hello'));
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        c.away = true;
        async.elapse(const Duration(seconds: 1));
        reads.clear();
        c.away = false;
        async.flushMicrotasks();
        expect(reads.states, 0);
        c.dispose();
      });
    });

    // A tag is news for the badge and a notice: a push for an away Swarm is
    // read at the old pace (the 3 s gap), not held for the idle 15 s.
    test('shows a tag the server pushes within the old 3 s gap', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        c.pushUntil = clock.now().add(kSwarmPushLease);
        c.away = true;
        async.elapse(const Duration(seconds: 1));
        expect(c.snapshot!.mentionsWaiting, 0);
        server.tag('message-2');
        c.told(main: true);
        async.elapse(const Duration(seconds: 2));
        expect(c.snapshot!.mentionsWaiting, 1);
        c.dispose();
      });
    });

    test('is read when told, within 15 s while the server pushes', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        c.pushUntil = clock.now().add(kSwarmPushLease);
        c.away = true;
        async.elapse(const Duration(seconds: 1));
        reads.clear();
        server.append('A reply');
        c.told(main: true);
        async.elapse(const Duration(seconds: 15));
        expect(c.messages('lead').last.text, 'A reply');
        expect(reads.states, 1);
        c.dispose();
      });
    });
  });
}
