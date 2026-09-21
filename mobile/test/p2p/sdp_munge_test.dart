import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/p2p/webrtc_terminal_p2p_link.dart';

void main() {
  test('raises max-message-size in place, line endings untouched', () {
    const sdp =
        'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
        'a=sctp-port:5000\r\na=max-message-size:262144\r\na=mid:0\r\n';
    expect(
      raiseMaxMessageSizeForTest(sdp),
      'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
      'a=sctp-port:5000\r\na=max-message-size:524288\r\na=mid:0\r\n',
    );
  });

  test('adds the line after sctp-port when libwebrtc left it out', () {
    const sdp = 'v=0\r\na=sctp-port:5000\r\na=mid:0\r\n';
    expect(
      raiseMaxMessageSizeForTest(sdp),
      'v=0\r\na=sctp-port:5000\r\na=max-message-size:524288\r\na=mid:0\r\n',
    );
  });
}
