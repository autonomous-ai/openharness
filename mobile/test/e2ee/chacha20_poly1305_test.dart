import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/e2ee/chacha20_poly1305.dart';

Uint8List _hex(String hex) {
  final clean = hex.replaceAll(RegExp(r'[^0-9a-f]'), '');
  return Uint8List.fromList([
    for (var i = 0; i < clean.length; i += 2)
      int.parse(clean.substring(i, i + 2), radix: 16),
  ]);
}

String _hexOf(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// The package's AEAD, which every relay frame went through before this one — the reference.
Uint8List _reference(
  List<int> key,
  List<int> nonce,
  List<int> aad,
  List<int> pt,
) {
  final box = const DartChacha20.poly1305Aead().encryptSync(
    pt,
    secretKey: SecretKeyData(key),
    nonce: nonce,
    aad: aad,
  );
  return Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
}

void main() {
  test('RFC 8439 §2.8.2: the AEAD test vector', () {
    final key = Uint8List.fromList([for (var i = 0x80; i <= 0x9f; i++) i]);
    final nonce = _hex('07000000 4041424344454647');
    final aad = _hex('50515253c0c1c2c3c4c5c6c7');
    final plaintext = utf8.encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip "
      'for the future, sunscreen would be it.',
    );
    final sealed = chacha20Poly1305Seal(key, nonce, aad, plaintext);
    expect(_hexOf(sealed.sublist(0, 16)), 'd31a8d34648e60db7b86afbc53ef7ec2');
    expect(
      _hexOf(sealed.sublist(sealed.length - 16)),
      '1ae10b594f09e26a7e902ecbd0600691',
    );
    expect(chacha20Poly1305Open(key, nonce, aad, sealed), plaintext);
  });

  test('byte-for-byte the package AEAD, across lengths that cross every block edge', () {
    final random = Random(8439);
    List<int> bytes(int n) => [for (var i = 0; i < n; i++) random.nextInt(256)];
    for (final length in [
      0,
      1,
      15,
      16,
      17,
      63,
      64,
      65,
      127,
      128,
      129,
      1000,
      4096,
      65537,
    ]) {
      for (final aadLength in [0, 1, 16, 20]) {
        final key = bytes(32), nonce = bytes(12), aad = bytes(aadLength);
        final plaintext = bytes(length);
        final sealed = chacha20Poly1305Seal(key, nonce, aad, plaintext);
        expect(
          sealed,
          _reference(key, nonce, aad, plaintext),
          reason: 'plaintext $length B, aad $aadLength B',
        );
        expect(chacha20Poly1305Open(key, nonce, aad, sealed), plaintext);
      }
    }
  });

  test('a key and h near the Poly1305 prime still match the package', () {
    // All-ones bytes drive the accumulator to its largest values, where a missed carry or the
    // final h - p choice would show.
    final key = List.filled(32, 0xff), nonce = List.filled(12, 0xff);
    for (final length in [16, 64, 4096]) {
      final plaintext = List.filled(length, 0xff), aad = List.filled(16, 0xff);
      expect(
        chacha20Poly1305Seal(key, nonce, aad, plaintext),
        _reference(key, nonce, aad, plaintext),
      );
    }
  });

  test('opens nothing that was changed', () {
    final key = List.filled(32, 3), nonce = List.filled(12, 4);
    final sealed = chacha20Poly1305Seal(key, nonce, [1, 2], [5, 6, 7]);
    for (var i = 0; i < sealed.length; i++) {
      final flipped = Uint8List.fromList(sealed)..[i] ^= 1;
      expect(
        chacha20Poly1305Open(key, nonce, [1, 2], flipped),
        isNull,
        reason: 'byte $i',
      );
    }
    expect(chacha20Poly1305Open(key, nonce, [1, 3], sealed), isNull);
    expect(
      chacha20Poly1305Open(key, nonce, [1, 2], sealed.sublist(0, 15)),
      isNull,
    );
  });
}
