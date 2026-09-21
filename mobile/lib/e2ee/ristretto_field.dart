import 'dart:typed_data';

/// Arithmetic over GF(2^255 − 19) for ristretto255 (RFC 9496), ported from the noble-curves code
/// core.ts runs. Pure BigInt and NOT constant-time: it only ever touches the one-shot CPace
/// exchange of a link attempt, never a session key or a frame.

final BigInt fieldP = BigInt.parse(
  '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed',
  radix: 16,
);

/// The prime order L of the ristretto255 group.
final BigInt curveOrder = BigInt.parse(
  '1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed',
  radix: 16,
);

final BigInt edwardsD = BigInt.parse(
  '52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3',
  radix: 16,
);

/// a = −1, reduced.
final BigInt edwardsA = fieldP - BigInt.one;

final BigInt sqrtM1 = BigInt.parse(
  '19681161376707505956807079304988542015446066515923890162744021073123829784752',
);
final BigInt sqrtAdMinusOne = BigInt.parse(
  '25063068953384623474111414158702152701244531502492656460079210482610430750235',
);
final BigInt invSqrtAMinusD = BigInt.parse(
  '54469307008909316920995813868745141605393597292927456921205312896311721017578',
);
final BigInt oneMinusDSq = BigInt.parse(
  '1159843021668779879193775521855586647937357759715417654439879720876111806838',
);
final BigInt dMinusOneSq = BigInt.parse(
  '40440834346308536858101042469323190826248399146238708352240133220865137265952',
);

final BigInt _mask255 = (BigInt.one << 255) - BigInt.one;
final BigInt _pMinus5Over8 = (fieldP - BigInt.from(5)) >> 3;

/// Dart's BigInt `%` is Euclidean, so this is always in [0, p).
BigInt fmod(BigInt n) => n % fieldP;

BigInt bytesToNumberLe(List<int> bytes) {
  var n = BigInt.zero;
  for (var i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8) | BigInt.from(bytes[i]);
  }
  return n;
}

Uint8List numberToBytesLe(BigInt n, int length) {
  final out = Uint8List(length);
  var rest = n;
  for (var i = 0; i < length; i++) {
    out[i] = (rest & BigInt.from(0xff)).toInt();
    rest = rest >> 8;
  }
  return out;
}

/// noble `bytes255ToNumberLE`: the low 255 bits, reduced.
BigInt bytes255ToNumberLe(List<int> bytes) =>
    fmod(bytesToNumberLe(bytes) & _mask255);

bool isNegativeLe(BigInt n) => fmod(n).isOdd;

typedef SqrtRatio = ({bool isValid, BigInt value});

/// noble `uvRatio`: sqrt(u/v) when it exists. On failure the value is still a root of something,
/// because the Elligator map below uses it either way.
SqrtRatio uvRatio(BigInt u, BigInt v) {
  final v3 = fmod(v * v * v);
  final v7 = fmod(v3 * v3 * v);
  final pow = fmod(u * v7).modPow(_pMinus5Over8, fieldP);
  var x = fmod(u * v3 * pow);
  final vx2 = fmod(v * x * x);
  final root1 = x;
  final root2 = fmod(x * sqrtM1);
  final useRoot1 = vx2 == fmod(u);
  final useRoot2 = vx2 == fmod(-u);
  final noRoot = vx2 == fmod(-u * sqrtM1);
  if (useRoot1) x = root1;
  if (useRoot2 || noRoot) x = root2;
  if (isNegativeLe(x)) x = fmod(-x);
  return (isValid: useRoot1 || useRoot2, value: x);
}
