// The cable's framing (port of devices/harness-pro/firmware/main/cable/cable_frame.c): a byte stream into frames, and
// frames back into bytes. Checked against the shared vectors (cli/src/cable/vectors/cable_frame.txt), as the C and the
// daemon's TypeScript are.
//
//   A5 48 | ver:u8 | type:u8 | len:u16 LE | payload[len] | crc16:u16 LE
//
// The magic is what the reader scans for after losing its place; the CRC (CRC-16/CCITT-FALSE over ver..payload) tells a
// real frame from noise that happened to look like the magic.
import 'dart:typed_data';

const int kCableMagic0 = 0xA5;

/// 'H': Harness. A sibling product's frames carry another second byte and never decode here.
const int kCableMagic1 = 0x48;
const int kCableFrameVersion = 1;
const int kCableHeaderBytes = 6;
const int kCableCrcBytes = 2;

/// A bound on damage, not a capacity: a corrupt length field cannot hold the reader waiting for more than this.
const int kCableMaxPayload = 8192;
const int kCableMaxFrame = kCableHeaderBytes + kCableMaxPayload + kCableCrcBytes;

/// UTF-8 JSON with a "t" discriminator: the vocabulary.
const int kCableTypeJson = 0x01;

/// One chunk of 16-bit mono PCM, bar to daemon, during a recording.
const int kCableTypePcm = 0x02;

/// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor ("123456789" = 0x29B1).
int cableCrc16(Uint8List data, [int start = 0, int? end]) {
  var crc = 0xFFFF;
  final stop = end ?? data.length;
  for (var i = start; i < stop; i++) {
    crc ^= data[i] << 8;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/// The frame carrying [payload], or null when it is over [kCableMaxPayload]: an oversized message is a bug on this
/// side, and the far end could only ever report it as noise.
Uint8List? encodeCableFrame(int type, List<int> payload) {
  if (payload.length > kCableMaxPayload) return null;
  final total = kCableHeaderBytes + payload.length + kCableCrcBytes;
  final out = Uint8List(total);
  out[0] = kCableMagic0;
  out[1] = kCableMagic1;
  out[2] = kCableFrameVersion;
  out[3] = type & 0xFF;
  out[4] = payload.length & 0xFF;
  out[5] = (payload.length >> 8) & 0xFF;
  out.setRange(kCableHeaderBytes, kCableHeaderBytes + payload.length, payload);
  // Covers ver..payload: the magic is a marker, not data.
  final crc = cableCrc16(out, 2, kCableHeaderBytes + payload.length);
  out[total - 2] = crc & 0xFF;
  out[total - 1] = (crc >> 8) & 0xFF;
  return out;
}

/// Called once per decoded frame. [payload] is the frame's own copy.
typedef CableFrameHandler = void Function(int version, int type, Uint8List payload);

/// Reassembles frames from a byte stream that may start anywhere and contain anything. Never fails: the only useful
/// answer to a byte that makes no sense is to step over it.
class CableDecoder {
  Uint8List _buf = Uint8List(1024);
  int _start = 0, _end = 0;

  /// The rate tells a bootloader's parting words (a few bytes) from two sides that disagree (a steady trickle).
  int corruptFrames = 0;
  int discardedBytes = 0;

  /// Bytes of a frame not yet complete.
  int get pending => _end - _start;

  /// Forget a partial frame (a new connection: leftover bytes belong to a session that ended). The counters stay:
  /// they show a trend across reconnects.
  void reset() {
    _start = _end = 0;
  }

  /// Feed bytes and emit every frame they complete, in order.
  void feed(List<int> data, CableFrameHandler onFrame) {
    if (data.isEmpty) return;
    _append(data);
    // Only worth trying once a header could be complete (as the C, so the counters agree byte for byte).
    if (pending >= kCableHeaderBytes) {
      while (_takeFront(onFrame)) {}
    }
    _compact();
  }

  /// The link went quiet with bytes pending: give up on a partial frame (counted corrupt, as a bad CRC is) and resync,
  /// delivering any whole frame behind it. True when a partial frame was dropped.
  bool expire(CableFrameHandler onFrame) {
    if (pending == 0) return false;
    final partial = pending >= 2 && _buf[_start] == kCableMagic0 && _buf[_start + 1] == kCableMagic1;
    if (partial) {
      // Step over the magic, not the whole buffer: a whole frame may sit behind a lost tail.
      corruptFrames++;
      _discard(1);
    }
    while (_takeFront(onFrame)) {}
    // A lone trailing A5 can no longer start anything.
    if (pending > 0) _discard(pending);
    _compact();
    return partial;
  }

  void _append(List<int> data) {
    if (_end + data.length > _buf.length) {
      final need = pending + data.length;
      if (need > _buf.length) {
        var size = _buf.length;
        while (size < need) {
          size *= 2;
        }
        final grown = Uint8List(size)..setRange(0, pending, _buf, _start);
        _buf = grown;
      } else {
        _buf.setRange(0, pending, _buf, _start);
      }
      _end = pending;
      _start = 0;
    }
    _buf.setRange(_end, _end + data.length, data);
    _end += data.length;
  }

  void _compact() {
    if (_start == _end) _start = _end = 0;
  }

  void _consume(int count) {
    _start += count < pending ? count : pending;
  }

  // Bytes that turned out not to be a frame. Split from _consume: a frame that decoded fine is not noise.
  void _discard(int count) {
    final dropped = count < pending ? count : pending;
    _consume(count);
    discardedBytes += dropped;
  }

  // Offset (from _start) of the next complete magic, or -1. Stops one short of the end: a final lone byte cannot be
  // judged yet.
  int _indexOfMagic() {
    for (var i = _start; i + 1 < _end; i++) {
      if (_buf[i] == kCableMagic0 && _buf[i + 1] == kCableMagic1) return i - _start;
    }
    return -1;
  }

  // One frame off the front: true when a frame was emitted (try again), false when more bytes are needed.
  bool _takeFront(CableFrameHandler onFrame) {
    for (;;) {
      final headIsMagic = pending >= 2 && _buf[_start] == kCableMagic0 && _buf[_start + 1] == kCableMagic1;
      if (!headIsMagic) {
        final at = _indexOfMagic();
        if (at < 0) {
          // Keep a trailing A5: its 48 may not have arrived yet.
          final keep = pending > 0 && _buf[_end - 1] == kCableMagic0 ? 1 : 0;
          _discard(pending - keep);
          return false;
        }
        _discard(at);
        continue;
      }
      if (pending < kCableHeaderBytes) return false;
      final payloadLen = _buf[_start + 4] | (_buf[_start + 5] << 8);
      // A length this large cannot be real: those bytes were noise. Step over one and keep hunting.
      if (payloadLen > kCableMaxPayload) {
        _discard(1);
        continue;
      }
      final total = kCableHeaderBytes + payloadLen + kCableCrcBytes;
      if (pending < total) return false;
      final expected = _buf[_start + total - 2] | (_buf[_start + total - 1] << 8);
      final actual = cableCrc16(_buf, _start + 2, _start + kCableHeaderBytes + payloadLen);
      if (actual != expected) {
        // One byte, not the frame: the magic may have been a coincidence and a real frame may begin one byte in.
        corruptFrames++;
        _discard(1);
        continue;
      }
      final version = _buf[_start + 2], type = _buf[_start + 3];
      final payload = Uint8List.fromList(
        Uint8List.sublistView(_buf, _start + kCableHeaderBytes, _start + kCableHeaderBytes + payloadLen),
      );
      _consume(total);
      onFrame(version, type, payload);
      return true;
    }
  }
}
