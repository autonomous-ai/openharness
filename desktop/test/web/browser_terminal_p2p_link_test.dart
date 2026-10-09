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
      final opened = event.channel..binaryType = 'arraybuffer';
      labels.add(opened.label);
      (opened.label == viewerP2pChannel ? viewer : channel).complete(opened);
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
  final viewer = Completer<RTCDataChannel>();
  final labels = <String>[];
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
    link.handleSignal('p2p_ice_candidate', _envelope({'candidate': candidate})),
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

    expect(states, [
      TerminalP2pLinkState.connecting,
      TerminalP2pLinkState.open,
    ]);
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

  test('a caller that reads no viewer data opens no viewer channel', () async {
    await open();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(responder.labels, [terminalP2pChannel]);
    expect(responder.link.viewerReady, isFalse);
    expect(responder.link.sendViewer('x'), isFalse);
  });

  group('with a viewer', () {
    late List<Object> viewerReceived;
    late List<bool> viewerStates;

    setUp(() {
      viewerReceived = [];
      viewerStates = [];
      responder.link = BrowserTerminalP2pLink(
        policy: const TerminalP2pPolicy(stunUrls: [], openWaitMs: 2500),
        sendSignal: (type, payload) =>
            unawaited(responder.signal(type, payload)),
        onData: received.add,
        onState: (state, _, _) => states.add(state),
        onViewerData: viewerReceived.add,
        onViewerState: viewerStates.add,
      );
    });

    Future<RTCDataChannel> openViewer() async {
      await open();
      final machine = await responder.viewer.future.timeout(
        const Duration(seconds: 5),
      );
      await until(() => responder.link.viewerReady);
      expect(responder.link.viewerReady, isTrue);
      return machine;
    }

    test(
      'the machine sees both channels, and data flows on viewer-v1',
      () async {
        final machine = await openViewer();
        expect(
          responder.labels,
          unorderedEquals([terminalP2pChannel, viewerP2pChannel]),
        );
        expect(viewerStates, [true]);

        final upstream = <Object?>[];
        machine.onmessage = ((MessageEvent event) {
          final data = event.data;
          upstream.add(
            data.isA<JSString>()
                ? (data as JSString).toDart
                : (data as JSArrayBuffer).toDart.asUint8List().toList(),
          );
        }).toJS;
        expect(responder.link.sendViewer('{"type":"viewer_input"}'), isTrue);
        expect(responder.link.sendViewer(Uint8List.fromList([4, 5])), isTrue);
        await until(() => upstream.length == 2);
        expect(upstream, [
          '{"type":"viewer_input"}',
          [4, 5],
        ]);

        machine.send('{"type":"viewer_frame"}'.toJS);
        machine.send(Uint8List.fromList([6]).toJS);
        await until(() => viewerReceived.length == 2);
        expect(viewerReceived.first, '{"type":"viewer_frame"}');
        expect(viewerReceived.last, [6]);
        expect(
          received,
          isEmpty,
          reason: 'nothing of the viewer reaches onData',
        );
      },
    );

    test(
      'its close reports the viewer closed and spares the terminal',
      () async {
        final machine = await openViewer();
        final terminal = await responder.channel.future;

        machine.close();
        await until(() => viewerStates.length == 2);

        expect(viewerStates, [true, false]);
        expect(responder.link.viewerReady, isFalse);
        expect(responder.link.sendViewer('x'), isFalse);
        expect(responder.link.isReady, isTrue);
        expect(states.last, TerminalP2pLinkState.open);
        final upstream = <Object?>[];
        terminal.onmessage = ((MessageEvent event) {
          upstream.add((event.data as JSString).toDart);
        }).toJS;
        expect(responder.link.send('still here'), isTrue);
        await until(() => upstream.isNotEmpty);
        expect(upstream, ['still here']);
      },
    );

    test('stopping closes both', () async {
      final machine = await openViewer();
      await responder.link.stop(reason: 'relay_closed');
      expect(viewerStates, [true, false]);
      expect(responder.link.sendViewer('late'), isFalse);
      await until(() => machine.readyState == 'closed');
      expect(machine.readyState, 'closed');
    });
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
