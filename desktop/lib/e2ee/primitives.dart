import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import 'bytes.dart';

/// Hashes, HMAC, HKDF and the ChaCha20-Poly1305 AEAD — what core.ts takes from noble, each one held
/// byte-for-byte against the CLI by test/e2ee/.
///
/// All synchronous on purpose, like core.ts: a nonce counter read before an `await` and spent after
/// one is exactly how two frames end up sealed under the same nonce.

const _sha256 = DartSha256();
const _sha512 = DartSha512();
const _hmacSha256 = DartHmac(DartSha256());
const _aead = DartChacha20.poly1305Aead();
const _aeadTagBytes = 16;

Uint8List sha256(List<int> data) =>
    Uint8List.fromList(_sha256.hashSync(data).bytes);

Uint8List sha512(List<int> data) =>
    Uint8List.fromList(_sha512.hashSync(data).bytes);

Uint8List hmacSha256(List<int> key, List<int> data) => Uint8List.fromList(
  _hmacSha256
      .calculateMacSync(
        data,
        secretKeyData: SecretKeyData(key),
        nonce: const <int>[],
      )
      .bytes,
);

/// RFC 5869 HKDF-SHA256 — noble's `hkdf(sha256, ikm, salt, info, length)`.
Uint8List hkdfSha256(
  List<int> ikm, {
  List<int> salt = const <int>[],
  List<int> info = const <int>[],
  required int length,
}) {
  // An empty salt means HashLen zero bytes (RFC 5869 §2.2). HMAC zero-pads its key to the block
  // size either way, so this is what noble computes for both an absent and an empty salt.
  final prk = hmacSha256(salt.isEmpty ? Uint8List(32) : salt, ikm);
  final okm = BytesBuilder(copy: false);
  var block = Uint8List(0);
  for (var counter = 1; okm.length < length; counter++) {
    block = hmacSha256(prk, [...block, ...info, counter]);
    okm.add(block);
  }
  return Uint8List.sublistView(okm.takeBytes(), 0, length);
}

/// core.ts `counterNonce`: the counter as 8 big-endian bytes, then 4 zero bytes.
Uint8List counterNonce(int counter) {
  final nonce = Uint8List(12);
  ByteData.sublistView(nonce).setUint64(0, counter);
  return nonce;
}

/// ChaCha20-Poly1305 under a counter nonce: ciphertext followed by its 16-byte tag, the layout
/// noble's `encrypt` produces.
Uint8List aeadSeal(
  List<int> key,
  int counter,
  List<int> aad,
  List<int> plaintext,
) {
  final box = _aead.encryptSync(
    plaintext,
    secretKey: SecretKeyData(key),
    nonce: counterNonce(counter),
    aad: aad,
  );
  return concatBytes([box.cipherText, box.mac.bytes]);
}

/// The inverse of [aeadSeal]; null when the tag does not verify — a wrong key, counter or AAD, or
/// a flipped byte.
Uint8List? aeadOpen(
  List<int> key,
  int counter,
  List<int> aad,
  List<int> sealed,
) {
  if (sealed.length < _aeadTagBytes) return null;
  final split = sealed.length - _aeadTagBytes;
  try {
    final clear = _aead.decryptSync(
      SecretBox(
        sealed.sublist(0, split),
        nonce: counterNonce(counter),
        mac: Mac(sealed.sublist(split)),
      ),
      secretKey: SecretKeyData(key),
      aad: aad,
    );
    return Uint8List.fromList(clear);
  } on SecretBoxAuthenticationError {
    return null;
  } on ArgumentError {
    return null;
  }
}
