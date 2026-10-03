import 'dart:typed_data';

import '../e2ee/envelope.dart';
import '../e2ee/relay_session_crypto.dart';
import '../terminal/terminal_binary.dart';
import '../ws/relay_codec.dart';
import 'viewer_key_store.dart';

/// [RelaySessionCrypto] as a [RelayCodec]: the conversion the harness CLI's `remoteRelay.ts` does
/// between the relay's HTRM frames and the loopback HTRL ones, done in the app instead.
class E2eeRelayCodec implements RelayCodec {
  E2eeRelayCodec(this._session);

  final RelaySessionCrypto _session;

  @override
  Map<String, dynamic> helloFrame() => _session.helloFrame();

  @override
  Future<bool> handleWelcome(Map<String, dynamic> payload) =>
      _session.handleWelcome(payload);

  @override
  bool handleRekey(Map<String, dynamic> payload) =>
      _session.handleRekey(payload);

  @override
  int get terminalP2pVersion => _session.terminalP2pVersion;

  @override
  Map<String, dynamic>? encodeFrame(Map<String, dynamic> frame) {
    final type = frame['type'];
    // Before the welcome it is not yet known whether the machine opens [strictDownTypes], and
    // either way they must not leave in the clear to one that refuses them — so hold them too.
    final mustSeal = type is String && sealsDown(type, strictDown: true);
    if (mustSeal && !_session.ready) return null;
    return _session.wrapOutgoing(frame);
  }

  @override
  Map<String, dynamic>? decodeFrame(Map<String, dynamic> frame) =>
      _session.unwrapIncoming(frame);

  @override
  Uint8List? encodeBinary(Uint8List localFrame) {
    final clear = decodeTerminalLocal(localFrame);
    return clear == null ? null : _session.encryptTerminal(clear);
  }

  @override
  Uint8List? decodeBinary(Uint8List wireFrame) {
    final clear = _session.decryptTerminal(wireFrame);
    return clear == null ? null : encodeTerminalLocal(clear);
  }
}

/// The viewer's [RelayCodecFactory]: a new session per connection, against the identity this
/// device pinned for the machine when it linked — or none, when it never has.
RelayCodecFactory viewerRelayCodecs(ViewerKeyStore keys) => (machineId) async {
  final peer = await keys.peer(machineId);
  if (peer == null) return null;
  return E2eeRelayCodec(
    await RelaySessionCrypto.start(
      machineId: machineId,
      identity: await keys.identity(),
      peerPub: peer.pub,
    ),
  );
};
