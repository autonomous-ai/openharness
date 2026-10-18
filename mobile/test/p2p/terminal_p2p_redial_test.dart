import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/p2p/terminal_p2p_plugin.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';

import 'fakes.dart';

void flush(FakeAsync async) => async.flushMicrotasks();

Map<String, dynamic> ready(String streamId, String requestId) => {
  'type': 'terminal_ready',
  'payload': {'streamId': streamId, 'requestId': requestId, 'agentId': 'a'},
};

typedef Booted = ({
  TerminalP2pPlugin plugin,
  FakeHost host,
  FakeLinkFactory links,
});

/// The first terminal starts the negotiation and rides the relay; nothing is up yet.
Booted started(FakeAsync async) {
  final b = bootPlugin(async: async, firstTerminal: false);
  b.host.sendTerminalFrame('terminal_open', {'requestId': 'r0'});
  flush(async);
  expect(b.links.created, hasLength(1));
  return b;
}

/// The channel up, with [streamA] opened over it.
Booted upWithStream(FakeAsync async) {
  final b = started(async);
  b.links.last.open();
  flush(async);
  b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
  flush(async);
  b.links.last.receive(jsonEncode(ready(streamA, 'r1')));
  flush(async);
  expect(b.plugin.linkModeFor(streamA), 'p2p');
  return b;
}

/// The next link is dialled after exactly [delay], and not a moment before.
void expectDialledAfter(FakeAsync async, Booted b, Duration delay) {
  final before = b.links.created.length;
  async.elapse(delay - const Duration(milliseconds: 1));
  expect(b.links.created, hasLength(before), reason: 'not before $delay');
  async.elapse(const Duration(milliseconds: 1));
  expect(b.links.created, hasLength(before + 1), reason: 'at $delay');
}

/// A key typed into [streamId], as the session puts it on the wire.
void type(FakeAsync async, Booted b, {String streamId = streamA}) {
  b.host.sendTerminalBinary(htrl(TerminalBinaryKind.input, streamId));
  flush(async);
}

/// A channel that was carrying terminals and went away is dialled again within seconds, not a
/// minute later, and typing on the relay meanwhile brings the wait forward: on a Galaxy S23 the
/// channel closed within a second of its streams moving onto it (2026-10-14), and everything typed
/// for the next minute crossed the relay, every keystroke about 0.4s late.
///
/// Negotiation starts with the connection's first terminal (`prepareOpen`), so every plugin here is
/// started by an open, as the app starts it.
void main() {
  group('a channel that went away', () {
    test('is dialled again at 1s, 5s and 15s, then at the minute', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('channel_closed');
        flush(async);
        expect(b.plugin.linkModeFor(streamA), 'relay');
        expectDialledAfter(async, b, const Duration(seconds: 1));
        // Each comes up and goes away again at once, as the S23's did.
        for (final delay in const [
          Duration(seconds: 5),
          Duration(seconds: 15),
          Duration(seconds: 60),
        ]) {
          b.links.last.open();
          flush(async);
          b.links.last.drop('channel_closed');
          flush(async);
          expectDialledAfter(async, b, delay);
        }
        b.plugin.dispose();
      });
    });

    test('keeps the quick pace through redials that fail to connect', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('peer_failed');
        flush(async);
        expectDialledAfter(async, b, const Duration(seconds: 1));
        for (final delay in const [
          Duration(seconds: 5),
          Duration(seconds: 15),
          Duration(seconds: 60),
        ]) {
          b.links.last.failNegotiation('negotiation_timeout');
          flush(async);
          expectDialledAfter(async, b, delay);
        }
        b.plugin.dispose();
      });
    });

    test(
      'starts its redials over once a channel had stayed up two minutes',
      () {
        fakeAsync((async) {
          final b = upWithStream(async);
          b.links.last.drop('channel_closed');
          flush(async);
          expectDialledAfter(async, b, const Duration(seconds: 1));
          b.links.last.open();
          flush(async);
          async.elapse(const Duration(minutes: 2));
          b.links.last.drop('channel_closed');
          flush(async);
          // From the first again, not the second.
          expectDialledAfter(async, b, const Duration(seconds: 1));
          b.plugin.dispose();
        });
      },
    );

    test(
      'still spends the hourly budget, and waits for it once it is spent',
      () {
        fakeAsync((async) {
          final b = upWithStream(async);
          b.links.last.drop('channel_closed');
          flush(async);
          // Ten attempts within the hour: the drop's, then nine that never connect.
          for (var attempt = 0; attempt < 9; attempt++) {
            async.elapse(const Duration(minutes: 1));
            b.links.last.failNegotiation('peer_failed');
            flush(async);
          }
          async.elapse(const Duration(minutes: 1));
          expect(b.links.created, hasLength(11));
          b.links.last.failNegotiation('peer_failed');
          flush(async);
          async.elapse(const Duration(minutes: 30));
          expect(b.links.created, hasLength(11), reason: 'budget spent');
          b.plugin.dispose();
        });
      },
    );
  });

  test('a negotiation that never connected still waits the minute', () {
    fakeAsync((async) {
      final b = started(async);
      b.links.last.failNegotiation('negotiation_timeout');
      flush(async);
      expectDialledAfter(async, b, const Duration(seconds: 60));
      b.plugin.dispose();
    });
  });

  group('typing on the relay', () {
    test('after a drop brings the waiting retry forward, once per 10s', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('channel_closed');
        flush(async);
        // The 1s redial is waiting: a key typed now does not wait for it.
        type(async, b);
        expect(b.links.created, hasLength(2));
        expect(
          b.host.wsBinary,
          hasLength(1),
          reason: 'the key itself still goes, over the relay',
        );
        b.links.last.failNegotiation('negotiation_timeout');
        flush(async);
        // The next (5s) is waiting; another key within the 10s brings nothing forward.
        async.elapse(const Duration(seconds: 2));
        type(async, b);
        expect(b.links.created, hasLength(2));
        expectDialledAfter(async, b, const Duration(seconds: 3));
        b.links.last.failNegotiation('negotiation_timeout');
        flush(async);
        // Ten seconds after the last kick, the 15s one is brought forward.
        async.elapse(const Duration(seconds: 5));
        type(async, b);
        expect(b.links.created, hasLength(4));
        b.plugin.dispose();
      });
    });

    test('a paste brings it forward too', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('channel_closed');
        flush(async);
        b.host.sendTerminalBinary(htrl(TerminalBinaryKind.paste, streamA));
        flush(async);
        expect(b.links.created, hasLength(2));
        b.plugin.dispose();
      });
    });

    test('brings nothing forward where no channel has come up', () {
      fakeAsync((async) {
        final b = started(async);
        b.links.last.failNegotiation('peer_failed');
        flush(async);
        type(async, b);
        expect(b.links.created, hasLength(1));
        expectDialledAfter(async, b, const Duration(seconds: 60));
        b.plugin.dispose();
      });
    });

    test('brings nothing forward while a negotiation is under way', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('channel_closed');
        flush(async);
        async.elapse(const Duration(seconds: 1));
        expect(b.links.created, hasLength(2));
        type(async, b);
        expect(b.links.created, hasLength(2));
        b.plugin.dispose();
      });
    });

    test('leaves the budget\'s deferral to the budget', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('channel_closed');
        flush(async);
        for (var attempt = 0; attempt < 9; attempt++) {
          async.elapse(const Duration(minutes: 1));
          b.links.last.failNegotiation('peer_failed');
          flush(async);
        }
        async.elapse(const Duration(minutes: 1));
        b.links.last.failNegotiation('peer_failed');
        flush(async);
        expect(b.links.created, hasLength(11));
        type(async, b);
        expect(b.links.created, hasLength(11));
        b.plugin.dispose();
      });
    });
  });
}
