import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

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

  final SimpleKeyPairData _keyPair;
  final Uint8List pub;

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
