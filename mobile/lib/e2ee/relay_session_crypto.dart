import 'dart:typed_data';

import '../terminal/terminal_binary.dart';
import 'bytes.dart';
import 'envelope.dart';
import 'keys.dart';
import 'primitives.dart';
import 'replay_window.dart';
import 'terminal_cipher.dart';

/// The client end of one E2EE session with a remote machine — relayClient.ts `RelaySessionCrypto`.
///
/// On macOS and Linux the harness CLI runs this role for the app and hands it plaintext. Where
/// there is no CLI (iOS, Windows) the app runs it itself, against the same machine code that
/// answers the CLI and the web client — to the machine, this app IS such a client.
///
/// One per connection: `e2e_hello` → `e2e_welcome` sets up the keys, and a reconnect is a new
/// ephemeral, new keys and fresh counters.
class RelaySessionCrypto {
  RelaySessionCrypto._(
    this.machineId,
    this._identity,
    this._peerPub,
    this._eph,
    this._helloSig,
  );

  /// Signs the hello up front, so [helloFrame] is ready the moment the relay acks the select.
  /// [ephemeral] is for tests; production mints a fresh one per connection.
  static Future<RelaySessionCrypto> start({
    required String machineId,
    required E2eeIdentity identity,
    required List<int> peerPub,
    Ephemeral? ephemeral,
  }) async {
    final eph = ephemeral ?? await Ephemeral.generate();
    return RelaySessionCrypto._(
      machineId,
      identity,
      Uint8List.fromList(peerPub),
      eph,
      await helloSig(identity, machineId, eph.pub),
    );
  }

  final String machineId;
  final E2eeIdentity _identity;
  final Uint8List _peerPub;
  final Ephemeral _eph;
  final Uint8List _helloSig;

  Uint8List? _c2s;
  Uint8List? _s2c;
  Uint8List? _terminalC2s;
  Uint8List? _terminalS2c;
  int _c2sCounter = 0;
  int _terminalC2sCounter = 0;
  final _s2cRecv = ReplayWindow();
  final _terminalS2cRecv = ReplayWindow();
  Uint8List? _groupKey;
  String _epoch = '';
  final Map<String, int> _groupRecv = {};
  int _terminalP2pVersion = 0;

  bool get ready => _c2s != null && _s2c != null;

  /// The machine's `features.terminalP2p` — 0 when it offers no P2P terminal channel.
  int get terminalP2pVersion => _terminalP2pVersion;

  Map<String, dynamic> helloFrame() => {
    'type': 'e2e_hello',
    'payload': {
      'identityPub': b64e(_identity.pub),
      'ephPub': b64e(_eph.pub),
      'sig': b64e(_helloSig),
    },
  };

  /// Takes the machine's `e2e_welcome`; true once the session is usable. False means the machine
  /// did not prove it holds the identity this app pinned for it, or the welcome did not open.
  Future<bool> handleWelcome(Map<String, dynamic> payload) async {
    try {
      final adapterEphPub = _bytesField(payload, 'ephPub');
      final sig = _bytesField(payload, 'sig');
      final enc = _bytesField(payload, 'enc');
      if (adapterEphPub == null || sig == null || enc == null) return false;
      if (!await welcomeVerify(_peerPub, machineId, _eph.pub, adapterEphPub, sig)) {
        return false;
      }
      final keys = sessionKeys(_eph, adapterEphPub, machineId, _eph.pub, adapterEphPub);
      final opened = aeadOpen(keys.s2c, 0, utf8Bytes('e2e-welcome'), enc);
      final initial = opened == null ? null : jsonObjectOf(opened);
      final groupKey = initial?['groupKey'], epoch = initial?['epoch'];
      if (groupKey is! String || groupKey.isEmpty || epoch is! String || epoch.isEmpty) {
        return false;
      }
      _groupKey = b64d(groupKey);
      _epoch = epoch;
      _c2s = keys.c2s;
      _s2c = keys.s2c;
      _terminalC2s = deriveTerminalBinaryKey(keys.c2s);
      _terminalS2c = deriveTerminalBinaryKey(keys.s2c);
      final features = initial!['features'];
      final p2p = features is Map ? features['terminalP2p'] : null;
      _terminalP2pVersion = p2p is int ? p2p : 0;
      return true;
    } on FormatException {
      return false;
    } on ArgumentError {
      return false;
    }
  }

  /// Takes an `e2e_rekey` — the machine rotated its group key, which it does when it revokes a
  /// client. False when it does not open.
  bool handleRekey(Map<String, dynamic> payload) {
    final s2c = _s2c;
    final n = payload['n'], enc = payload['enc'];
    if (s2c == null || n is! int || enc is! String || enc.isEmpty) return false;
    try {
      final opened = aeadOpen(s2c, n, utf8Bytes('e2e-rekey'), b64d(enc));
      final next = opened == null ? null : jsonObjectOf(opened);
      final groupKey = next?['groupKey'], epoch = next?['epoch'];
      if (groupKey is! String || groupKey.isEmpty || epoch is! String || epoch.isEmpty) {
        return false;
      }
      _groupKey = b64d(groupKey);
      _epoch = epoch;
      return true;
    } on FormatException {
      return false;
    }
  }

  /// Seals the payload of a frame whose type must not cross the relay in the clear; any other
  /// frame goes as it is.
  Map<String, dynamic> wrapOutgoing(Map<String, dynamic> frame) {
    final type = frame['type'], c2s = _c2s;
    if (type is! String || c2s == null || !encryptedDownTypes.contains(type)) {
      return frame;
    }
    final payload = wrapPayload(c2s, 'p', _c2sCounter++, type, null, frame['payload']);
    return {...frame, 'payload': payload};
  }

  /// The frame with its payload opened; a frame that was never sealed passes as it is. Null means
  /// drop it — stale, replayed or not authentic — and never hand it on.
  Map<String, dynamic>? unwrapIncoming(Map<String, dynamic> frame) {
    final payload = frame['payload'];
    if (payload is! Map || !isWrapped(payload)) return frame;
    final env = payload['__e2e'], type = frame['type'];
    if (env is! Map<String, dynamic> || type is! String) return null;
    final n = env['n'];
    if (n is! int) return null;
    final dbSessionId = frame['dbSessionId'] as String?;
    if (env['k'] == 'g') {
      final groupKey = _groupKey, epoch = env['epoch'];
      if (groupKey == null || epoch != _epoch) return null;
      if (n <= (_groupRecv[_epoch] ?? -1)) return null;
      final clear = unwrapPayload(groupKey, env, type, dbSessionId);
      if (clear == null) return null;
      _groupRecv[_epoch] = n;
      return {...frame, 'payload': clear};
    }
    final s2c = _s2c;
    if (s2c == null || !_s2cRecv.allows(n)) return null;
    final clear = unwrapPayload(s2c, env, type, dbSessionId);
    if (clear == null) return null;
    _s2cRecv.commit(n);
    return {...frame, 'payload': clear};
  }

  Uint8List? encryptTerminal(TerminalBinaryFrame frame) {
    final key = _terminalC2s;
    if (key == null) return null;
    final sealed = sealTerminalBinary(key, _terminalC2sCounter, frame);
    if (sealed != null) _terminalC2sCounter++;
    return sealed;
  }

  /// Null means drop — stale, replayed or not authentic.
  TerminalBinaryFrame? decryptTerminal(Uint8List raw) {
    final key = _terminalS2c;
    if (key == null) return null;
    final opened = openTerminalBinary(key, raw);
    if (opened == null || !_terminalS2cRecv.allows(opened.counter)) return null;
    _terminalS2cRecv.commit(opened.counter);
    return opened.frame;
  }
}

Uint8List? _bytesField(Map<String, dynamic> payload, String key) {
  final value = payload[key];
  return value is String && value.isNotEmpty ? b64d(value) : null;
}
