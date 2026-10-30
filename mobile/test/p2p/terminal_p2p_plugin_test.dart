import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/ws/terminal_transport_plugin.dart';
import 'package:harness_mobile/p2p/terminal_p2p_link.dart';

import 'fakes.dart';

/// Every await in the plugin is over already-completed futures under a fake
/// host, so one flush of the microtask queue settles it.
void flush(FakeAsync async) => async.flushMicrotasks();

Map<String, dynamic> ready(String streamId, String requestId) => {
  'type': 'terminal_ready',
  'payload': {'streamId': streamId, 'requestId': requestId, 'agentId': 'a'},
};

Iterable<Map<String, dynamic>> p2pResults(FakeHost host) => host.sends
    .where((s) => s.$1['type'] == 'p2p_result')
    .map((s) => s.$1['payload'] as Map<String, dynamic>);

void main() {
  group('negotiation start', () {
    test('starts only with a policy and a peer that speaks v1', () {
      expect(bootPlugin(policy: null).links.created, isEmpty);
      expect(bootPlugin(peerVersion: 0).links.created, isEmpty);
      final b = bootPlugin();
      expect(b.links.created, hasLength(1));
      expect(b.links.last.started, isTrue);
      b.plugin.dispose();
    });

    test('starts on the first terminal, not when the session comes up', () {
      final b = bootPlugin(firstTerminal: false);
      expect(b.links.created, isEmpty);
      b.host.sendTerminalFrame('terminal_open', {'requestId': 'r0'});
      expect(b.links.created, hasLength(1));
      // Once only: a second open finds it started.
      b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
      expect(b.links.created, hasLength(1));
      b.plugin.dispose();
    });

    test(
      'a terminal opened before the session was up starts it once it comes up, and moves onto it',
      () {
        fakeAsync((async) {
          // A resume after a while in the background: the socket comes back and the terminal is
          // reopened before the session is ready, so its open never asked (`prepareOpen`). A Galaxy
          // S23 on 4G typed 26s over the relay like that (2026-10-19).
          final b = bootPlugin(async: async, firstTerminal: false);
          expect(b.links.created, isEmpty);
          b.host.receiveWs(ready(streamA, 'r0'));
          flush(async);
          expect(b.links.created, hasLength(1));
          expect(b.links.last.started, isTrue);
          expect(b.host.dispatched.last, linkMode(streamA, 'relay'));
          // Once only: the next terminal finds it started.
          b.host.receiveWs(ready(streamB, 'r1'));
          flush(async);
          expect(b.links.created, hasLength(1));
          // Up: the stream moves over with one resync over the channel, as any open made before
          // the channel was does.
          b.links.last.open();
          flush(async);
          expect(b.host.wsTypes, isNot(contains('terminal_resync')));
          expect(
            b.links.last.sent
                .map((f) => jsonDecode(f as String)['type'])
                .toList(),
            ['terminal_resync', 'terminal_resync'],
          );
          expect(b.plugin.linkModeFor(streamA), 'p2p');
          b.plugin.dispose();
        });
      },
    );

    test('a terminal coming up never restarts a channel that gave up', () {
      fakeAsync((async) {
        // Bringing one back is the retry's, budget and all.
        final b = bootPlugin(async: async);
        b.links.last.failNegotiation('peer_failed');
        flush(async);
        b.host.receiveWs(ready(streamA, 'r0'));
        flush(async);
        expect(b.links.created, hasLength(1));
        async.elapse(const Duration(seconds: 60));
        expect(b.links.created, hasLength(2));
        b.plugin.dispose();
      });
    });

    test('a terminal coming up starts nothing where p2p is off', () {
      fakeAsync((async) {
        for (final b in [
          bootPlugin(async: async, policy: null, firstTerminal: false),
          bootPlugin(async: async, peerVersion: 0, firstTerminal: false),
        ]) {
          b.host.receiveWs(ready(streamA, 'r0'));
          flush(async);
          expect(b.links.created, isEmpty);
          b.plugin.dispose();
        }
      });
    });

    test(
      'signals go out sealed over the socket, answers reach the link',
      () async {
        final b = bootPlugin();
        b.links.last.sendSignal('p2p_offer', {
          'sessionId': b.links.last.sessionId,
        });
        await Future<void>.delayed(Duration.zero);
        expect(b.host.sends.single.$2, TransportVia.ws);
        expect(b.host.wsTypes, ['p2p_offer']);
        expect(b.plugin.consumesInbound('p2p_answer'), isTrue);
        expect(b.plugin.consumesInbound('terminal_ready'), isFalse);
        await b.plugin.handleInbound('p2p_answer', {
          'sessionId': b.links.last.sessionId,
          'sdp': 'v=0',
        });
        expect(b.links.last.signals.single.$1, 'p2p_answer');
        b.plugin.dispose();
      },
    );

    test(
      'a failed negotiation reports, clears the link and retries after 60s',
      () {
        fakeAsync((async) {
          final b = bootPlugin(async: async);
          b.links.last.failNegotiation('negotiation_timeout');
          flush(async);
          expect(p2pResults(b.host).single['outcome'], 'timeout');
          expect(b.links.created, hasLength(1));
          async.elapse(const Duration(seconds: 60));
          expect(b.links.created, hasLength(2));
          expect(b.links.last.started, isTrue);
          b.links.last.failNegotiation('peer_failed');
          flush(async);
          expect(p2pResults(b.host).last['outcome'], 'failed');
          b.plugin.dispose();
        });
      },
    );

    test('the retry budget is ten per rolling hour', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        for (var i = 0; i < 10; i++) {
          b.links.last.failNegotiation('peer_failed');
          flush(async);
          async.elapse(const Duration(seconds: 60));
        }
        expect(b.links.created, hasLength(11));
        b.links.last.failNegotiation('peer_failed');
        flush(async);
        async.elapse(const Duration(minutes: 49));
        expect(b.links.created, hasLength(11), reason: 'budget spent');
        // The window rolls: an hour after the first attempt a slot frees up, and
        // the deferred retry takes it a minute later.
        async.elapse(const Duration(minutes: 2));
        expect(b.links.created, hasLength(12));
        b.plugin.dispose();
      });
    });

    test('kickRetry fires a pending retry at once', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        b.links.last.failNegotiation('peer_failed');
        flush(async);
        async.elapse(const Duration(seconds: 5));
        expect(b.links.created, hasLength(1));
        b.plugin.kickRetry();
        expect(b.links.created, hasLength(2));
        b.plugin.dispose();
      });
    });
  });

  group('opening a stream', () {
    test('rides the channel when it is ready', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        b.links.last.open();
        flush(async);
        b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
        flush(async);
        expect(b.links.last.sent, hasLength(1));
        expect(b.host.wsFrames, isEmpty);
        b.host.receiveWs(
          ready(streamA, 'r1'),
        ); // ready came back over the socket…
        flush(async);
        // …so the stream is NOT p2p, and the app is told relay.
        expect(b.host.dispatched.last, linkMode(streamA, 'relay'));
        expect(b.plugin.linkModeFor(streamA), 'relay');
        b.plugin.dispose();
      });
    });

    test('an open before the channel is up rides the socket at once', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        var done = false;
        b.host
            .sendTerminalFrame('terminal_open', {'requestId': 'r1'})
            .then((_) => done = true);
        flush(async);
        // No wait for the channel (`prepareOpen`), and so no
        // `open_wait_elapsed` either: nothing ran out.
        expect(done, isTrue);
        expect(b.host.wsTypes, ['terminal_open']);
        expect(p2pResults(b.host), isEmpty);
        b.plugin.dispose();
      });
    });

    test(
      'a ready over the channel marks the stream p2p, mode after the frame',
      () {
        fakeAsync((async) {
          final b = bootPlugin(async: async);
          b.links.last.open();
          flush(async);
          b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
          flush(async);
          b.links.last.receive(jsonEncode(ready(streamA, 'r1')));
          flush(async);
          expect(b.host.dispatched, [
            ready(streamA, 'r1'),
            linkMode(streamA, 'p2p'),
          ]);
          expect(b.plugin.linkModeFor(streamA), 'p2p');
          // From here the stream's frames ride the channel.
          b.host.sendTerminalFrame('terminal_alive', {'streamId': streamA});
          b.host.sendTerminalBinary(htrl(TerminalBinaryKind.input, streamA));
          flush(async);
          expect(b.links.last.sent, hasLength(3));
          expect(b.host.wsFrames, isEmpty);
          expect(b.host.wsBinary, isEmpty);
          // Another stream's frames do not.
          b.host.sendTerminalFrame('terminal_alive', {'streamId': streamB});
          flush(async);
          expect(b.host.wsTypes, ['terminal_alive']);
          b.plugin.dispose();
        });
      },
    );

    test('a TURN pair reports as turn', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        b.links.last.open(transport: TerminalP2pTransport.relay);
        flush(async);
        expect(p2pResults(b.host).single, {
          'outcome': 'direct',
          'setupMs': 420,
          'reason': 'relayed',
        });
        b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
        flush(async);
        b.links.last.receive(jsonEncode(ready(streamA, 'r1')));
        flush(async);
        expect(b.host.dispatched.last, linkMode(streamA, 'turn'));
        b.plugin.dispose();
      });
    });

    test('closing a stream forgets it', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        b.links.last.open();
        flush(async);
        b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
        flush(async);
        b.links.last.receive(jsonEncode(ready(streamA, 'r1')));
        flush(async);
        b.host.sendTerminalFrame('terminal_close', {'streamId': streamA});
        flush(async);
        expect(b.plugin.linkModeFor(streamA), 'relay');
        b.plugin.dispose();
      });
    });

    test('channel frames of unexpected shape are dropped', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        b.links.last.open();
        flush(async);
        b.links.last.receive('not json');
        b.links.last.receive(
          jsonEncode({'type': 'agent_synced', 'payload': {}}),
        );
        b.links.last.receive(htrl(TerminalBinaryKind.input, streamA));
        b.links.last.receive(htrl(TerminalBinaryKind.output, streamA));
        flush(async);
        expect(b.host.dispatched, isEmpty);
        expect(b.host.delivered, hasLength(1));
        b.plugin.dispose();
      });
    });
  });

  group('demotion', () {
    ({FakeHost host, FakeLinkFactory links, dynamic plugin}) upWithStream(
      FakeAsync async,
    ) {
      final b = bootPlugin(async: async);
      b.links.last.open();
      flush(async);
      b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
      flush(async);
      b.links.last.receive(jsonEncode(ready(streamA, 'r1')));
      flush(async);
      b.host.dispatched.clear();
      b.host.sends.clear();
      return (host: b.host, links: b.links, plugin: b.plugin);
    }

    test('the wire going away resyncs every stream over the socket', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.drop('peer_disconnected_timeout');
        flush(async);
        expect(b.host.dispatched, [linkMode(streamA, 'relay')]);
        final resync = b.host.sends.firstWhere(
          (s) => s.$1['type'] == 'terminal_resync',
        );
        expect(resync.$2, TransportVia.ws);
        expect(b.host.wsTypes, contains('terminal_resync'));
        expect(p2pResults(b.host).single, {
          'outcome': 'dropped',
          'reason': 'peer_disconnected_timeout',
        });
        expect(b.plugin.linkModeFor(streamA), 'relay');
        // The retry comes a minute later.
        async.elapse(const Duration(seconds: 60));
        expect(b.links.created, hasLength(2));
        b.plugin.dispose();
      });
    });

    test('a send the channel refuses falls to the socket and demotes', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.links.last.acceptSends = false;
        b.host.sendTerminalFrame('terminal_alive', {'streamId': streamA});
        flush(async);
        expect(b.host.wsTypes.first, 'terminal_alive');
        expect(b.links.last.stopReason, 'send_failed');
        expect(b.host.dispatched, [linkMode(streamA, 'relay')]);
        b.plugin.dispose();
      });
    });

    test('output for a p2p stream arriving over the socket demotes', () {
      fakeAsync((async) {
        final b = upWithStream(async);
        b.host.receiveWsBinary(htrl(TerminalBinaryKind.output, streamA));
        flush(async);
        expect(b.links.last.stopReason, 'relay_binary_received');
        expect(b.host.delivered, hasLength(1), reason: 'still delivered');
        b.plugin.dispose();
      });
    });

    test(
      'a json frame for a p2p stream over the socket demotes that stream only',
      () {
        fakeAsync((async) {
          final b = upWithStream(async);
          b.host.receiveWs({
            'type': 'terminal_error',
            'payload': {'streamId': streamA, 'code': 'X'},
          });
          flush(async);
          expect(b.host.dispatched.last, linkMode(streamA, 'relay'));
          expect(
            b.links.last.stopped,
            isFalse,
            reason: 'the channel itself lives on',
          );
          b.plugin.dispose();
        });
      },
    );
  });

  group('live migration', () {
    test(
      'a stream opened on the socket moves to the channel with one resync, over the channel',
      () {
        fakeAsync((async) {
          final b = bootPlugin(async: async);
          // Open before the channel is ready → socket.
          b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
          async.elapse(const Duration(milliseconds: 1500));
          flush(async);
          b.host.receiveWs(ready(streamA, 'r1'));
          flush(async);
          expect(b.host.dispatched.last, linkMode(streamA, 'relay'));
          b.host.sends.clear();
          b.host.wsFrames.clear();

          // The channel opens → ONE resync, over the channel itself. A first one over the
          // socket cost a relay round trip and one more keyframe (iPhone 14, 2026-10-19).
          b.links.last.open();
          flush(async);
          expect(b.host.wsTypes, isNot(contains('terminal_resync')));
          expect(b.links.last.sent, hasLength(1));
          expect(
            jsonDecode(b.links.last.sent.single as String)['type'],
            'terminal_resync',
          );
          expect(b.plugin.linkModeFor(streamA), 'p2p');
          // The stream's own frames take the channel from now on.
          b.host.sendTerminalBinary(htrl(TerminalBinaryKind.input, streamA));
          flush(async);
          expect(b.host.wsBinary, isEmpty);
          expect(b.links.last.sent, hasLength(2));
          // Relay output still on its way, a keyframe included, is not a broken channel —
          // and does not start the move over.
          b.host.receiveWsBinary(htrl(TerminalBinaryKind.output, streamA));
          b.host.receiveWsBinary(htrl(TerminalBinaryKind.keyframe, streamA));
          flush(async);
          expect(b.links.last.stopped, isFalse);
          expect(b.links.last.sent, hasLength(2), reason: 'no second resync');
          // A channel-delivered frame proves the flip and re-arms the ordinary rule.
          b.links.last.receive(htrl(TerminalBinaryKind.output, streamA));
          flush(async);
          b.host.receiveWsBinary(htrl(TerminalBinaryKind.output, streamA));
          flush(async);
          expect(b.links.last.stopReason, 'relay_binary_received');
          b.plugin.dispose();
        });
      },
    );

    test(
      'a stream that comes up on the socket after the channel moves at its first keyframe',
      () {
        fakeAsync((async) {
          final b = bootPlugin(async: async);
          // Opened before the channel was up, answered after it came up.
          b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
          flush(async);
          b.links.last.open();
          flush(async);
          b.host.receiveWs(ready(streamA, 'r1'));
          flush(async);
          expect(
            b.links.last.sent,
            isEmpty,
            reason: 'not while the open\'s own keyframe is being taken',
          );
          b.host.wsFrames.clear();
          b.host.receiveWsBinary(htrl(TerminalBinaryKind.keyframe, streamA));
          flush(async);
          expect(b.host.wsTypes, isNot(contains('terminal_resync')));
          expect(
            b.links.last.sent.map(
              (frame) => jsonDecode(frame as String)['type'],
            ),
            ['terminal_resync'],
          );
          expect(b.plugin.linkModeFor(streamA), 'p2p');
          b.plugin.dispose();
        });
      },
    );

    test(
      'a move nobody answers is swept after 30s, and the ordinary rule applies again',
      () {
        fakeAsync((async) {
          final b = bootPlugin(async: async);
          b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
          async.elapse(const Duration(milliseconds: 1500));
          flush(async);
          b.host.receiveWs(ready(streamA, 'r1'));
          flush(async);
          b.links.last.open();
          flush(async);
          // In flight: relay output is the responder not having flipped yet.
          b.host.receiveWsBinary(htrl(TerminalBinaryKind.output, streamA));
          flush(async);
          expect(b.links.last.stopped, isFalse);
          async.elapse(const Duration(seconds: 41));
          // Swept: the channel took the resync and never carried the stream — broken, so the
          // next relay frame demotes it, which resyncs every stream over the socket.
          b.host.receiveWsBinary(htrl(TerminalBinaryKind.output, streamA));
          flush(async);
          expect(b.links.last.stopReason, 'relay_binary_received');
          expect(b.host.wsTypes, contains('terminal_resync'));
          b.plugin.dispose();
        });
      },
    );

    test('a move the channel refuses abandons only that stream', () {
      fakeAsync((async) {
        final b = bootPlugin(async: async);
        b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
        async.elapse(const Duration(milliseconds: 1500));
        flush(async);
        b.host.receiveWs(ready(streamA, 'r1'));
        flush(async);
        b.host.wsFrames.clear();
        b.links.last.acceptSends = false;
        b.links.last.open();
        flush(async);
        expect(
          b.host.wsTypes,
          isNot(contains('terminal_resync')),
          reason: 'never falls back to the socket',
        );
        expect(b.links.last.stopped, isFalse);
        expect(b.plugin.linkModeFor(streamA), 'relay');
        // Its relay output is just its output.
        b.host.receiveWsBinary(htrl(TerminalBinaryKind.output, streamA));
        flush(async);
        expect(b.links.last.stopped, isFalse);
        b.plugin.dispose();
      });
    });
  });

  group('turn → direct upgrade', () {
    ({FakeHost host, FakeLinkFactory links, dynamic plugin}) onTurn(
      FakeAsync async,
    ) {
      final b = bootPlugin(async: async);
      b.links.last.open(transport: TerminalP2pTransport.relay);
      flush(async);
      b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
      flush(async);
      b.links.last.receive(jsonEncode(ready(streamA, 'r1')));
      flush(async);
      b.host.sends.clear();
      b.host.dispatched.clear();
      return (host: b.host, links: b.links, plugin: b.plugin);
    }

    test('a shadow that lands direct is promoted after a drain and an ack', () {
      fakeAsync((async) {
        final b = onTurn(async);
        final primary = b.links.last;
        async.elapse(const Duration(seconds: 60));
        expect(b.links.created, hasLength(2));
        final shadow = b.links.last;
        expect(shadow.upgrade, isTrue);
        expect(shadow.started, isTrue);
        shadow.open();
        flush(async);
        // Phase 1: a drain resync over the OLD connection; nothing routes yet.
        expect(
          jsonDecode(primary.sent.last as String)['type'],
          'terminal_resync',
        );
        expect(shadow.sent, isEmpty);
        primary.receive(htrl(TerminalBinaryKind.keyframe, streamA));
        flush(async);
        // Phase 2: the cutover — resync and promote go out, the ack closes the old.
        expect(
          jsonDecode(shadow.sent.single as String)['type'],
          'terminal_resync',
        );
        final promote = b.host.sends.firstWhere(
          (s) => s.$1['type'] == 'p2p_promote',
        );
        expect((promote.$1['payload'] as Map)['sessionId'], shadow.sessionId);
        expect(primary.stopped, isFalse);
        b.plugin.handleInbound('p2p_promote_ack', {
          'sessionId': shadow.sessionId,
        });
        flush(async);
        expect(primary.stopReason, 'upgraded');
        expect(primary.stopNotifiedPeer, isFalse);
        expect(b.plugin.linkModeFor(streamA), 'p2p');
        expect(b.host.dispatched.last, linkMode(streamA, 'p2p'));
        // Traffic now rides the shadow.
        b.host.sendTerminalFrame('terminal_alive', {'streamId': streamA});
        flush(async);
        expect(shadow.sent, hasLength(2));
        b.plugin.dispose();
      });
    });

    test('a shadow that also lands on turn is abandoned; three quick tries, then slow', () {
      fakeAsync((async) {
        final b = onTurn(async);
        for (var attempt = 1; attempt <= 3; attempt++) {
          async.elapse(const Duration(seconds: 60));
          expect(b.links.created, hasLength(1 + attempt));
          b.links.last.open(transport: TerminalP2pTransport.relay);
          flush(async);
          expect(b.links.last.stopReason, 'upgrade_no_gain');
        }
        async.elapse(const Duration(minutes: 5));
        expect(b.links.created, hasLength(4), reason: 'slowed down, not yet');
        async.elapse(const Duration(minutes: 10));
        expect(b.links.created, hasLength(5), reason: 'every 15 min from now');
        expect(b.links.last.upgrade, isTrue);
        expect(b.links.first.stopped, isFalse);
        b.plugin.dispose();
      });
    });

    test('a demotion gives the next link a fresh upgrade budget', () {
      fakeAsync((async) {
        final b = onTurn(async);
        for (var attempt = 1; attempt <= 3; attempt++) {
          async.elapse(const Duration(seconds: 60));
          b.links.last.open(transport: TerminalP2pTransport.relay);
          flush(async);
        }
        // The primary dies; the retry lands on TURN again.
        b.links.first.drop('peer_failed');
        flush(async);
        async.elapse(const Duration(seconds: 60));
        final second = b.links.last;
        expect(second.upgrade, isFalse);
        second.open(transport: TerminalP2pTransport.relay);
        flush(async);
        // Quick attempts again, not the slow pace.
        async.elapse(const Duration(seconds: 60));
        expect(b.links.last.upgrade, isTrue);
        expect(b.links.last, isNot(second));
        b.plugin.dispose();
      });
    });

    test('coming back to the foreground on turn tries an upgrade at once', () {
      fakeAsync((async) {
        final b = onTurn(async);
        async.elapse(const Duration(seconds: 5));
        expect(b.links.created, hasLength(1));
        b.plugin.kickRetry();
        expect(b.links.created, hasLength(2));
        expect(b.links.last.upgrade, isTrue);
        // Not twice while that trial is still running.
        b.plugin.kickRetry();
        expect(b.links.created, hasLength(2));
        b.plugin.dispose();
      });
    });

    test(
      'an unanswered promote keeps the old connection open as an orphan',
      () {
        fakeAsync((async) {
          final b = onTurn(async);
          final primary = b.links.last;
          async.elapse(const Duration(seconds: 60));
          final shadow = b.links.last;
          shadow.open();
          flush(async);
          primary.receive(htrl(TerminalBinaryKind.keyframe, streamA));
          flush(async);
          async.elapse(const Duration(seconds: 5));
          expect(primary.stopped, isFalse);
          // The promoted shadow dying takes the orphan with it.
          shadow.drop('peer_failed');
          flush(async);
          expect(primary.stopReason, 'primary_demoted');
          b.plugin.dispose();
          expect(shadow.stopped, isTrue);
        });
      },
    );

    test('a primary demotion cancels the trial', () {
      fakeAsync((async) {
        final b = onTurn(async);
        async.elapse(const Duration(seconds: 60));
        final shadow = b.links.last;
        b.links.first.drop('peer_failed');
        flush(async);
        expect(shadow.stopReason, 'primary_demoted');
        b.plugin.dispose();
      });
    });
  });

  test('dispose stops everything without telling the peer', () {
    fakeAsync((async) {
      final b = bootPlugin(async: async);
      b.links.last.open();
      flush(async);
      b.plugin.dispose();
      expect(b.links.last.stopNotifiedPeer, isFalse);
      expect(b.links.last.stopReason, 'relay_closed');
      // Nothing fires afterwards.
      async.elapse(const Duration(hours: 1));
      expect(b.links.created, hasLength(1));
    });
  });
}
