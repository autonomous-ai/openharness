import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/p2p/terminal_p2p_link.dart';
import 'package:harness_mobile/p2p/terminal_p2p_policy.dart';
import 'package:harness_mobile/p2p/webrtc_terminal_p2p_link.dart';

import 'fake_webrtc.dart';

/// The offerer side of the `terminal-v1` channel over flutter_webrtc, against a native side the
/// test plays: what it offers, what it does with the machine's answer and candidates, how it
/// reports the channel, and how it dies.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeWebRtc webrtc;
  late LinkLog log;

  setUp(() {
    webrtc = FakeWebRtc();
    log = LinkLog();
  });
  tearDown(() => webrtc.dispose());

  const turn = TerminalP2pTurn(
    urls: ['turn:turn.example:3478?transport=udp'],
    username: 'u',
    credential: 'c',
  );
  const policy = TerminalP2pPolicy(
    stunUrls: ['stun:stun.example:3478'],
    openWaitMs: 1500,
    turn: turn,
  );

  WebRtcTerminalP2pLink newLink({
    bool upgrade = false,
    TerminalP2pPolicy p = policy,
  }) {
    final link = const WebRtcTerminalP2pLinkFactory().create(
      policy: p,
      sendSignal: log.signal,
      onData: log.data.add,
      onState: log.state,
      onUnavailable: log.unavailable.add,
      onStep: (step, _) => log.steps.add(step),
      upgrade: upgrade,
    ) as WebRtcTerminalP2pLink;
    addTearDown(() => link.stop(notifyPeer: false));
    return link;
  }

  /// A link whose offer has gone out.
  Future<WebRtcTerminalP2pLink> offered({bool upgrade = false}) async {
    final link = newLink(upgrade: upgrade);
    link.start();
    await eventually(() => webrtc.named('setLocalDescription').isNotEmpty);
    await settle();
    await webrtc.iceGathering('complete');
    expect(await eventually(() => log.of('p2p_offer').isNotEmpty), isTrue);
    return link;
  }

  Map<String, dynamic> signal(
    WebRtcTerminalP2pLink link, [
    Map<String, dynamic> extra = const {},
  ]) => {
    'sessionId': link.sessionId,
    'protocolVersion': terminalP2pProtocolVersion,
    ...extra,
  };

  /// A link whose channel is open, on the pair the stats describe.
  Future<WebRtcTerminalP2pLink> open({
    String local = 'host',
    String remote = 'srflx',
  }) async {
    final link = await offered();
    await link.handleSignal('p2p_answer', signal(link, {'sdp': 'v=0 answer'}));
    webrtc.stats = statsFor(local: local, remote: remote);
    await webrtc.channelState('open');
    await log.opened.timeout(const Duration(seconds: 3));
    return link;
  }

  group('the offer', () {
    test('goes out with every server, the raised message size, and nothing secret in the clear', () async {
      final link = await offered();
      final config =
          webrtc.named('createPeerConnection').single.arguments['configuration']
              as Map;
      expect(config['iceServers'], [
        {
          'urls': ['stun:stun.example:3478'],
        },
        {
          'urls': ['turn:turn.example:3478?transport=udp'],
          'username': 'u',
          'credential': 'c',
        },
      ]);
      expect(config['sdpSemantics'], 'unified-plan');
      expect(config.containsKey('iceTransportPolicy'), isFalse);
      final channel = webrtc.named('createDataChannel').single.arguments as Map;
      expect(channel['label'], terminalP2pChannel);
      expect((channel['dataChannelDict'] as Map)['ordered'], isTrue);

      final offer = log.of('p2p_offer').single;
      expect(offer['sessionId'], link.sessionId);
      expect(
        link.sessionId,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
      expect(offer['protocolVersion'], terminalP2pProtocolVersion);
      expect(offer['sdp'], contains('a=max-message-size:524288\r\n'));
      expect(offer['stunUrls'], ['stun:stun.example:3478']);
      expect(offer['turn'], turn.toJson());
      expect(offer.containsKey('upgrade'), isFalse);
      expect(log.states.first, 'connecting');
      expect(
        log.steps,
        containsAllInOrder(['offer-created', 'gathered', 'offer-sent']),
      );
      expect(link.isReady, isFalse);
      expect(link.transport, isNull);
    });

    test(
      'an upgrade trial says so, and a policy with no servers offers none',
      () async {
        final link = newLink(
          upgrade: true,
          p: const TerminalP2pPolicy(stunUrls: [], openWaitMs: 10),
        );
        link.start();
        link.start(); // once is enough
        await eventually(() => webrtc.named('setLocalDescription').isNotEmpty);
        await settle();
        await webrtc.iceGathering('complete');
        expect(await eventually(() => log.of('p2p_offer').isNotEmpty), isTrue);
        final offer = log.of('p2p_offer').single;
        expect(offer['upgrade'], isTrue);
        expect(offer.containsKey('turn'), isFalse);
        expect(
          (webrtc
                  .named('createPeerConnection')
                  .single
                  .arguments['configuration']
              as Map)['iceServers'],
          isEmpty,
        );
        expect(webrtc.named('createPeerConnection'), hasLength(1));
      },
    );

    test('a reflexive candidate is enough to go, a moment later', () async {
      final link = newLink();
      link.start();
      await eventually(() => webrtc.named('setLocalDescription').isNotEmpty);
      await settle();
      await webrtc.candidate(
        'candidate:2 1 udp 1686052607 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0',
      );
      expect(
        await eventually(
          () => log.of('p2p_offer').isNotEmpty,
          within: const Duration(seconds: 2),
        ),
        isTrue,
      );
      expect(log.steps, contains('gathered-enough'));
      expect(link.isReady, isFalse);
    });

    test('with nothing reflexive, it goes at the cap anyway', () async {
      final link = newLink();
      link.start();
      expect(
        await eventually(
          () => log.of('p2p_offer').isNotEmpty,
          within: const Duration(seconds: 5),
        ),
        isTrue,
      );
      expect(log.steps, contains('gather-capped'));
      expect(link.isReady, isFalse);
    }, timeout: const Timeout(Duration(seconds: 15)));

    test(
      'a peer connection that cannot be made fails the link, and says so',
      () async {
        webrtc.failing.add('createPeerConnection');
        final link = newLink();
        link.start();
        expect(
          await eventually(() => log.states.contains('failed:offer_failed')),
          isTrue,
        );
        expect(
          await eventually(() => log.states.contains('closed:offer_failed')),
          isTrue,
        );
        expect(log.unavailable, isEmpty, reason: 'it was never usable');
        expect(await link.waitUntilReady(const Duration(seconds: 1)), isFalse);
        link.start();
        expect(
          webrtc.named('createPeerConnection'),
          hasLength(1),
          reason: 'a finished link stays finished',
        );
      },
    );

    test('an offer with no local description fails the link', () async {
      webrtc.localSdp = '';
      final link = newLink();
      link.start();
      await eventually(() => webrtc.named('setLocalDescription').isNotEmpty);
      await settle();
      await webrtc.iceGathering('complete');
      expect(
        await eventually(() => log.states.contains('failed:offer_failed')),
        isTrue,
      );
      expect(link.isReady, isFalse);
    });
  });

  group('the machine\'s signals', () {
    test('are only its own session\'s, at its own version', () async {
      final link = await offered();
      expect(await link.handleSignal('terminal_output', {}), isFalse);
      expect(
        await link.handleSignal('p2p_answer', {
          'sessionId': 'other',
          'protocolVersion': 1,
          'sdp': 'x',
        }),
        isTrue,
      );
      expect(
        await link.handleSignal('p2p_answer', {
          ...signal(link),
          'protocolVersion': 2,
          'sdp': 'x',
        }),
        isTrue,
      );
      expect(
        await link.handleSignal('p2p_answer', signal(link, {'sdp': 7})),
        isTrue,
      );
      expect(webrtc.named('setRemoteDescription'), isEmpty);
    });

    test(
      'candidates found before the answer wait for it; after it they trickle',
      () async {
        final link = await offered();
        await webrtc.candidate(
          'candidate:9 1 udp 1 198.51.100.7 50002 typ relay raddr 0.0.0.0 rport 0',
        );
        // One already inside the offer is never sent again.
        await webrtc.candidate(
          'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host',
        );
        await settle();
        expect(log.of('p2p_ice_candidate'), isEmpty);

        await link.handleSignal(
          'p2p_answer',
          signal(link, {'sdp': 'v=0 answer'}),
        );
        expect(
          (webrtc.named('setRemoteDescription').single.arguments['description']
              as Map)['type'],
          'answer',
        );
        expect(
          log.of('p2p_ice_candidate').single['candidate']['candidate'],
          contains('typ relay'),
        );

        await webrtc.candidate(
          'candidate:10 1 udp 1 198.51.100.8 50003 typ host',
          mid: '0',
          index: 0,
        );
        expect(
          await eventually(() => log.of('p2p_ice_candidate').length == 2),
          isTrue,
        );
        expect(log.of('p2p_ice_candidate').last['candidate'], {
          'candidate': 'candidate:10 1 udp 1 198.51.100.8 50003 typ host',
          'sdpMid': '0',
          'sdpMLineIndex': 0,
        });
        expect(log.steps, contains('answer-in'));
      },
    );

    test(
      'the machine\'s candidates are added; a malformed one is not',
      () async {
        final link = await offered();
        await link.handleSignal(
          'p2p_ice_candidate',
          signal(link, {
            'candidate': {
              'candidate': 'candidate:3 1 udp 1 203.0.113.1 4000 typ host',
              'sdpMid': '0',
              'sdpMLineIndex': 0,
            },
          }),
        );
        await link.handleSignal(
          'p2p_ice_candidate',
          signal(link, {'candidate': 'not a map'}),
        );
        await link.handleSignal(
          'p2p_ice_candidate',
          signal(link, {
            'candidate': {'candidate': 7},
          }),
        );
        expect(webrtc.named('addCandidate'), hasLength(1));
      },
    );

    test('an answer the native side refuses fails the link', () async {
      webrtc.failing.add('setRemoteDescription');
      final link = await offered();
      await link.handleSignal('p2p_answer', signal(link, {'sdp': 'garbage'}));
      expect(
        await eventually(() => log.states.contains('failed:signal_invalid')),
        isTrue,
      );
      expect(log.of('p2p_abort').single['reason'], 'signal_invalid');
    });

    test('an abort ends it with the peer\'s reason, bounded', () async {
      final link = await offered();
      await link.handleSignal('p2p_abort', signal(link, {'reason': 'x' * 100}));
      expect(log.states, contains('failed:${'x' * 64}'));
      final link2 = await offered();
      await link2.handleSignal('p2p_abort', signal(link2, {}));
      expect(log.states, contains('failed:peer_aborted'));
    });

    test('nothing is acted on once the link has stopped', () async {
      final link = await offered();
      await link.stop();
      expect(log.of('p2p_abort').single['reason'], 'closed');
      expect(
        await link.handleSignal('p2p_answer', signal(link, {'sdp': 'x'})),
        isTrue,
      );
      expect(webrtc.named('setRemoteDescription'), isEmpty);
      await link.stop();
      expect(log.of('p2p_abort'), hasLength(1));
    });
  });

  group('the channel', () {
    test('open on a direct pair: ready, and says so', () async {
      final link = await open();
      expect(link.isReady, isTrue);
      expect(link.transport, TerminalP2pTransport.direct);
      expect(log.states.last, 'open');
      expect(await link.waitUntilReady(Duration.zero), isTrue);
    });

    test('open through TURN on either end reads as relay', () async {
      final link = await open(local: 'srflx', remote: 'relay');
      expect(link.transport, TerminalP2pTransport.relay);
    });

    test('a pair read from the nominated candidate pair when no transport names one', () async {
      final link = await offered();
      webrtc.stats = statsFor(
        local: 'relay',
        remote: 'host',
        viaTransport: false,
      );
      await webrtc.channelState('open');
      await log.opened.timeout(const Duration(seconds: 3));
      expect(link.transport, TerminalP2pTransport.relay);
    });

    test('stats it cannot read leave the transport unknown, the channel still open', () async {
      webrtc.failing.add('getStats');
      final link = await offered();
      await webrtc.channelState('open');
      await log.opened.timeout(const Duration(seconds: 3));
      expect(link.isReady, isTrue);
      expect(link.transport, isNull);
      webrtc.failing.remove('getStats');
      webrtc.stats = [];
      final other = await offered();
      await webrtc.channelState('open');
      await eventually(() => other.isReady);
      expect(other.transport, isNull);
    });

    test(
      'a waiter is told the moment it opens, or when its time is up',
      () async {
        final link = await offered();
        final late = link.waitUntilReady(const Duration(milliseconds: 20));
        final waiting = link.waitUntilReady(const Duration(seconds: 3));
        expect(await late, isFalse);
        webrtc.stats = statsFor(local: 'host', remote: 'host');
        await webrtc.channelState('open');
        expect(await waiting, isTrue);
      },
    );

    test(
      'text and binary go out as themselves, and come in as themselves',
      () async {
        final link = await open();
        expect(link.send('{"type":"terminal_input"}'), isTrue);
        expect(link.send(Uint8List.fromList([1, 2, 3])), isTrue);
        await settle();
        final sends = webrtc.named('dataChannelSend').toList();
        expect(sends[0].arguments['type'], 'text');
        expect(sends[0].arguments['data'], '{"type":"terminal_input"}');
        expect(sends[1].arguments['type'], 'binary');
        expect(sends[1].arguments['data'], [1, 2, 3]);

        await webrtc.message('{"type":"terminal_output"}');
        await webrtc.message([4, 5]);
        expect(await eventually(() => log.data.length == 2), isTrue);
        expect(log.data[0], '{"type":"terminal_output"}');
        expect(log.data[1], [4, 5]);
      },
    );

    test('nothing is sent before it opens', () async {
      final link = await offered();
      expect(link.send('x'), isFalse);
      expect(await link.sendWithBackpressureRetry('x'), isFalse);
    });

    test(
      'a send the native side refuses fails the link after the fact',
      () async {
        webrtc.failing.add('dataChannelSend');
        final link = await open();
        expect(
          link.send('x'),
          isTrue,
          reason: 'the refusal lands after this has answered',
        );
        expect(
          await eventually(() => log.states.contains('failed:send_failed')),
          isTrue,
        );
        expect(log.unavailable, ['send_failed']);
        expect(link.isReady, isFalse);
      },
    );

    test('a backed-up channel gets one bounded chance to drain', () async {
      final link = await open();
      // Past the ceiling as the native side last reported it: sends are refused.
      await webrtc.buffered(terminalP2pMaxBufferedBytes + 1);
      expect(link.isReady, isFalse);
      // The cached figure only moves on a native event: asked fresh, it has drained already.
      webrtc.bufferedAmount = 0;
      expect(await link.sendWithBackpressureRetry('x'), isTrue);
      expect(link.isReady, isTrue);
      await webrtc.buffered(terminalP2pMaxBufferedBytes + 1);

      webrtc.bufferedAmount = terminalP2pMaxBufferedBytes + 1;
      final retry = link.sendWithBackpressureRetry(
        'y',
        drain: const Duration(seconds: 2),
      );
      await settle();
      await webrtc.buffered(10);
      expect(await retry, isTrue);

      webrtc.bufferedAmount = terminalP2pMaxBufferedBytes + 1;
      await webrtc.buffered(terminalP2pMaxBufferedBytes + 1);
      expect(
        await link.sendWithBackpressureRetry(
          'z',
          drain: const Duration(milliseconds: 30),
        ),
        isFalse,
        reason: 'never drained',
      );
      webrtc.failing.add('dataChannelGetBufferedAmount');
      expect(await link.sendWithBackpressureRetry('z'), isFalse);
    });

    test('the channel closing under an open link fails it', () async {
      final link = await open();
      await webrtc.channelState('closing');
      expect(
        await eventually(() => log.states.contains('failed:channel_closed')),
        isTrue,
      );
      expect(log.unavailable, ['channel_closed']);
      expect(link.isReady, isFalse);
    });
  });

  group('the connection', () {
    test('failing fails the link', () async {
      final link = await open();
      await webrtc.connection('failed');
      expect(
        await eventually(() => log.states.contains('failed:peer_failed')),
        isTrue,
      );
      expect(log.unavailable, ['peer_failed']);
      expect(link.negotiationDetail, startsWith('answer=yes'));
    });

    test('a disconnect that heals within the grace is nothing', () async {
      final link = await open();
      await webrtc.connection('disconnected');
      await webrtc.connection('disconnected');
      await webrtc.connection('connected');
      await settle(
        terminalP2pDisconnectGrace + const Duration(milliseconds: 200),
      );
      expect(link.isReady, isTrue);
      expect(log.unavailable, isEmpty);
    }, timeout: const Timeout(Duration(seconds: 15)));

    test('a disconnect that outlasts the grace fails it', () async {
      final link = await open();
      await webrtc.connection('disconnected');
      await settle(
        terminalP2pDisconnectGrace + const Duration(milliseconds: 200),
      );
      expect(log.unavailable, ['peer_disconnected_timeout']);
      expect(link.isReady, isFalse);
    }, timeout: const Timeout(Duration(seconds: 15)));

    test('stopping takes down the channel and the peer connection', () async {
      final link = await open();
      await link.stop(reason: 'relay_closed', notifyPeer: false);
      expect(log.of('p2p_abort'), isEmpty);
      expect(webrtc.named('dataChannelClose'), hasLength(1));
      expect(webrtc.named('peerConnectionDispose'), hasLength(1));
      expect(log.states.last, 'closed:relay_closed');
      expect(link.send('x'), isFalse);
      expect(link.negotiationDetail, 'answer=yes ice=-');
    });

    test('a native side that fails to close does not stop the stop', () async {
      webrtc.failing.addAll({'dataChannelClose', 'peerConnectionDispose'});
      final link = await open();
      await link.stop();
      expect(log.states.last, 'closed:closed');
    });
  });

  group('helpers', () {
    test('a pair is relayed if either end is', () {
      expect(isRelayedPair('relay', 'host'), isTrue);
      expect(isRelayedPair('host', 'relay'), isTrue);
      expect(isRelayedPair('srflx', 'host'), isFalse);
      expect(isRelayedPair(null, null), isFalse);
    });

    test('binary of any list shape becomes bytes; anything else, none', () {
      final bytes = Uint8List.fromList([1]);
      expect(asBytes(bytes), same(bytes));
      expect(asBytes(<int>[2, 3]), [2, 3]);
      expect(asBytes('text'), isEmpty);
    });
  });
}
