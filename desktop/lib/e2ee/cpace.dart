import 'dart:typed_data';

import 'bytes.dart';
import 'keys.dart';
import 'primitives.dart';
import 'ristretto.dart';
import 'ristretto_field.dart';

/// The CPace-style PAKE over ristretto255 — core.ts's cpace*, kcKeys, pairKey and pairBind*.
///
/// Roles as core.ts names them: 'a' is the machine being joined, 'b' is the one joining (this app).

const _cpaceDsi = 'e2e-cpace-ristretto255-v1';

/// core.ts `randScalar`: uniform in [1, L) from 64 random bytes.
BigInt randScalar(Rng rng) {
  for (var i = 0; i < 8; i++) {
    final scalar = bytesToNumberLe(rng(64)) % curveOrder;
    if (scalar != BigInt.zero) return scalar;
  }
  throw StateError('randScalar: exhausted');
}

/// A CPace half: the secret [scalar] this side keeps, and the [share] it sends (core.ts's y and Y).
typedef CpaceStart = ({BigInt scalar, Uint8List share});

CpaceStart cpaceStart(RistrettoPoint generator, [Rng rng = secureRandomBytes]) {
  final scalar = randScalar(rng);
  return (scalar: scalar, share: generator.multiply(scalar).toBytes());
}

/// K = peerShare^scalar. Throws on an invalid or identity point — attack input, never a typo.
Uint8List cpaceShared(List<int> peerShare, BigInt scalar) {
  final shared = RistrettoPoint.fromBytes(peerShare).multiply(scalar);
  if (shared.equals(RistrettoPoint.zero)) {
    throw StateError('cpace: identity shared point');
  }
  return shared.toBytes();
}

Uint8List cpaceIsk(
  List<int> sid,
  List<int> shared,
  List<int> shareA,
  List<int> shareB,
) => sha512(
  lvCat([
    '${_cpaceDsi}_ISK',
    sid,
    shared,
    lvCat([shareA, 'a']),
    lvCat([shareB, 'b']),
  ]),
);

Uint8List transcriptHash(
  List<int> sid,
  String ci,
  List<int> shareA,
  List<int> shareB,
) => sha512(lvCat([sid, ci, lvCat([shareA, 'a']), lvCat([shareB, 'b'])]));

/// Key-confirmation MAC keys: [adapter] proves the joined machine's side, [web] the joiner's.
({Uint8List adapter, Uint8List web}) kcKeys(List<int> isk, String ci) {
  final kc = hkdfSha256(
    isk,
    salt: utf8Bytes(ci),
    info: utf8Bytes('e2e-kc-v1'),
    length: 64,
  );
  return (
    adapter: Uint8List.sublistView(kc, 0, 32),
    web: Uint8List.sublistView(kc, 32, 64),
  );
}

Uint8List macTag(List<int> key, List<int> transcript) =>
    hmacSha256(key, transcript);

bool macVerify(List<int> key, List<int> transcript, List<int> tag) =>
    ctEqual(macTag(key, transcript), tag);

/// Seals the identity exchange inside the PAKE.
Uint8List pairKey(List<int> isk, String ci) => hkdfSha256(
  isk,
  salt: utf8Bytes(ci),
  info: utf8Bytes('e2e-id-v1'),
  length: 32,
);

Future<Uint8List> pairBindSig(E2eeIdentity identity, List<int> transcript) =>
    identity.sign(concatBytes([utf8Bytes('e2e-pair-bind'), transcript]));

Future<bool> pairBindVerify(
  List<int> pub,
  List<int> transcript,
  List<int> sig,
) =>
    verifySignature(
      pub,
      concatBytes([utf8Bytes('e2e-pair-bind'), transcript]),
      sig,
    );
