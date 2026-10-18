import 'dart:isolate';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import '../core/test_run.dart';
import 'bytes.dart';
import 'primitives.dart';

/// Long-lived identity (Ed25519) and per-connection ephemeral (X25519) keys — core.ts `Identity`,
/// `Ephemeral` and `sessionKeys`, plus the hello/welcome signatures that bind them.
///
/// Signing and verifying are async where core.ts's are not: the pure-Dart Ed25519 has no
/// synchronous API. Nothing that signs touches a nonce counter — only the handshake and the link
/// sign anything — so the await costs no ordering guarantee.

final _ed25519 = DartEd25519();
const _x25519 = DartX25519();

/// This app's Ed25519 identity. [seed] is the 32-byte RFC 8032 private key (core.ts's `priv`).
///
/// Every machine this app links to pins [pub], so it is minted once and persisted — a new one
/// means linking every machine again.
class E2eeIdentity {
  E2eeIdentity._(this.seed, this.pub);

  final Uint8List seed;
  final Uint8List pub;

  static Future<E2eeIdentity> fromSeed(List<int> seed) async {
    final keyPair = await _ed25519.newKeyPairFromSeed(seed);
    final pub = await keyPair.extractPublicKey();
    return E2eeIdentity._(Uint8List.fromList(seed), Uint8List.fromList(pub.bytes));
  }

  static Future<E2eeIdentity> generate([Rng rng = secureRandomBytes]) =>
      fromSeed(rng(32));

  Future<Uint8List> sign(List<int> message) async {
    final signature = await _ed25519.sign(
      message,
      keyPair: SimpleKeyPairData(
        seed,
        publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519),
        type: KeyPairType.ed25519,
      ),
    );
    return Uint8List.fromList(signature.bytes);
  }
}

/// False for a bad signature AND for input too malformed to check, as core.ts's `verify`.
Future<bool> verifySignature(
  List<int> pub,
  List<int> message,
  List<int> signature,
) async {
  try {
    return await _ed25519.verify(
      message,
      signature: Signature(
        signature,
        publicKey: SimplePublicKey(pub, type: KeyPairType.ed25519),
      ),
    );
  } catch (_) {
    return false;
  }
}

/// core.ts `fingerprint`: sha256(pub)'s first 8 bytes as four dot-separated hex groups — what the
/// person compares against the other machine's `harness remote-password status`.
String fingerprint(List<int> pub) {
  final hex = hexOf(sha256(pub).sublist(0, 8)).toUpperCase();
  return '${hex.substring(0, 4)}·${hex.substring(4, 8)}·'
      '${hex.substring(8, 12)}·${hex.substring(12, 16)}';
}

/// A per-connection X25519 key.
class Ephemeral {
  Ephemeral._(this._keyPair, this.pub);

  /// The key [_privateBytes] and [pub] describe, as [generate] made it on another isolate —
  /// the same bytes, public key and type in the same [SimpleKeyPairData], so nothing derived from
  /// it can differ.
  Ephemeral._fromParts(Uint8List privateBytes, Uint8List pub)
    : this._(
        SimpleKeyPairData(
          privateBytes,
          publicKey: SimplePublicKey(pub, type: KeyPairType.x25519),
          type: KeyPairType.x25519,
        ),
        pub,
      );

  final SimpleKeyPairData _keyPair;
  final Uint8List pub;

  /// The private key as plain bytes — what crosses to a background isolate, where
  /// [Ephemeral._fromParts] puts it back together.
  Uint8List get _privateBytes => Uint8List.fromList(_keyPair.bytes);

  static Future<Ephemeral> generate([Rng rng = secureRandomBytes]) async {
    final keyPair =
        await _x25519.newKeyPairFromSeed(rng(32)) as SimpleKeyPairData;
    return Ephemeral._(keyPair, Uint8List.fromList(keyPair.publicKey.bytes));
  }

  Uint8List sharedSecret(List<int> peerPub) {
    final secret =
        _x25519.sharedSecretSync(
              keyPairData: _keyPair,
              remotePublicKey: SimplePublicKey(
                peerPub,
                type: KeyPairType.x25519,
              ),
            )
            as SecretKeyData;
    return Uint8List.fromList(secret.bytes);
  }
}

typedef SessionKeys = ({Uint8List c2s, Uint8List s2c});

/// core.ts `sessionKeys`. Both ends pass the SAME (webEphPub, adapterEphPub) order, whichever end
/// they are.
SessionKeys sessionKeys(
  Ephemeral eph,
  List<int> peerEphPub,
  String machineId,
  List<int> webEphPub,
  List<int> adapterEphPub,
) {
  final session = hkdfSha256(
    eph.sharedSecret(peerEphPub),
    salt: lvCat([machineId, webEphPub, adapterEphPub]),
    info: utf8Bytes('e2e-sess-v1'),
    length: 64,
  );
  return (
    c2s: Uint8List.sublistView(session, 0, 32),
    s2c: Uint8List.sublistView(session, 32, 64),
  );
}

Future<Uint8List> helloSig(
  E2eeIdentity identity,
  String machineId,
  List<int> ephPub,
) => identity.sign(lvCat(['e2e-hello-v1', machineId, ephPub]));

Future<bool> welcomeVerify(
  List<int> peerPub,
  String machineId,
  List<int> webEphPub,
  List<int> adapterEphPub,
  List<int> sig,
) => verifySignature(
  peerPub,
  lvCat(['e2e-welcome-v1', machineId, webEphPub, adapterEphPub]),
  sig,
);

// ── the handshake, off the UI isolate ─────────────────────────────────────────────────────────────
//
// ⚠️ **Why (owner, 2026-10-02).** Ed25519 and X25519 are pure Dart here, and each connection
// signs a hello and verifies a welcome — measured at 70–740ms and ~390ms on a debug Android build,
// on the thread drawing the screen. A launch lets six to nine machines dial once the terminal on
// screen is up, so that was a stutter in it. Each step below runs on a background isolate and
// hands back plain bytes; only the bytes cross, and the objects are rebuilt from them exactly as
// they were made. An isolate that will not start is the same work done here, never a failure;
// under `flutter test`, whose fake clocks never deliver an isolate's answer, it is always here.

/// An ephemeral key for one connection to [machineId], and [identity]'s hello signature over it
/// ([helloSig]) — minted on a background isolate.
Future<({Ephemeral eph, Uint8List sig})> mintHello(
  E2eeIdentity identity,
  String machineId,
) async {
  if (!kUnderTest) {
    final seed = identity.seed;
    final pub = identity.pub;
    try {
      final minted = await Isolate.run(
        () => _mintHelloParts(seed, pub, machineId),
      );
      return (
        eph: Ephemeral._fromParts(minted.privateBytes, minted.pub),
        sig: minted.sig,
      );
    } on Object {
      // Done here instead, below.
    }
  }
  final eph = await Ephemeral.generate();
  return (eph: eph, sig: await helloSig(identity, machineId, eph.pub));
}

Future<({Uint8List privateBytes, Uint8List pub, Uint8List sig})>
_mintHelloParts(Uint8List seed, Uint8List pub, String machineId) async {
  final eph = await Ephemeral.generate();
  final sig = await helloSig(E2eeIdentity._(seed, pub), machineId, eph.pub);
  return (privateBytes: eph._privateBytes, pub: eph.pub, sig: sig);
}

/// What a machine's `e2e_welcome` gives a session once its signature holds: the pairwise keys
/// ([sessionKeys]), and its sealed `enc` opened under `s2c` — null when it does not open.
typedef OpenedWelcome = ({Uint8List c2s, Uint8List s2c, Uint8List? initial});

/// [welcomeVerify], [sessionKeys] and the welcome's `enc` opened — on a background isolate. Null
/// when the signature does not hold, as [welcomeVerify]'s false. Throws what they throw (a key of
/// the wrong shape is an [ArgumentError]), for the caller to take as a welcome that is no good.
Future<OpenedWelcome?> openWelcome({
  required Ephemeral eph,
  required List<int> peerPub,
  required String machineId,
  required List<int> adapterEphPub,
  required List<int> sig,
  required List<int> enc,
}) async {
  if (!kUnderTest) {
    final privateBytes = eph._privateBytes;
    final ephPub = eph.pub;
    final peer = Uint8List.fromList(peerPub);
    final adapter = Uint8List.fromList(adapterEphPub);
    final signature = Uint8List.fromList(sig);
    final sealed = Uint8List.fromList(enc);
    try {
      return await Isolate.run(
        () => _openWelcome(
          Ephemeral._fromParts(privateBytes, ephPub),
          peer,
          machineId,
          adapter,
          signature,
          sealed,
        ),
      );
    } on Object {
      // Done here instead, below — which throws again if the welcome itself was the problem.
    }
  }
  return _openWelcome(eph, peerPub, machineId, adapterEphPub, sig, enc);
}

Future<OpenedWelcome?> _openWelcome(
  Ephemeral eph,
  List<int> peerPub,
  String machineId,
  List<int> adapterEphPub,
  List<int> sig,
  List<int> enc,
) async {
  if (!await welcomeVerify(peerPub, machineId, eph.pub, adapterEphPub, sig)) {
    return null;
  }
  final keys = sessionKeys(
    eph,
    adapterEphPub,
    machineId,
    eph.pub,
    adapterEphPub,
  );
  return (
    c2s: keys.c2s,
    s2c: keys.s2c,
    initial: aeadOpen(keys.s2c, 0, utf8Bytes('e2e-welcome'), enc),
  );
}
