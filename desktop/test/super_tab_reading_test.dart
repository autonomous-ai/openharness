import 'dart:async';

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

/// A read of the Swarm itself: its first load, or its changes since a cursor.
bool _isStateRead(String path) =>
    path == '/api/super-tabs/tab/parts' ||
    path.startsWith('/api/super-tabs/tab/changes?');

/// A poll's read of what changed since the last one.
final _changesRead = startsWith('/api/super-tabs/tab/changes?cursor=');

/// Every read the controller made, in order.
class _Reads {
  _Reads(this.server);
  final ConversationServer server;
  final paths = <String>[];
  bool machineMissing = false;

  /// How long each answer takes, as a phone on 4G waits for it.
  Duration latency = Duration.zero;

  /// While set, each state read waits for a completer added here.
  List<Completer<void>>? holdState;

  Future<Map<String, dynamic>> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) {
    if (method == 'GET') paths.add(path);
    if (machineMissing) {
      return Future.error(
        const SuperTabFailure(
          'MACHINE_UNAVAILABLE',
          'Connect one of your machines to open Swarm.',
        ),
      );
    }
    if (holdState case final held? when _isStateRead(path)) {
      final wait = Completer<void>();
      held.add(wait);
      return wait.future.then((_) => server.request(method, path, body: body));
    }
    if (latency > Duration.zero) {
      return Future.delayed(
        latency,
        () => server.request(method, path, body: body),
      );
    }
    return server.request(method, path, body: body);
  }

  int get states => paths.where(_isStateRead).length;
  int get pages => paths.where((p) => p.contains('messages?before=')).length;
  int get tails => paths.where((p) => p.contains('messages?after=')).length;
  int get receipts => paths.where((p) => p.contains('messageId=')).length;
  Iterable<String> get messageReads =>
      paths.where((p) => p.contains('/messages'));
  void clear() => paths.clear();
}

SuperTabController _controller(
  _Reads reads, {
  SuperTabReading reading = const SuperTabReading(),
  Map<String, dynamic> initial = const {},
}) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: reads.call,
  save: reads.server.save,
  initial: initial,
  reading: reading,
);

void _reply(ConversationServer server, String text) {
  server.append(text);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}

void main() {
  group('Desktop reading (the default)', () {
    test('a full read every 3 s, on screen or not, quiet or not', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        c.away = true;
        async.elapse(const Duration(seconds: 60));
        reads.clear();
        async.elapse(const Duration(seconds: 30));
        expect(reads.states, 10);
        // Nothing new: each poll reads the page again for its receipts.
        expect(reads.pages, 10);
        c.dispose();
      });
    });

    test('each poll reads the state, then the messages', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        server.holdReads = Completer<void>();
        reads.clear();
        async.elapse(const Duration(seconds: 3));
        expect(reads.paths, [_changesRead]);
        server.holdReads!.complete();
        server.holdReads = null;
        async.flushMicrotasks();
        c.dispose();
      });
    });

    test('every poll is drawn, changed or not', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads)..start();
        async.elapse(const Duration(seconds: 61));
        var notified = 0;
        c.addListener(() => notified++);
        async.elapse(const Duration(seconds: 30));
        expect(notified, greaterThanOrEqualTo(10));
        c.dispose();
      });
    });

    test('the first read waits for the state before the messages', () {
      fakeAsync((async) {
        final server = ConversationServer()
          ..append('Hello', conversationId: 'offline')
          ..holdReads = Completer<void>();
        final reads = _Reads(server);
        final c = _controller(
          reads,
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': 'offline',
          },
        )..start();
        async.flushMicrotasks();
        expect(reads.paths, ['/api/super-tabs/tab/parts']);
        server.holdReads!.complete();
        server.holdReads = null;
        async.flushMicrotasks();
        expect(reads.messageReads, [
          '/api/super-tabs/tab/conversations/offline/messages',
        ]);
        c.dispose();
      });
    });

    test('a first read with no machine shows its error at once', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer())..machineMissing = true;
        final c = _controller(reads)..start();
        async.flushMicrotasks();
        expect(c.error, 'Connect one of your machines to open Swarm.');
        expect(c.loading, isFalse);
        c.dispose();
      });
    });
  });

  group('web reading', () {
    test(
      'a quiet tab reads its state every 15 s, its new messages every 3 s',
      () {
        fakeAsync((async) {
          final server = ConversationServer()..append('Hello');
          final reads = _Reads(server);
          final c = _controller(reads, reading: _web)..start();
          async.flushMicrotasks();
          // Opening counts as the person acting: full reads for the first 30 s.
          reads.clear();
          async.elapse(const Duration(seconds: 27));
          expect(reads.states, 9);
          async.elapse(const Duration(seconds: 33));
          reads.clear();
          async.elapse(const Duration(seconds: 60));
          expect(reads.states, 4);
          expect(reads.tails, 20);
          // The page is read again only with a full read.
          expect(reads.pages, 4);
          c.dispose();
        });
      },
    );

    test(
      'a reply in the open conversation shows within 3 s of a quiet minute',
      () {
        fakeAsync((async) {
          final server = ConversationServer()..append('Hello');
          final reads = _Reads(server);
          final c = _controller(reads, reading: _web)..start();
          async.elapse(const Duration(seconds: 61));
          _reply(server, 'The plan is ready.');
          async.elapse(const Duration(seconds: 3));
          expect(c.messages('lead').last.text, 'The plan is ready.');
          // Something new: full reads every 3 s again.
          reads.clear();
          async.elapse(const Duration(seconds: 15));
          expect(reads.states, 5);
          c.dispose();
        });
      },
    );

    test('the person\'s unsettled message settles within one 3 s check', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Please start.');
        server.messages.first['deliveries'] = [
          {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'claimed'},
        ];
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 61));
        // Just after a full read: the next poll is a light check.
        do {
          reads.clear();
          async.elapse(const Duration(seconds: 3));
        } while (reads.states == 0);
        expect(
          c.messages('lead').single.deliveries.single['status'],
          'claimed',
        );
        server.messages.first['deliveries'] = [
          {'id': 'delivery', 'agentId': 'lead-agent', 'status': 'delivered'},
        ];
        reads.clear();
        async.elapse(const Duration(seconds: 3));
        expect(
          c.messages('lead').single.deliveries.single['status'],
          'delivered',
        );
        expect(reads.states, 0);
        expect(reads.pages, 0);
        expect(reads.receipts, 1);
        c.dispose();
      });
    });

    test('a light check with nothing new redraws nothing', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 61));
        do {
          reads.clear();
          async.elapse(const Duration(seconds: 3));
        } while (reads.states == 0);
        var notified = 0;
        c.addListener(() => notified++);
        // The four light checks before the next full read.
        async.elapse(const Duration(seconds: 12));
        expect(reads.tails, greaterThanOrEqualTo(5));
        expect(notified, 0);
        c.dispose();
      });
    });

    test('a reader scrolled up holding three pages below reads no newer page '
        'only to drop it', () {
      fakeAsync((async) {
        final server = ConversationServer()..messagePage = 2;
        for (final text in ['one', 'two']) {
          server.append(text);
        }
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 61));
        c.readingBack('lead', true);
        for (var i = 3; i <= 40; i++) {
          _reply(server, 'Update $i');
        }
        // Polls join three pages of two below the reader.
        async.elapse(const Duration(seconds: 30));
        expect(
          c.messages('lead').map((m) => m.sequence),
          List.generate(8, (i) => i + 1),
        );
        expect(c.hasNewer('lead'), isTrue);

        reads.clear();
        async.elapse(const Duration(seconds: 60));

        expect(reads.tails, 0);
        expect(c.messages('lead'), hasLength(8));
        expect(c.hasNewer('lead'), isTrue);
        c.dispose();
      });
    });

    test('a full read asks for new messages beside the state', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.flushMicrotasks();
        server.holdReads = Completer<void>();
        reads.clear();
        async.elapse(const Duration(seconds: 3));
        expect(reads.paths, [
          '/api/super-tabs/tab/conversations/lead/messages?after=1',
          _changesRead,
        ]);
        _reply(server, 'Done.');
        server.holdReads!.complete();
        server.holdReads = null;
        async.flushMicrotasks();
        // Its answer is used, not asked for again.
        expect(reads.tails, 1);
        c.dispose();
      });
    });

    test('a quiet full read with nothing new redraws nothing', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 61));
        var notified = 0;
        c.addListener(() => notified++);
        reads.clear();
        async.elapse(const Duration(seconds: 30));
        expect(reads.states, 2);
        expect(notified, 0);
        // What the backend works out at read time changes the state without
        // a new revision (an agent seen down, a limit that ran out): drawn.
        server.state['name'] = 'Pilot, renamed';
        reads.clear();
        do {
          async.elapse(const Duration(seconds: 3));
        } while (reads.states == 0);
        expect(notified, greaterThan(0));
        expect(c.snapshot!.name, 'Pilot, renamed');
        notified = 0;
        // A change is still drawn.
        server.append('A new line.');
        async.elapse(const Duration(seconds: 3));
        expect(notified, greaterThan(0));
        expect(c.messages('lead').last.text, 'A new line.');
        c.dispose();
      });
    });

    test('a reply shows as its messages answer, not after the state', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.flushMicrotasks();
        _reply(server, 'Done.');
        // The state answers slowly; the messages at once.
        server.holdReads = Completer<void>();
        final heldStates = <Completer<void>>[];
        reads.holdState = heldStates;
        server.holdReads!.complete();
        server.holdReads = null;
        async.elapse(const Duration(seconds: 3));
        expect(heldStates, hasLength(1));
        expect(c.messages('lead').last.text, 'Done.');
        heldStates.single.complete();
        async.flushMicrotasks();
        expect(reads.tails, 1);
        c.dispose();
      });
    });

    test('a slow answer does not stretch the 3 s poll', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server)
          ..latency = const Duration(milliseconds: 900);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 2));
        reads.clear();
        async.elapse(const Duration(seconds: 27));
        expect(reads.states, 9);
        c.dispose();
      });
    });

    test('away reads nothing; back reads at once', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 6));
        // Sent away while a poll is under way: it does not schedule another.
        server.holdReads = Completer<void>();
        async.elapse(const Duration(seconds: 3));
        c.away = true;
        server.holdReads!.complete();
        server.holdReads = null;
        async.flushMicrotasks();
        reads.clear();
        async.elapse(const Duration(minutes: 5));
        expect(reads.paths, isEmpty);
        c.away = false;
        async.flushMicrotasks();
        expect(reads.states, 1);
        reads.clear();
        async.elapse(const Duration(seconds: 15));
        expect(reads.states, 5);
        c.dispose();
      });
    });

    test('sending reads at once and keeps the full poll', () {
      fakeAsync((async) {
        final server = ConversationServer()..append('Hello');
        final reads = _Reads(server);
        final c = _controller(reads, reading: _web)..start();
        async.elapse(const Duration(seconds: 61));
        c.setDraft('lead', 'Go ahead.');
        reads.clear();
        unawaited(c.send());
        async.flushMicrotasks();
        expect(reads.states, greaterThanOrEqualTo(1));
        reads.clear();
        async.elapse(const Duration(seconds: 15));
        expect(reads.states, 5);
        c.dispose();
      });
    });

    test('the saved conversation\'s messages are read beside the state', () {
      fakeAsync((async) {
        final server = ConversationServer()
          ..append('Hello', conversationId: 'offline')
          ..holdReads = Completer<void>();
        final reads = _Reads(server);
        final c = _controller(
          reads,
          reading: _web,
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': 'offline',
          },
        )..start();
        async.flushMicrotasks();
        expect(reads.paths, [
          '/api/super-tabs/tab/conversations/offline/messages',
          '/api/super-tabs/tab/parts',
        ]);
        server.holdReads!.complete();
        server.holdReads = null;
        async.flushMicrotasks();
        expect(c.selectedId, 'offline');
        expect(c.messages('offline').single.text, 'Hello');
        // One page: the early read is the first round's.
        expect(reads.messageReads, hasLength(1));
        c.dispose();
      });
    });

    test('a saved conversation that is gone drops its early page', () {
      fakeAsync((async) {
        final server = ConversationServer()
          ..append('Hello')
          ..holdReads = Completer<void>();
        final reads = _Reads(server);
        final c = _controller(
          reads,
          reading: _web,
          initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'gone'},
        )..start();
        async.flushMicrotasks();
        server.holdReads!.complete();
        server.holdReads = null;
        async.flushMicrotasks();
        expect(c.selectedId, 'lead');
        expect(c.messages('lead').single.text, 'Hello');
        expect(c.messages('gone'), isEmpty);
        expect(
          reads.messageReads.last,
          '/api/super-tabs/tab/conversations/lead/messages',
        );
        c.dispose();
      });
    });

    test('with no machine yet it keeps loading for the grace, then errs', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer())..machineMissing = true;
        final c = _controller(reads, reading: _web)..start();
        async.flushMicrotasks();
        expect(c.error, isNull);
        expect(c.loading, isTrue);
        async.elapse(const Duration(seconds: 9));
        expect(c.error, isNull);
        expect(c.loading, isTrue);
        async.elapse(const Duration(seconds: 1));
        expect(c.error, 'Connect one of your machines to open Swarm.');
        expect(c.loading, isFalse);
        reads.machineMissing = false;
        async.elapse(const Duration(seconds: 3));
        expect(c.snapshot, isNotNull);
        expect(c.error, isNull);
        c.dispose();
      });
    });

    test('a machine connecting within the grace never shows the error', () {
      fakeAsync((async) {
        final reads = _Reads(ConversationServer())..machineMissing = true;
        final c = _controller(reads, reading: _web)..start();
        final errors = <String?>[];
        c.addListener(() => errors.add(c.error));
        async.elapse(const Duration(seconds: 4));
        reads.machineMissing = false;
        unawaited(c.machineAvailable());
        async.flushMicrotasks();
        expect(c.snapshot, isNotNull);
        async.elapse(const Duration(seconds: 10));
        expect(errors.whereType<String>(), isEmpty);
        c.dispose();
      });
    });
  });
}
