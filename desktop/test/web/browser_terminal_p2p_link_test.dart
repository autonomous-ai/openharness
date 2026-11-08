@TestOn('browser')
library;

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/p2p/browser_terminal_p2p_link.dart';
import 'package:harness/web/p2p/p2p_sdp.dart';
import 'package:harness/web/p2p/terminal_p2p_link.dart';
import 'package:harness/web/p2p/terminal_p2p_policy.dart';
import 'package:harness/web/p2p/web_terminal_p2p.dart';
import 'package:web/web.dart';

/// A second peer connection in the same page answers the link the way the
/// machine's responder (`terminalP2p.ts`) does: the offer and ICE arrive as
/// signals, the answer and its candidates go back through `handleSignal`.
class _Responder {
  _Responder() {
    pc.ondatachannel = ((RTCDataChannelEvent event) {
      channel.complete(event.channel..binaryType = 'arraybuffer');
    }).toJS;
    pc.onicecandidate = ((RTCPeerConnectionIceEvent event) {
      final candidate = event.candidate;
      if (candidate == null) return;
      final signal = {
        'candidate': candidate.candidate,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      };
      // The responder only trickles once its answer is out.
      answered ? _toLink(signal) : _pending.add(signal);
    }).toJS;
  }

  final pc = RTCPeerConnection();
  final channel = Completer<RTCDataChannel>();
  final offers = <String>[];
  final aborts = <String>[];
  final _pending = <Map<String, Object?>>[];
  late BrowserTerminalP2pLink link;
  bool answered = false;

  Map<String, Object?> _envelope(Map<String, Object?> body) => {
    'sessionId': link.sessionId,
    'protocolVersion': terminalP2pProtocolVersion,
    ...body,
  };

  void _toLink(Map<String, Object?> candidate) => unawaited(
    link.handleSignal(
      'p2p_ice_candidate',
      _envelope({'candidate': candidate}),
    ),
  );

  Future<void> signal(String type, Map<String, dynamic> payload) async {
    switch (type) {
      case 'p2p_offer':
        final sdp = payload['sdp'] as String;
        offers.add(sdp);
        await pc
            .setRemoteDescription(
              RTCSessionDescriptionInit(type: 'offer', sdp: sdp),
            )
            .toDart;
        // werift sends up to what the offer allows; a browser as the stand-in
        // only does once its own description allows as much.
        final answer = raiseMaxMessageSize(
          (await pc.createAnswer().toDart)!.sdp,
        );
        await pc
            .setLocalDescription(
              RTCLocalSessionDescriptionInit(type: 'answer', sdp: answer),
            )
            .toDart;
        await link.handleSignal('p2p_answer', _envelope({'sdp': answer}));
        answered = true;
        _pending.forEach(_toLink);
        _pending.clear();
      case 'p2p_ice_candidate':
        final candidate = payload['candidate'] as Map;
        await pc
            .addIceCandidate(
              RTCIceCandidateInit(
                candidate: candidate['candidate'] as String,
                sdpMid: candidate['sdpMid'] as String?,
                sdpMLineIndex: candidate['sdpMLineIndex'] as int?,
              ),
            )
            .toDart;
      case 'p2p_abort':
        aborts.add(payload['reason'] as String);
    }
  }

  void close() => pc.close();
}

void main() {
  late _Responder responder;
  late List<Object> received;
  late List<TerminalP2pLinkState> states;

  setUp(() {
    responder = _Responder();
    received = [];
    states = [];
    responder.link = BrowserTerminalP2pLink(
      policy: const TerminalP2pPolicy(stunUrls: [], openWaitMs: 2500),
      sendSignal: (type, payload) => unawaited(responder.signal(type, payload)),
      onData: received.add,
      onState: (state, _, _) => states.add(state),
    );
  });

  tearDown(() async {
    await responder.link.stop(notifyPeer: false);
    responder.close();
  });

  Future<RTCDataChannel> open() async {
    responder.link.start();
    expect(
      await responder.link.waitUntilReady(const Duration(seconds: 15)),
      isTrue,
    );
    return responder.channel.future.timeout(const Duration(seconds: 5));
  }

  Future<void> until(bool Function() done) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!done() && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
  }

  test('opens a direct channel the machine can read', () async {
    final machine = await open();

    expect(states, [TerminalP2pLinkState.connecting, TerminalP2pLinkState.open]);
    expect(responder.link.transport, TerminalP2pTransport.direct);
    // A keyframe outgrows the default 256 KiB; the offer must ask for more.
    expect(responder.offers.single, contains('a=max-message-size:524288'));

    final upstream = <Object?>[];
    machine.onmessage = ((MessageEvent event) {
      final data = event.data;
      upstream.add(
        data.isA<JSString>()
            ? (data as JSString).toDart
            : (data as JSArrayBuffer).toDart.asUint8List().toList(),
      );
    }).toJS;
    expect(responder.link.send('{"type":"terminal_input"}'), isTrue);
    expect(responder.link.send(Uint8List.fromList([1, 2, 3])), isTrue);
    await until(() => upstream.length == 2);

    expect(upstream, [
      '{"type":"terminal_input"}',
      [1, 2, 3],
    ]);
  });

  test('takes a keyframe larger than the browser default', () async {
    final machine = await open();
    final keyframe = Uint8List(480 * 1024)..fillRange(0, 480 * 1024, 7);

    machine.send(keyframe.toJS);
    machine.send('{"type":"terminal_output"}'.toJS);
    await until(() => received.length == 2);

    expect((received.first as Uint8List).length, keyframe.length);
    expect(received.last, '{"type":"terminal_output"}');
  });

  test('stopping tells the machine and refuses further frames', () async {
    await open();

    await responder.link.stop(reason: 'relay_closed');

    expect(responder.aborts, ['relay_closed']);
    expect(states.last, TerminalP2pLinkState.closed);
    expect(responder.link.isReady, isFalse);
    expect(responder.link.send('late'), isFalse);
  });

  test('the browser build plugs in its own WebRTC links', () {
    expect(webTerminalP2p.links, isA<BrowserTerminalP2pLinkFactory>());
    expect(webTerminalP2p.liveCount, 0);
  });
}
