import 'dart:typed_data';

/// ChaCha20-Poly1305 (RFC 8439), what [aeadSeal] and [aeadOpen] run every relay frame through.
///
/// ⚠️ **Here and not `package:cryptography`'s `DartChacha20`, which opened 23 MB/s** (AOT, M-series
/// Mac; a Pixel is several times slower). Every terminal frame on the relay is opened on the UI
/// isolate, and a keyframe — the whole screen and 500 lines of history, sent on every open, resize
/// and resync — is tens of kilobytes: a dropped frame or two before a single cell was parsed. This
/// one keeps the ChaCha20 state and the Poly1305 accumulator (26-bit limbs, poly1305-donna) in
/// locals, reads typed bytes only, and allocates nothing per block. The package stays the
/// reference: test/e2ee/chacha20_poly1305_test.dart holds the two byte-for-byte equal, besides
/// RFC 8439's own vector.
///
/// Dart's `int` is 64 bits on every platform this app runs on (it is never compiled to JS), which
/// the limb products below rely on.

const int aeadTagLength = 16;

const int _mask32 = 0xffffffff;
const int _mask26 = 0x3ffffff;

int _le32(Uint8List b, int i) =>
    b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

Uint8List _typed(List<int> bytes) =>
    bytes is Uint8List ? bytes : Uint8List.fromList(bytes);

/// XORs [input] with the ChaCha20 keystream for [key] and [nonce], blocks counted from [counter].
Uint8List _chacha20Xor(
  Uint32List key,
  Uint32List nonce,
  int counter,
  Uint8List input,
) {
  final out = Uint8List(input.length);
  final block = Uint32List(16);
  final stream = block.buffer.asUint8List();
  final bigEndianHost = Endian.host == Endian.big;
  for (var offset = 0; offset < input.length; offset += 64, counter++) {
    _chachaBlock(block, key, nonce, counter & _mask32);
    if (bigEndianHost) {
      for (var i = 0; i < 16; i++) {
        final w = block[i];
        block[i] =
            (w >> 24) |
            ((w >> 8) & 0xff00) |
            ((w << 8) & 0xff0000) |
            ((w << 24) & 0xff000000);
      }
    }
    final end = input.length - offset < 64 ? input.length - offset : 64;
    for (var i = 0; i < end; i++) {
      out[offset + i] = input[offset + i] ^ stream[i];
    }
  }
  return out;
}

/// One 64-byte ChaCha20 block into [out], as 16 words.
void _chachaBlock(Uint32List out, Uint32List k, Uint32List n, int counter) {
  const c0 = 0x61707865, c1 = 0x3320646e, c2 = 0x79622d32, c3 = 0x6b206574;
  final k0 = k[0], k1 = k[1], k2 = k[2], k3 = k[3];
  final k4 = k[4], k5 = k[5], k6 = k[6], k7 = k[7];
  final n0 = n[0], n1 = n[1], n2 = n[2];
  var x0 = c0, x1 = c1, x2 = c2, x3 = c3;
  var x4 = k0, x5 = k1, x6 = k2, x7 = k3;
  var x8 = k4, x9 = k5, x10 = k6, x11 = k7;
  var x12 = counter, x13 = n0, x14 = n1, x15 = n2;
  int t;
  for (var i = 0; i < 10; i++) {
    // Columns.
    x0 = (x0 + x4) & _mask32;
    t = x12 ^ x0;
    x12 = ((t << 16) & _mask32) | (t >> 16);
    x8 = (x8 + x12) & _mask32;
    t = x4 ^ x8;
    x4 = ((t << 12) & _mask32) | (t >> 20);
    x0 = (x0 + x4) & _mask32;
    t = x12 ^ x0;
    x12 = ((t << 8) & _mask32) | (t >> 24);
    x8 = (x8 + x12) & _mask32;
    t = x4 ^ x8;
    x4 = ((t << 7) & _mask32) | (t >> 25);

    x1 = (x1 + x5) & _mask32;
    t = x13 ^ x1;
    x13 = ((t << 16) & _mask32) | (t >> 16);
    x9 = (x9 + x13) & _mask32;
    t = x5 ^ x9;
    x5 = ((t << 12) & _mask32) | (t >> 20);
    x1 = (x1 + x5) & _mask32;
    t = x13 ^ x1;
    x13 = ((t << 8) & _mask32) | (t >> 24);
    x9 = (x9 + x13) & _mask32;
    t = x5 ^ x9;
    x5 = ((t << 7) & _mask32) | (t >> 25);

    x2 = (x2 + x6) & _mask32;
    t = x14 ^ x2;
    x14 = ((t << 16) & _mask32) | (t >> 16);
    x10 = (x10 + x14) & _mask32;
    t = x6 ^ x10;
    x6 = ((t << 12) & _mask32) | (t >> 20);
    x2 = (x2 + x6) & _mask32;
    t = x14 ^ x2;
    x14 = ((t << 8) & _mask32) | (t >> 24);
    x10 = (x10 + x14) & _mask32;
    t = x6 ^ x10;
    x6 = ((t << 7) & _mask32) | (t >> 25);

    x3 = (x3 + x7) & _mask32;
    t = x15 ^ x3;
    x15 = ((t << 16) & _mask32) | (t >> 16);
    x11 = (x11 + x15) & _mask32;
    t = x7 ^ x11;
    x7 = ((t << 12) & _mask32) | (t >> 20);
    x3 = (x3 + x7) & _mask32;
    t = x15 ^ x3;
    x15 = ((t << 8) & _mask32) | (t >> 24);
    x11 = (x11 + x15) & _mask32;
    t = x7 ^ x11;
    x7 = ((t << 7) & _mask32) | (t >> 25);

    // Diagonals.
    x0 = (x0 + x5) & _mask32;
    t = x15 ^ x0;
    x15 = ((t << 16) & _mask32) | (t >> 16);
    x10 = (x10 + x15) & _mask32;
    t = x5 ^ x10;
    x5 = ((t << 12) & _mask32) | (t >> 20);
    x0 = (x0 + x5) & _mask32;
    t = x15 ^ x0;
    x15 = ((t << 8) & _mask32) | (t >> 24);
    x10 = (x10 + x15) & _mask32;
    t = x5 ^ x10;
    x5 = ((t << 7) & _mask32) | (t >> 25);

    x1 = (x1 + x6) & _mask32;
    t = x12 ^ x1;
    x12 = ((t << 16) & _mask32) | (t >> 16);
    x11 = (x11 + x12) & _mask32;
    t = x6 ^ x11;
    x6 = ((t << 12) & _mask32) | (t >> 20);
    x1 = (x1 + x6) & _mask32;
    t = x12 ^ x1;
    x12 = ((t << 8) & _mask32) | (t >> 24);
    x11 = (x11 + x12) & _mask32;
    t = x6 ^ x11;
    x6 = ((t << 7) & _mask32) | (t >> 25);

    x2 = (x2 + x7) & _mask32;
    t = x13 ^ x2;
    x13 = ((t << 16) & _mask32) | (t >> 16);
    x8 = (x8 + x13) & _mask32;
    t = x7 ^ x8;
    x7 = ((t << 12) & _mask32) | (t >> 20);
    x2 = (x2 + x7) & _mask32;
    t = x13 ^ x2;
    x13 = ((t << 8) & _mask32) | (t >> 24);
    x8 = (x8 + x13) & _mask32;
    t = x7 ^ x8;
    x7 = ((t << 7) & _mask32) | (t >> 25);

    x3 = (x3 + x4) & _mask32;
    t = x14 ^ x3;
    x14 = ((t << 16) & _mask32) | (t >> 16);
    x9 = (x9 + x14) & _mask32;
    t = x4 ^ x9;
    x4 = ((t << 12) & _mask32) | (t >> 20);
    x3 = (x3 + x4) & _mask32;
    t = x14 ^ x3;
    x14 = ((t << 8) & _mask32) | (t >> 24);
    x9 = (x9 + x14) & _mask32;
    t = x4 ^ x9;
    x4 = ((t << 7) & _mask32) | (t >> 25);
  }
  // A Uint32List keeps the low 32 bits of what it is given.
  out[0] = x0 + c0;
  out[1] = x1 + c1;
  out[2] = x2 + c2;
  out[3] = x3 + c3;
  out[4] = x4 + k0;
  out[5] = x5 + k1;
  out[6] = x6 + k2;
  out[7] = x7 + k3;
  out[8] = x8 + k4;
  out[9] = x9 + k5;
  out[10] = x10 + k6;
  out[11] = x11 + k7;
  out[12] = x12 + counter;
  out[13] = x13 + n0;
  out[14] = x14 + n1;
  out[15] = x15 + n2;
}

/// Runs the full 16-byte blocks of [m] in `[start, end)` into the accumulator [h] (five 26-bit
/// limbs), under the clamped key [r] (r0..r4 then 5·r1..5·r4). Every block carries the 2^128 bit.
///
/// The accumulator lives in locals for the whole run and goes back to [h] once, at the end: a
/// closure over mutable locals boxes them, which is most of what made the first version slow.
void _polyBlocks(Int64List h, Int64List r, Uint8List m, int start, int end) {
  final r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3], r4 = r[4];
  final s1 = r[5], s2 = r[6], s3 = r[7], s4 = r[8];
  var h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4];
  for (var i = start; i < end; i += 16) {
    h0 += _le32(m, i) & _mask26;
    h1 += (_le32(m, i + 3) >> 2) & _mask26;
    h2 += (_le32(m, i + 6) >> 4) & _mask26;
    h3 += (_le32(m, i + 9) >> 6) & _mask26;
    h4 += (_le32(m, i + 12) >> 8) | (1 << 24);
    // Each limb is under 2^27 and each multiplier under 2^29, so a sum of five products stays
    // under 2^59.
    final d0 = h0 * r0 + h1 * s4 + h2 * s3 + h3 * s2 + h4 * s1;
    var d1 = h0 * r1 + h1 * r0 + h2 * s4 + h3 * s3 + h4 * s2;
    var d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s4 + h4 * s3;
    var d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s4;
    var d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    var c = d0 >> 26;
    h0 = d0 & _mask26;
    d1 += c;
    c = d1 >> 26;
    h1 = d1 & _mask26;
    d2 += c;
    c = d2 >> 26;
    h2 = d2 & _mask26;
    d3 += c;
    c = d3 >> 26;
    h3 = d3 & _mask26;
    d4 += c;
    c = d4 >> 26;
    h4 = d4 & _mask26;
    h0 += c * 5;
    c = h0 >> 26;
    h0 &= _mask26;
    h1 += c;
  }
  h[0] = h0;
  h[1] = h1;
  h[2] = h2;
  h[3] = h3;
  h[4] = h4;
}

/// [m]'s blocks, the last one zero-padded to 16 bytes — RFC 8439's `pad16`.
void _polySegment(Int64List h, Int64List r, Uint8List m, Uint8List scratch) {
  final whole = m.length - m.length % 16;
  _polyBlocks(h, r, m, 0, whole);
  if (whole < m.length) {
    scratch.fillRange(0, 16, 0);
    scratch.setRange(0, m.length - whole, m, whole);
    _polyBlocks(h, r, scratch, 0, 16);
  }
}

/// Poly1305 over RFC 8439's AEAD MAC input — `aad | pad16 | ciphertext | pad16 | len(aad) |
/// len(ciphertext)` — without building it.
Uint8List _aeadMac(Uint8List polyKey, Uint8List aad, Uint8List ciphertext) {
  final r0 = _le32(polyKey, 0) & 0x3ffffff;
  final r1 = (_le32(polyKey, 3) >> 2) & 0x3ffff03;
  final r2 = (_le32(polyKey, 6) >> 4) & 0x3ffc0ff;
  final r3 = (_le32(polyKey, 9) >> 6) & 0x3f03fff;
  final r4 = (_le32(polyKey, 12) >> 8) & 0x00fffff;
  final r = Int64List.fromList([
    r0,
    r1,
    r2,
    r3,
    r4,
    r1 * 5,
    r2 * 5,
    r3 * 5,
    r4 * 5,
  ]);
  final h = Int64List(5);
  final scratch = Uint8List(16);
  _polySegment(h, r, aad, scratch);
  _polySegment(h, r, ciphertext, scratch);
  ByteData.sublistView(scratch)
    ..setUint64(0, aad.length, Endian.little)
    ..setUint64(8, ciphertext.length, Endian.little);
  _polyBlocks(h, r, scratch, 0, 16);

  // Fully carry h, then take h - p when it is not negative, with no branch on the value.
  var h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4];
  var c = h1 >> 26;
  h1 &= _mask26;
  h2 += c;
  c = h2 >> 26;
  h2 &= _mask26;
  h3 += c;
  c = h3 >> 26;
  h3 &= _mask26;
  h4 += c;
  c = h4 >> 26;
  h4 &= _mask26;
  h0 += c * 5;
  c = h0 >> 26;
  h0 &= _mask26;
  h1 += c;
  var g0 = h0 + 5;
  c = g0 >> 26;
  g0 &= _mask26;
  var g1 = h1 + c;
  c = g1 >> 26;
  g1 &= _mask26;
  var g2 = h2 + c;
  c = g2 >> 26;
  g2 &= _mask26;
  var g3 = h3 + c;
  c = g3 >> 26;
  g3 &= _mask26;
  final g4 = h4 + c - (1 << 26);
  final keepH = g4 >> 63; // all ones when h < p
  final takeG = ~keepH;
  h0 = (h0 & keepH) | (g0 & takeG);
  h1 = (h1 & keepH) | (g1 & takeG);
  h2 = (h2 & keepH) | (g2 & takeG);
  h3 = (h3 & keepH) | (g3 & takeG);
  h4 = (h4 & keepH) | (g4 & _mask26 & takeG);

  // h mod 2^128, plus s.
  final w0 = (h0 | (h1 << 26)) & _mask32;
  final w1 = ((h1 >> 6) | (h2 << 20)) & _mask32;
  final w2 = ((h2 >> 12) | (h3 << 14)) & _mask32;
  final w3 = ((h3 >> 18) | (h4 << 8)) & _mask32;
  final tag = ByteData(16);
  var f = w0 + _le32(polyKey, 16);
  tag.setUint32(0, f & _mask32, Endian.little);
  f = w1 + _le32(polyKey, 20) + (f >> 32);
  tag.setUint32(4, f & _mask32, Endian.little);
  f = w2 + _le32(polyKey, 24) + (f >> 32);
  tag.setUint32(8, f & _mask32, Endian.little);
  f = w3 + _le32(polyKey, 28) + (f >> 32);
  tag.setUint32(12, f & _mask32, Endian.little);
  return tag.buffer.asUint8List();
}

Uint32List _words(Uint8List bytes, int count) {
  final words = Uint32List(count);
  for (var i = 0; i < count; i++) {
    words[i] = _le32(bytes, i * 4);
  }
  return words;
}

/// The one-time Poly1305 key: the first 32 bytes of block 0.
Uint8List _polyKey(Uint32List key, Uint32List nonce) =>
    _chacha20Xor(key, nonce, 0, Uint8List(32));

/// RFC 8439 §2.8 seal: [plaintext] encrypted under a 32-byte [key] and 12-byte [nonce], followed
/// by its 16-byte tag.
Uint8List chacha20Poly1305Seal(
  List<int> key,
  List<int> nonce,
  List<int> aad,
  List<int> plaintext,
) {
  _checkSizes(key, nonce);
  final keyWords = _words(_typed(key), 8);
  final nonceWords = _words(_typed(nonce), 3);
  final ciphertext = _chacha20Xor(keyWords, nonceWords, 1, _typed(plaintext));
  final tag = _aeadMac(_polyKey(keyWords, nonceWords), _typed(aad), ciphertext);
  return Uint8List(ciphertext.length + aeadTagLength)
    ..setRange(0, ciphertext.length, ciphertext)
    ..setRange(ciphertext.length, ciphertext.length + aeadTagLength, tag);
}

/// The inverse of [chacha20Poly1305Seal]; null when [sealed] is shorter than a tag or its tag does
/// not verify. Nothing is decrypted before the tag is checked.
Uint8List? chacha20Poly1305Open(
  List<int> key,
  List<int> nonce,
  List<int> aad,
  List<int> sealed,
) {
  _checkSizes(key, nonce);
  if (sealed.length < aeadTagLength) return null;
  final bytes = _typed(sealed);
  final split = bytes.length - aeadTagLength;
  final ciphertext = Uint8List.sublistView(bytes, 0, split);
  final keyWords = _words(_typed(key), 8);
  final nonceWords = _words(_typed(nonce), 3);
  final expected = _aeadMac(
    _polyKey(keyWords, nonceWords),
    _typed(aad),
    ciphertext,
  );
  var diff = 0;
  for (var i = 0; i < aeadTagLength; i++) {
    diff |= expected[i] ^ bytes[split + i];
  }
  if (diff != 0) return null;
  return _chacha20Xor(keyWords, nonceWords, 1, ciphertext);
}

void _checkSizes(List<int> key, List<int> nonce) {
  if (key.length != 32) {
    throw ArgumentError.value(key.length, 'key', 'must be 32 bytes');
  }
  if (nonce.length != 12) {
    throw ArgumentError.value(nonce.length, 'nonce', 'must be 12 bytes');
  }
}
