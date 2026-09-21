import 'dart:convert';

const _lenient = Utf8Decoder(allowMalformed: true);

/// One chunk of pty output as text, and the bytes at its end that begin a
/// character the next chunk finishes.
///
/// ⚠️ **The split is found by reading the last three bytes, not by decoding
/// and retrying.** A chunk cut mid-character is ordinary — every ⏺, box rule
/// and accented Vietnamese letter a TUI draws is two to four bytes — and the
/// old way decoded the whole chunk up to four times over, throwing and
/// catching a `FormatException` on each miss, on the UI thread.
///
/// Malformed bytes anywhere else render as U+FFFD, as a real terminal renders
/// them: a snapshot cut can land inside a character, and resyncing the whole
/// screen cannot recover the byte that was cut off anyway.
({String text, List<int> tail}) decodeUtf8Chunk(List<int> bytes) {
  final end = bytes.length - _unfinishedTail(bytes);
  return (
    text: _lenient.convert(bytes, 0, end),
    tail: end == bytes.length ? const [] : bytes.sublist(end),
  );
}

/// How many bytes at the end of [bytes] begin a character not yet complete.
int _unfinishedTail(List<int> bytes) {
  // A character is at most four bytes, so its lead byte is at most three back
  // from the last one.
  for (var back = 1; back <= 4 && back <= bytes.length; back++) {
    final byte = bytes[bytes.length - back];
    if (byte & 0xC0 == 0x80) continue; // A continuation byte: keep looking.
    final length = byte >= 0xF0
        ? 4
        : byte >= 0xE0
        ? 3
        : byte >= 0xC0
        ? 2
        : 1;
    return length > back ? back : 0;
  }
  // Only continuation bytes: nothing leads them, so there is nothing to wait
  // for — they are malformed, and render as such.
  return 0;
}
