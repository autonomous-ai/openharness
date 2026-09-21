import 'dart:typed_data';

import 'bytes.dart';
import 'primitives.dart';

/// RFC 7914 scrypt — the stretch `harness remote-password` puts on a password (N=2^17, r=8, p=1).
///
/// Written over 32-bit words rather than taken from pointycastle, whose Salsa core works byte by
/// byte: this runs 2^17 × 2 block mixes over 128 MB once per link attempt, on a phone, and that is
/// the whole of the wait the person sees.
Uint8List scrypt(
  List<int> password,
  List<int> salt, {
  required int n,
  required int r,
  required int p,
  required int dkLen,
}) {
  if (n < 2 || (n & (n - 1)) != 0) throw ArgumentError('scrypt: N must be a power of 2');
  if (r < 1 || p < 1) throw ArgumentError('scrypt: r and p must be positive');
  final blockWords = 32 * r;
  final b = _bytesToWords(_pbkdf2Once(password, salt, 128 * r * p));
  final v = Uint32List(blockWords * n);
  final x = Uint32List(blockWords);
  final y = Uint32List(blockWords);
  final mix = Uint32List(16);
  for (var i = 0; i < p; i++) {
    _roMix(b, i * blockWords, r, n, v, x, y, mix);
  }
  return _pbkdf2Once(password, _wordsToBytes(b), dkLen);
}

/// PBKDF2-HMAC-SHA256 with one iteration — all scrypt ever asks of it.
Uint8List _pbkdf2Once(List<int> password, List<int> salt, int length) {
  final out = BytesBuilder(copy: false);
  for (var block = 1; out.length < length; block++) {
    out.add(hmacSha256(password, [
      ...salt,
      (block >> 24) & 0xff,
      (block >> 16) & 0xff,
      (block >> 8) & 0xff,
      block & 0xff,
    ]));
  }
  return Uint8List.sublistView(out.takeBytes(), 0, length);
}

void _roMix(
  Uint32List b,
  int offset,
  int r,
  int n,
  Uint32List v,
  Uint32List x,
  Uint32List y,
  Uint32List mix,
) {
  final words = 32 * r;
  x.setRange(0, words, b, offset);
  for (var i = 0; i < n; i++) {
    v.setRange(i * words, (i + 1) * words, x);
    _blockMix(x, y, mix, r);
  }
  final mask = n - 1;
  final last = (2 * r - 1) * 16;
  for (var i = 0; i < n; i++) {
    final base = (x[last] & mask) * words;
    for (var k = 0; k < words; k++) {
      x[k] ^= v[base + k];
    }
    _blockMix(x, y, mix, r);
  }
  b.setRange(offset, offset + words, x);
}

/// BlockMix_{Salsa20/8, r}: [b] in, [b] out (shuffled even blocks first), [y] as scratch.
void _blockMix(Uint32List b, Uint32List y, Uint32List mix, int r) {
  mix.setRange(0, 16, b, (2 * r - 1) * 16);
  for (var i = 0; i < 2 * r; i++) {
    for (var k = 0; k < 16; k++) {
      mix[k] ^= b[i * 16 + k];
    }
    _salsa20x8(mix);
    final target = ((i & 1) == 0 ? i >> 1 : r + (i >> 1)) * 16;
    y.setRange(target, target + 16, mix);
  }
  b.setRange(0, 32 * r, y);
}

int _rotl(int value, int shift) {
  final v = value & 0xffffffff;
  return ((v << shift) | (v >> (32 - shift))) & 0xffffffff;
}

/// The Salsa20/8 core of RFC 7914 §3, in place.
void _salsa20x8(Uint32List b) {
  var x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3];
  var x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7];
  var x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11];
  var x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15];
  for (var i = 0; i < 8; i += 2) {
    x4 ^= _rotl(x0 + x12, 7);
    x8 ^= _rotl(x4 + x0, 9);
    x12 ^= _rotl(x8 + x4, 13);
    x0 ^= _rotl(x12 + x8, 18);
    x9 ^= _rotl(x5 + x1, 7);
    x13 ^= _rotl(x9 + x5, 9);
    x1 ^= _rotl(x13 + x9, 13);
    x5 ^= _rotl(x1 + x13, 18);
    x14 ^= _rotl(x10 + x6, 7);
    x2 ^= _rotl(x14 + x10, 9);
    x6 ^= _rotl(x2 + x14, 13);
    x10 ^= _rotl(x6 + x2, 18);
    x3 ^= _rotl(x15 + x11, 7);
    x7 ^= _rotl(x3 + x15, 9);
    x11 ^= _rotl(x7 + x3, 13);
    x15 ^= _rotl(x11 + x7, 18);
    x1 ^= _rotl(x0 + x3, 7);
    x2 ^= _rotl(x1 + x0, 9);
    x3 ^= _rotl(x2 + x1, 13);
    x0 ^= _rotl(x3 + x2, 18);
    x6 ^= _rotl(x5 + x4, 7);
    x7 ^= _rotl(x6 + x5, 9);
    x4 ^= _rotl(x7 + x6, 13);
    x5 ^= _rotl(x4 + x7, 18);
    x11 ^= _rotl(x10 + x9, 7);
    x8 ^= _rotl(x11 + x10, 9);
    x9 ^= _rotl(x8 + x11, 13);
    x10 ^= _rotl(x9 + x8, 18);
    x12 ^= _rotl(x15 + x14, 7);
    x13 ^= _rotl(x12 + x15, 9);
    x14 ^= _rotl(x13 + x12, 13);
    x15 ^= _rotl(x14 + x13, 18);
  }
  // A Uint32List store keeps the low 32 bits, which is the mod-2^32 add the spec wants.
  b[0] += x0;
  b[1] += x1;
  b[2] += x2;
  b[3] += x3;
  b[4] += x4;
  b[5] += x5;
  b[6] += x6;
  b[7] += x7;
  b[8] += x8;
  b[9] += x9;
  b[10] += x10;
  b[11] += x11;
  b[12] += x12;
  b[13] += x13;
  b[14] += x14;
  b[15] += x15;
}

Uint32List _bytesToWords(Uint8List bytes) {
  final view = ByteData.sublistView(bytes);
  return Uint32List.fromList([
    for (var i = 0; i < bytes.length; i += 4) view.getUint32(i, Endian.little),
  ]);
}

Uint8List _wordsToBytes(Uint32List words) {
  final out = ByteData(words.length * 4);
  for (var i = 0; i < words.length; i++) {
    out.setUint32(i * 4, words[i], Endian.little);
  }
  return concatBytes([out.buffer.asUint8List()]);
}
