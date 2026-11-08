import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/p2p/p2p_sdp.dart';

void main() {
  test('raises max-message-size in place, line endings untouched', () {
    const sdp =
        'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
        'a=sctp-port:5000\r\na=max-message-size:262144\r\na=mid:0\r\n';
    expect(
      raiseMaxMessageSize(sdp),
      'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
      'a=sctp-port:5000\r\na=max-message-size:524288\r\na=mid:0\r\n',
    );
  });

  test('adds the line after sctp-port when the browser left it out', () {
    const sdp = 'v=0\r\na=sctp-port:5000\r\na=mid:0\r\n';
    expect(
      raiseMaxMessageSize(sdp),
      'v=0\r\na=sctp-port:5000\r\na=max-message-size:524288\r\na=mid:0\r\n',
    );
  });

  test('session ids are lower-case uuid v4', () {
    final id = p2pSessionId(Random(7));
    expect(
      id,
      matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
    );
  });

  test('only server-answered candidates count as reflexive', () {
    expect(reflexiveCandidate.hasMatch('candidate:1 1 udp 1 1.2.3.4 9 typ srflx'), isTrue);
    expect(reflexiveCandidate.hasMatch('candidate:1 1 udp 1 1.2.3.4 9 typ relay'), isTrue);
    expect(reflexiveCandidate.hasMatch('candidate:1 1 udp 1 x.local 9 typ host'), isFalse);
  });
}
