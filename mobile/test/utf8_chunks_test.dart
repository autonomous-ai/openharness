import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/utf8_chunks.dart';

/// pty output arrives in chunks cut wherever the socket cut them — mid-character
/// as often as not, for the glyphs a TUI draws.
void main() {
  /// [text] delivered in two chunks cut at every byte, reassembled the way the
  /// session does it.
  List<String> everyCut(String text) {
    final bytes = utf8.encode(text);
    return [
      for (var cut = 0; cut <= bytes.length; cut++)
        () {
          final first = decodeUtf8Chunk(bytes.sublist(0, cut));
          final second = decodeUtf8Chunk([
            ...first.tail,
            ...bytes.sublist(cut),
          ]);
          expect(second.tail, isEmpty);
          return first.text + second.text;
        }(),
    ];
  }

  test('a character cut anywhere comes out whole', () {
    for (final text in ['⏺ Done', 'Hôm nay là thứ mấy?', '─┬─', 'ship 🚀 it']) {
      expect(everyCut(text), everyElement(text), reason: text);
    }
  });

  test('a chunk that ends on a whole character keeps nothing back', () {
    final decoded = decodeUtf8Chunk(utf8.encode('plain ascii ⏺'));

    expect(decoded.text, 'plain ascii ⏺');
    expect(decoded.tail, isEmpty);
  });

  test('bytes that lead nowhere render as U+FFFD, and the rest survives', () {
    // A continuation byte with nothing before it — a snapshot cut — then text,
    // then the first byte of a character still to come.
    final decoded = decodeUtf8Chunk([0x8F, ...utf8.encode('ok'), 0xE2]);

    expect(decoded.text, '�ok');
    expect(decoded.tail, [0xE2]);
  });
}
