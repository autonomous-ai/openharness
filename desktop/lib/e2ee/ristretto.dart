import 'dart:typed_data';

import 'bytes.dart';
import 'primitives.dart';
import 'ristretto_field.dart';

/// ristretto255 points and hash-to-group — core.ts's `RistrettoPoint` and `hashToRistretto255`,
/// which both CPace generators (the 6-character code and the remote password) are built from.

/// An edwards25519 point in extended coordinates (a = −1).
class EdwardsPoint {
  const EdwardsPoint(this.x, this.y, this.z, this.t);

  final BigInt x, y, z, t;

  static final EdwardsPoint zero = EdwardsPoint(
    BigInt.zero,
    BigInt.one,
    BigInt.one,
    BigInt.zero,
  );

  static final BigInt _k = fmod(edwardsD * BigInt.two);

  /// add-2008-hwcd-3.
  EdwardsPoint add(EdwardsPoint o) {
    final a = fmod((y - x) * (o.y - o.x));
    final b = fmod((y + x) * (o.y + o.x));
    final c = fmod(t * _k * o.t);
    final d = fmod(z * BigInt.two * o.z);
    final e = fmod(b - a), f = fmod(d - c), g = fmod(d + c), h = fmod(b + a);
    return EdwardsPoint(fmod(e * f), fmod(g * h), fmod(f * g), fmod(e * h));
  }

  /// dbl-2008-hwcd.
  EdwardsPoint double() {
    final a = fmod(x * x);
    final b = fmod(y * y);
    final c = fmod(BigInt.two * z * z);
    final d = fmod(-a);
    final e = fmod((x + y) * (x + y) - a - b);
    final g = fmod(d + b), f = fmod(g - c), h = fmod(d - b);
    return EdwardsPoint(fmod(e * f), fmod(g * h), fmod(f * g), fmod(e * h));
  }

  EdwardsPoint multiply(BigInt scalar) {
    var result = zero;
    var addend = this;
    for (var k = scalar; k > BigInt.zero; k = k >> 1) {
      if (k.isOdd) result = result.add(addend);
      addend = addend.double();
    }
    return result;
  }
}

class RistrettoPoint {
  const RistrettoPoint(this.ep);

  final EdwardsPoint ep;

  static final RistrettoPoint zero = RistrettoPoint(EdwardsPoint.zero);

  /// Decodes a canonical 32-byte encoding; throws [ArgumentError] on anything else, as noble's
  /// `fromHex` does — the peer's CPace share is untrusted input.
  factory RistrettoPoint.fromBytes(List<int> bytes) {
    if (bytes.length != 32) throw ArgumentError('ristretto255: not 32 bytes');
    final s = bytes255ToNumberLe(bytes);
    if (!ctEqual(numberToBytesLe(s, 32), bytes) || isNegativeLe(s)) {
      throw ArgumentError('ristretto255: non-canonical encoding');
    }
    final s2 = fmod(s * s);
    final u1 = fmod(BigInt.one + edwardsA * s2);
    final u2 = fmod(BigInt.one - edwardsA * s2);
    final u2Sq = fmod(u2 * u2);
    final v = fmod(edwardsA * edwardsD * u1 * u1 - u2Sq);
    final inv = uvRatio(BigInt.one, fmod(v * u2Sq));
    final dx = fmod(inv.value * u2);
    final dy = fmod(inv.value * dx * v);
    var x = fmod((s + s) * dx);
    if (isNegativeLe(x)) x = fmod(-x);
    final y = fmod(u1 * dy);
    final t = fmod(x * y);
    if (!inv.isValid || isNegativeLe(t) || y == BigInt.zero) {
      throw ArgumentError('ristretto255: invalid encoding');
    }
    return RistrettoPoint(EdwardsPoint(x, y, BigInt.one, t));
  }

  Uint8List toBytes() {
    var x = ep.x, y = ep.y;
    final z = ep.z, t = ep.t;
    final u1 = fmod(fmod(z + y) * fmod(z - y));
    final u2 = fmod(x * y);
    final invSqrt = uvRatio(BigInt.one, fmod(u1 * u2 * u2)).value;
    final d1 = fmod(invSqrt * u1);
    final d2 = fmod(invSqrt * u2);
    final zInv = fmod(d1 * d2 * t);
    BigInt d;
    if (isNegativeLe(t * zInv)) {
      final rotatedX = fmod(y * sqrtM1);
      y = fmod(x * sqrtM1);
      x = rotatedX;
      d = fmod(d1 * invSqrtAMinusD);
    } else {
      d = d2;
    }
    if (isNegativeLe(x * zInv)) y = fmod(-y);
    var s = fmod((z - y) * d);
    if (isNegativeLe(s)) s = fmod(-s);
    return numberToBytesLe(s, 32);
  }

  RistrettoPoint multiply(BigInt scalar) => RistrettoPoint(ep.multiply(scalar));

  RistrettoPoint add(RistrettoPoint other) => RistrettoPoint(ep.add(other.ep));

  bool equals(RistrettoPoint other) {
    final a = ep, b = other.ep;
    return fmod(a.x * b.y) == fmod(a.y * b.x) ||
        fmod(a.y * b.y) == fmod(a.x * b.x);
  }
}

/// RFC 9496 Elligator map (noble `calcElligatorRistrettoMap`).
EdwardsPoint _elligator(BigInt r0) {
  final r = fmod(sqrtM1 * r0 * r0);
  final ns = fmod((r + BigInt.one) * oneMinusDSq);
  var c = fmod(-BigInt.one);
  final den = fmod((c - edwardsD * r) * fmod(r + edwardsD));
  final ratio = uvRatio(ns, den);
  var s = ratio.value;
  var sPrime = fmod(s * r0);
  if (!isNegativeLe(sPrime)) sPrime = fmod(-sPrime);
  if (!ratio.isValid) {
    s = sPrime;
    c = r;
  }
  final nt = fmod(c * (r - BigInt.one) * dMinusOneSq - den);
  final s2 = fmod(s * s);
  final w0 = fmod((s + s) * den);
  final w1 = fmod(nt * sqrtAdMinusOne);
  final w2 = fmod(BigInt.one - s2);
  final w3 = fmod(BigInt.one + s2);
  return EdwardsPoint(fmod(w0 * w3), fmod(w2 * w1), fmod(w1 * w3), fmod(w0 * w2));
}

/// noble `hashToRistretto255`: expand_message_xmd(SHA-512) to 64 bytes, then the one-way map.
RistrettoPoint hashToRistretto255(List<int> message, List<int> dst) {
  final uniform = expandMessageXmd(message, dst, 64);
  final r1 = _elligator(bytes255ToNumberLe(uniform.sublist(0, 32)));
  final r2 = _elligator(bytes255ToNumberLe(uniform.sublist(32, 64)));
  return RistrettoPoint(r1.add(r2));
}

/// RFC 9380 §5.3.1 expand_message_xmd with SHA-512 (b_in_bytes 64, s_in_bytes 128).
Uint8List expandMessageXmd(List<int> message, List<int> dst, int length) {
  if (dst.length > 255) throw ArgumentError('expand_message_xmd: DST too long');
  final ell = (length + 63) ~/ 64;
  final dstPrime = [...dst, dst.length];
  final b0 = sha512([
    ...Uint8List(128),
    ...message,
    (length >> 8) & 0xff,
    length & 0xff,
    0,
    ...dstPrime,
  ]);
  final out = BytesBuilder(copy: false);
  var previous = sha512([...b0, 1, ...dstPrime]);
  out.add(previous);
  for (var i = 2; i <= ell; i++) {
    final mixed = [for (var j = 0; j < 64; j++) b0[j] ^ previous[j]];
    previous = sha512([...mixed, i, ...dstPrime]);
    out.add(previous);
  }
  return Uint8List.sublistView(out.takeBytes(), 0, length);
}
