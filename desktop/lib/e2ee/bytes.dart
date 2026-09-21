import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

/// Byte helpers for the E2EE port — the Dart side of core.ts's "portable helpers".

/// A source of random bytes. Production code takes the default ([secureRandomBytes]); tests pass
/// the seeded generator core.test.ts uses, so key material matches the CLI's vectors.
typedef Rng = Uint8List Function(int length);

final Random _secure = Random.secure();

Uint8List secureRandomBytes(int length) {
  final out = Uint8List(length);
  for (var i = 0; i < length; i++) {
    out[i] = _secure.nextInt(256);
  }
  return out;
}

String b64e(List<int> bytes) => base64Encode(bytes);

Uint8List b64d(String text) => base64Decode(text);

Uint8List utf8Bytes(String text) => Uint8List.fromList(utf8.encode(text));

Uint8List concatBytes(List<List<int>> parts) {
  final builder = BytesBuilder(copy: false);
  for (final part in parts) {
    builder.add(part);
  }
  return builder.takeBytes();
}

/// core.ts `lvCat`: every part prefixed with its 4-byte big-endian length, so no two different
/// transcripts can encode to the same bytes. A [String] part is its UTF-8.
Uint8List lvCat(List<Object> parts) {
  final builder = BytesBuilder(copy: false);
  for (final part in parts) {
    final bytes = switch (part) {
      String text => utf8Bytes(text),
      List<int> raw => raw,
      _ => throw ArgumentError.value(part, 'part', 'must be a String or bytes'),
    };
    builder
      ..add((ByteData(4)..setUint32(0, bytes.length)).buffer.asUint8List())
      ..add(bytes);
  }
  return builder.takeBytes();
}

/// Equality that does not stop at the first differing byte — for MAC tags.
bool ctEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

String hexOf(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
