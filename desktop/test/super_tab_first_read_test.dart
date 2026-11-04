import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machine_status.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';

/// Reads through a daemon that may still be starting: while [failure] is set, every read fails so.
class _Daemon {
  _Daemon(this.server);
  final ConversationServer server;
  Object? failure;
  int states = 0;

  Future<Map<String, dynamic>> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) {
    if (method == 'GET' &&
        (path == '/api/super-tabs/tab/parts' ||
            path.startsWith('/api/super-tabs/tab/changes?'))) {
      states++;
    }
    final failing = failure;
    if (failing != null) return Future.error(failing);
    return server.request(method, path, body: body);
  }
}

const _unreachable = SuperTabFailure(
  'BACKEND_UNREACHABLE',
  'Could not reach the Harness backend.',
  statusCode: 502,
);

SuperTabController _controller(_Daemon daemon) => SuperTabController(
  tabId: 'tab',
  accountId: 'owner',
  request: daemon.call,
  save: daemon.server.save,
  reading: SuperTabReading.desktop,
);

void main() {
  test(
    'a failed first read tries again in half a second, not at the next poll',
    () {
      fakeAsync((async) {
        final daemon = _Daemon(ConversationServer())..failure = _unreachable;
        final c = _controller(daemon)..start();
        async.flushMicrotasks();
        expect(daemon.states, 1);
        expect(c.stillConnecting, isTrue);
        daemon.failure = null;
        async.elapse(const Duration(milliseconds: 500));
        expect(daemon.states, 2);
        expect(c.snapshot, isNotNull);
        expect(c.backendUnreachable, isFalse);
        expect(c.stillConnecting, isFalse);
        expect(c.unreachableSince, isNull);
        c.dispose();
      });
    },
  );

  test('a Swarm not on screen retries as soon: it does not wait 15 s', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())..failure = _unreachable;
      final c = _controller(daemon)
        ..away = true
        ..start();
      async.flushMicrotasks();
      daemon.failure = null;
      async.elapse(const Duration(milliseconds: 500));
      expect(c.snapshot, isNotNull);
      c.dispose();
    });
  });

  test('a daemon not answering at all is retried too, with no error shown', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())
        ..failure = StateError('connection refused');
      final c = _controller(daemon)..start();
      final errors = <String?>[];
      c.addListener(() => errors.add(c.error));
      async.elapse(const Duration(seconds: 2));
      expect(daemon.states, greaterThan(1));
      expect(c.loading, isTrue);
      daemon.failure = null;
      async.elapse(const Duration(seconds: 3));
      expect(c.snapshot, isNotNull);
      expect(errors.whereType<String>(), isEmpty);
      c.dispose();
    });
  });

  test(
    'the retries end: past the grace it says what failed, and no Loading stays',
    () {
      fakeAsync((async) {
        final daemon = _Daemon(ConversationServer())..failure = _unreachable;
        final c = _controller(daemon)..start();
        async.elapse(const Duration(seconds: 11));
        expect(c.error, _unreachable.message);
        expect(c.loading, isFalse);
        expect(c.stillConnecting, isTrue);
        // Quick tries spent, it reads no faster than its poll.
        final reads = daemon.states;
        async.elapse(const Duration(seconds: 9));
        expect(daemon.states, lessThanOrEqualTo(reads + 3));
        c.dispose();
      });
    },
  );

  test('a first load that failed for good still recovers on a later poll', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())..failure = _unreachable;
      final c = _controller(daemon)..start();
      async.elapse(const Duration(seconds: 20));
      daemon.failure = null;
      async.elapse(const Duration(seconds: 3));
      expect(c.snapshot, isNotNull);
      expect(c.error, isNull);
      expect(c.backendUnreachable, isFalse);
      c.dispose();
    });
  });

  test('a machine connecting joins the read, one read not two', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())..failure = _unreachable;
      final c = _controller(daemon)..start();
      async.flushMicrotasks();
      daemon.failure = null;
      c.machineAvailable();
      async.flushMicrotasks();
      expect(c.snapshot, isNotNull);
      final reads = daemon.states;
      // The retry that was waiting finds it answered.
      async.elapse(const Duration(milliseconds: 600));
      expect(daemon.states, reads);
      c.dispose();
    });
  });

  test('access refused on the first read is final: no retry, nothing kept', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())
        ..failure = const SuperTabFailure(
          'FORBIDDEN',
          'You cannot read this Swarm.',
          statusCode: 403,
        );
      final c = _controller(daemon)..start();
      async.flushMicrotasks();
      expect(c.accessRevoked, isTrue);
      expect(c.stillConnecting, isFalse);
      final reads = daemon.states;
      daemon.failure = null;
      async.elapse(const Duration(seconds: 30));
      expect(daemon.states, reads);
      expect(c.snapshot, isNull);
      c.dispose();
    });
  });

  test('access lost while a retry waits: the retry reads nothing', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())..failure = _unreachable;
      final c = _controller(daemon)..start();
      async.flushMicrotasks();
      daemon.failure = const SuperTabFailure(
        'NOT_FOUND',
        'Gone.',
        statusCode: 404,
      );
      async.elapse(const Duration(milliseconds: 500));
      expect(c.accessRevoked, isTrue);
      final reads = daemon.states;
      daemon.failure = null;
      async.elapse(const Duration(seconds: 12));
      expect(daemon.states, reads);
      expect(c.snapshot, isNull);
      c.dispose();
    });
  });

  test('closed or signed out while a retry waits: no read lands', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())..failure = _unreachable;
      final c = _controller(daemon)..start();
      async.flushMicrotasks();
      final reads = daemon.states;
      c.dispose();
      daemon.failure = null;
      async.elapse(const Duration(seconds: 12));
      expect(daemon.states, reads);
    });
  });

  test(
    'a read that failed after a good one is reconnecting, with no quick retry',
    () {
      fakeAsync((async) {
        final daemon = _Daemon(ConversationServer());
        final c = _controller(daemon)..start();
        async.flushMicrotasks();
        expect(c.snapshot, isNotNull);
        daemon.failure = _unreachable;
        final reads = daemon.states;
        async.elapse(const Duration(seconds: 3));
        expect(c.backendUnreachable, isTrue);
        expect(c.stillConnecting, isFalse);
        expect(daemon.states, reads + 1);
        c.dispose();
      });
    },
  );

  test(
    'a read before this computer has its row waits, with no error shown',
    () {
      fakeAsync((async) {
        final daemon = _Daemon(ConversationServer())
          ..failure = const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'Connect one of your machines to open Swarm.',
          );
        final c = _controller(daemon)..start();
        final errors = <String?>[];
        c.addListener(() => errors.add(c.error));
        async.flushMicrotasks();
        expect(c.error, isNull);
        expect(c.loading, isTrue);
        expect(c.stillConnecting, isTrue);
        daemon.failure = null;
        async.elapse(const Duration(milliseconds: 500));
        expect(c.snapshot, isNotNull);
        expect(errors.whereType<String>(), isEmpty);
        c.dispose();
      });
    },
  );

  test('a computer that never gets its row says so once the grace ends', () {
    fakeAsync((async) {
      final daemon = _Daemon(ConversationServer())
        ..failure = const SuperTabFailure(
          'MACHINE_UNAVAILABLE',
          'Connect one of your machines to open Swarm.',
        );
      final c = _controller(daemon)..start();
      async.elapse(const Duration(seconds: 11));
      expect(c.error, 'Connect one of your machines to open Swarm.');
      expect(c.loading, isFalse);
      c.dispose();
    });
  });

  test(
    'a Team computer is told at once: its refusal is no passing failure',
    () {
      fakeAsync((async) {
        final daemon = _Daemon(ConversationServer())
          ..failure = const SuperTabFailure(
            'MACHINE_UNAVAILABLE',
            'This computer runs Swarm agents for a Harness Team account.',
            settled: true,
          );
        final c = _controller(daemon)..start();
        async.flushMicrotasks();
        expect(c.error, contains('Team account'));
        expect(c.loading, isFalse);
        c.dispose();
      });
    },
  );

  group('a restart refuses reads for a while (task #2647)', () {
    const refusals = [
      SuperTabFailure(
        'NOT_FOUND',
        'This Super Tab is unavailable.',
        statusCode: 404,
      ),
      SuperTabFailure(
        'FORBIDDEN',
        'You cannot read this Swarm.',
        statusCode: 403,
      ),
    ];

    test('while the list still has the Swarm, or cannot be read, it stays '
        'open with its state and name, says Reconnecting, and reads again', () {
      fakeAsync((async) {
        final server = ConversationServer()..state['name'] = 'autonomous.ai';
        final daemon = _Daemon(server);
        Object? listFailure;
        var asked = 0;
        final c = SuperTabController(
          tabId: 'tab',
          accountId: 'owner',
          request: daemon.call,
          save: server.save,
          reading: SuperTabReading.desktop,
          stillListed: () async {
            asked++;
            if (listFailure case final failure?) throw failure;
            return true;
          },
        )..start();
        async.elapse(const Duration(seconds: 1));
        expect(c.snapshot?.name, 'autonomous.ai');

        daemon.failure = _unreachable;
        async.elapse(const Duration(seconds: 4));
        expect(c.backendUnreachable, isTrue);
        expect(asked, 0, reason: 'a dropped read asks nothing');

        for (final unreadable in [true, false]) {
          listFailure = unreadable ? _unreachable : null;
          for (final refusal in refusals) {
            daemon.failure = refusal;
            async.elapse(const Duration(seconds: 4));
            final when =
                '${refusal.code}, list ${unreadable ? 'unreadable' : 'has it'}';
            expect(c.accessRevoked, isFalse, reason: when);
            expect(c.snapshot?.name, 'autonomous.ai', reason: when);
            expect(c.backendUnreachable, isTrue, reason: when);
          }
        }
        expect(asked, greaterThan(0));

        daemon.failure = null;
        async.elapse(const Duration(seconds: 4));
        expect(c.backendUnreachable, isFalse);
        expect(c.error, isNull);
        expect(c.snapshot?.name, 'autonomous.ai');
        c.dispose();
      });
    });

    test('once a list read that answered leaves it out, the refusal takes '
        'the Swarm away as before', () {
      fakeAsync((async) {
        final server = ConversationServer();
        final daemon = _Daemon(server);
        final c = SuperTabController(
          tabId: 'tab',
          accountId: 'owner',
          request: daemon.call,
          save: server.save,
          reading: SuperTabReading.desktop,
          stillListed: () async => false,
        )..start();
        async.elapse(const Duration(seconds: 1));
        expect(c.snapshot, isNotNull);
        daemon.failure = refusals.first;
        async.elapse(const Duration(seconds: 4));
        expect(c.accessRevoked, isTrue);
        expect(c.snapshot, isNull);
        final reads = daemon.states;
        async.elapse(const Duration(seconds: 30));
        expect(
          daemon.states,
          reads,
          reason: 'a Swarm taken away reads nothing',
        );
        c.dispose();
      });
    });
  });

  testWidgets('the pill says Connecting until a read has been answered', (
    tester,
  ) async {
    Widget pill({required bool connecting}) => MaterialApp(
      home: Scaffold(
        body: Center(
          child: SuperTabMachinesPill(
            connecting: connecting,
            reconnectingFor: const Duration(seconds: 4),
          ),
        ),
      ),
    );
    await tester.pumpWidget(pill(connecting: true));
    expect(find.text('Connecting · 4s'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Machines: connecting, for 4s'),
      findsOneWidget,
    );
    await tester.pumpWidget(pill(connecting: false));
    expect(find.text('Reconnecting · 4s'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Machines: reconnecting, for 4s'),
      findsOneWidget,
    );
  });
}
