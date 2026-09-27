import 'dart:typed_data';

import '../core/wire_counter.dart';
import '../e2ee/bytes.dart';
import '../e2ee/envelope.dart';
import '../e2ee/keys.dart';
import '../ws/relay_codec.dart';

/// cli/src/sharing/crypto.ts's recipient session. Each connection belongs to
/// one grant, verifies the owner's signed ephemeral key, and can only observe.
/// It never receives a machine group key or becomes a machine peer link.
class ObserverRelayCodec implements RelayCodec {
  ObserverRelayCodec._(this._ephemeral, this._owner, this.context);

  static Future<ObserverRelayCodec> create({
    required String machineId,
    required String shareId,
    required String ownerPublicKey,
  }) async => ObserverRelayCodec._(
    await Ephemeral.generate(),
    b64d(ownerPublicKey),
    'harness-observer-v1:$machineId:$shareId',
  );

  final Ephemeral _ephemeral;
  final Uint8List _owner;
  final String context;
  SessionKeys? _keys;
  int _tx = 0, _rx = -1;

  @override
  Map<String, dynamic> helloFrame() => {
    'type': 'observer_hello',
    'payload': {'ephemeral': b64e(_ephemeral.pub)},
  };

  @override
  Future<bool> handleWelcome(Map<String, dynamic> payload) async {
    if (_keys != null) return false;
    try {
      final peer = b64d(payload['ephemeral'] as String);
      final signature = b64d(payload['signature'] as String);
      if (_owner.length != 32 ||
          peer.length != 32 ||
          !await welcomeVerify(
            _owner,
            context,
            _ephemeral.pub,
            peer,
            signature,
          )) {
        return false;
      }
      _keys = sessionKeys(_ephemeral, peer, context, _ephemeral.pub, peer);
      return true;
    } on Object {
      return false;
    }
  }

  static const _allowed = {
    'terminal_capabilities',
    'terminal_open',
    'terminal_alive',
    'terminal_ack',
    'terminal_resync',
    'terminal_close',
    'observer_viewer',
  };

  @override
  Map<String, dynamic>? encodeFrame(Map<String, dynamic> frame) {
    final keys = _keys;
    if (keys == null ||
        !_allowed.contains(frame['type']) ||
        _tx > maxSafeInteger) {
      return null;
    }
    return {
      'type': 'observer_frame',
      'payload': wrapPayload(
        keys.c2s,
        'p',
        _tx++,
        'observer_frame',
        context,
        frame,
      ),
    };
  }

  @override
  Map<String, dynamic>? decodeFrame(Map<String, dynamic> frame) {
    final keys = _keys;
    final payload = frame['payload'];
    if (keys == null || frame['type'] != 'observer_frame' || payload is! Map) {
      return null;
    }
    final envelope = payload['__e2e'];
    if (envelope is! Map<String, dynamic>) return null;
    final n = envelope['n'], ct = envelope['ct'];
    if (envelope['v'] != 1 ||
        envelope['k'] != 'p' ||
        n is! int ||
        n <= _rx ||
        n > maxSafeInteger ||
        ct is! String ||
        ct.length > 3 * 1024 * 1024) {
      return null;
    }
    final clear = unwrapPayload(keys.s2c, envelope, 'observer_frame', context);
    if (clear == null || clear['type'] is! String || clear['payload'] is! Map) {
      return null;
    }
    _rx = n;
    return clear;
  }

  @override
  Uint8List? encodeBinary(Uint8List localFrame) => null;
  @override
  Uint8List? decodeBinary(Uint8List wireFrame) => null;
  @override
  bool handleRekey(Map<String, dynamic> payload) => false;
  @override
  int get terminalP2pVersion => 0;
}
