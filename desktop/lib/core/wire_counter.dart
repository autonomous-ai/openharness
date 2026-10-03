import 'dart:typed_data';

/// The protocol shares JavaScript's exact integer range with the daemon.
const maxSafeInteger = 9007199254740991;
const _word = 4294967296;

/// Write a big-endian u64 using two u32 words. Dart's JS runtime does not
/// implement ByteData's uint64 accessors, and JS shifts truncate to 32 bits.
/// Reject overflow rather than rounding a sequence or reusing an AEAD nonce.
void writeWireCounter(ByteData data, int offset, int value) {
  RangeError.checkValueInInterval(value, 0, maxSafeInteger, 'counter');
  data.setUint32(offset, value ~/ _word, Endian.big);
  data.setUint32(offset + 4, value % _word, Endian.big);
}

/// Null means a counter outside the exact range; callers discard that frame.
int? readWireCounter(ByteData data, int offset) {
  final upper = data.getUint32(offset, Endian.big);
  if (upper > 0x1fffff) return null;
  return upper * _word + data.getUint32(offset + 4, Endian.big);
}
