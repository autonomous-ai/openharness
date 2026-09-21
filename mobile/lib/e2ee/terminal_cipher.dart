import 'dart:typed_data';

import '../terminal/terminal_binary.dart';
import 'bytes.dart';
import 'primitives.dart';
import 'replay_window.dart';

/// HTRM v3 — terminalBinary.ts's encrypted binary terminal frame, the only form terminal bytes take
/// on the relay. The plaintext inside is the same one the loopback HTRL frame carries
/// ([encodeTerminalPlain]), which is what lets the transport convert between the two and leave
/// every terminal session unaware of which it is on.
///
/// Header (20 bytes): `HTRM` | version | kind | flags | 0 | u64 counter | u32 ciphertext length.
/// The first 16 bytes are the AAD; the counter is the nonce.

const int terminalBinaryVersion = 3;
const int terminalBinaryHeaderBytes = 20;
const int _aadBytes = 16;
const int _tagBytes = 16;
const int _flagZlib = 1;
final Uint8List _magic = Uint8List.fromList(const [0x48, 0x54, 0x52, 0x4d]);

/// Binary frames get their own key, so their nonces never collide with the JSON frames'.
Uint8List deriveTerminalBinaryKey(List<int> sessionKey) => hkdfSha256(
  sessionKey,
  info: utf8Bytes('harness-terminal-binary-v3'),
  length: 32,
);

Uint8List? sealTerminalBinary(
  List<int> key,
  int counter,
  TerminalBinaryFrame frame,
) {
  if (counter < 0 || counter > maxSafeInteger) return null;
  final plaintext = encodeTerminalPlain(frame);
  if (plaintext == null) return null;
  final header = Uint8List(terminalBinaryHeaderBytes)..setRange(0, 4, _magic);
  header[4] = terminalBinaryVersion;
  header[5] = frame.kind.code;
  header[6] = frame.compressed ? _flagZlib : 0;
  final view = ByteData.sublistView(header)..setUint64(8, counter);
  final ciphertext = aeadSeal(
    key,
    counter,
    Uint8List.sublistView(header, 0, _aadBytes),
    plaintext,
  );
  if (ciphertext.length > maxTerminalPayloadBytesFor(frame.kind)) return null;
  view.setUint32(16, ciphertext.length);
  return concatBytes([header, ciphertext]);
}

/// The frame inside [raw] and the counter it was sealed under; null for anything malformed or
/// unauthentic. Replay is the caller's to check — the counter is returned for that.
({int counter, TerminalBinaryFrame frame})? openTerminalBinary(
  List<int> key,
  Uint8List raw,
) {
  if (raw.length < terminalBinaryHeaderBytes + _tagBytes) return null;
  for (var i = 0; i < _magic.length; i++) {
    if (raw[i] != _magic[i]) return null;
  }
  final kind = TerminalBinaryKind.fromCode(raw[5]);
  if (raw[4] != terminalBinaryVersion || kind == null || raw[7] != 0) {
    return null;
  }
  final view = ByteData.sublistView(raw);
  final counter = view.getUint64(8);
  final length = view.getUint32(16);
  if (counter < 0 ||
      counter > maxSafeInteger ||
      length < _tagBytes ||
      length > maxTerminalPayloadBytesFor(kind) ||
      raw.length != terminalBinaryHeaderBytes + length) {
    return null;
  }
  final plaintext = aeadOpen(
    key,
    counter,
    Uint8List.sublistView(raw, 0, _aadBytes),
    Uint8List.sublistView(raw, terminalBinaryHeaderBytes),
  );
  if (plaintext == null) return null;
  final frame = decodeTerminalPlain(kind, raw[6], plaintext);
  return frame == null ? null : (counter: counter, frame: frame);
}
