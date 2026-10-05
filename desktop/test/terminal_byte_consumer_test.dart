import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/core.dart';
import 'package:xterm/src/utils/byte_consumer.dart';

List<int> drain(ByteConsumer consumer) => [
  for (; consumer.isNotEmpty;) consumer.consume(),
];

Object screen(Terminal terminal) => {
  'cursor': [terminal.buffer.cursorX, terminal.buffer.cursorY],
  'visible': terminal.cursorVisibleMode,
  'alternate': terminal.isUsingAltBuffer,
  'lines': [
    for (var i = 0; i < terminal.buffer.lines.length; i++)
      {
        'data': terminal.buffer.lines[i].data.toList(),
        'wrapped': terminal.buffer.lines[i].isWrapped,
        'links': [
          for (var x = 0; x < terminal.buffer.lines[i].length; x++)
            terminal.buffer.lines[i].getHyperlink(x),
        ],
      },
  ],
};

void main() {
  test(
    'Latin-1 includes controls and accents without changing code points',
    () {
      final expected = List.generate(256, (code) => code);
      final consumer = ByteConsumer()..add(String.fromCharCodes(expected));
      expect(consumer.length, 256);
      expect(drain(consumer), expected);
      consumer.rollback(256);
      expect(drain(consumer), expected);
    },
  );

  test('every non-surrogate BMP code point retains its value', () {
    final expected = [
      for (var code = 0; code <= 0xffff; code++)
        if (code < 0xd800 || code > 0xdfff) code,
    ];
    final consumer = ByteConsumer()..add(String.fromCharCodes(expected));
    expect(consumer.length, expected.length);
    expect(drain(consumer), expected);
    expect(consumer.totalConsumed, expected.length);
    expect(consumer.isEmpty, isTrue);
  });

  test(
    'supplementary and unpaired surrogates keep per-chunk rune semantics',
    () {
      final chunks = [
        '',
        'ASCII\x00\x1b[32m',
        'Việt Nam 漢字 │',
        '😀🐙\u{10000}\u{10ffff}',
        '\ud800x\udfff',
        '\ud83d',
        '\ude00',
      ];
      final expected = chunks.expand((chunk) => chunk.runes).toList();
      final consumer = ByteConsumer();
      for (final chunk in chunks) {
        consumer.add(chunk);
      }
      expect(consumer.length, expected.length);
      expect(drain(consumer), expected);
    },
  );

  test('peek and rollback preserve rune positions across mixed blocks', () {
    final consumer = ByteConsumer()
      ..add('abc')
      ..add('😀é')
      ..add('漢\x1b[32m');
    final expected = 'abc😀é漢\x1b[32m'.runes.toList();
    expect(drain(consumer), expected);
    consumer.rollback(expected.length);
    expect(consumer.totalConsumed, 0);
    for (final code in expected) {
      final length = consumer.length;
      expect(consumer.peek(), code);
      expect(consumer.peek(), code);
      expect(consumer.length, length);
      expect(consumer.consume(), code);
    }
    consumer.rollbackTo(4);
    expect(drain(consumer), expected.sublist(expected.length - 4));
  });

  test('forgetting consumed blocks and resetting do not retain old text', () {
    final consumer = ByteConsumer()
      ..add('abc')
      ..add('😀xyz');
    for (var i = 0; i < 4; i++) {
      consumer.consume();
    }
    consumer.unrefConsumedBlocks();
    consumer.rollback();
    expect(consumer.peek(), 0x1f600);
    expect(drain(consumer), '😀xyz'.runes.toList());
    consumer.reset();
    expect(consumer.length, 0);
    expect(consumer.totalConsumed, 0);
    consumer.add('next');
    expect(drain(consumer), 'next'.codeUnits);
  });

  test('mixed append/consume/rewind operations match a flat rune stream', () {
    final random = Random(670);
    final consumer = ByteConsumer();
    final expected = <int>[];
    var position = 0;
    const chunks = ['abc', '漢é', '😀z', '\ud800', '\udfff', '\x1b[32m', ''];
    for (var step = 0; step < 5000; step++) {
      switch (random.nextInt(4)) {
        case 0:
          final chunk = chunks[random.nextInt(chunks.length)];
          consumer.add(chunk);
          expected.addAll(chunk.runes);
        case 1:
          if (position < expected.length) {
            expect(consumer.consume(), expected[position++]);
          }
        case 2:
          if (position > 0) {
            final count = random.nextInt(position + 1);
            consumer.rollback(count);
            position -= count;
          }
        case 3:
          if (position < expected.length) {
            expect(consumer.peek(), expected[position]);
          }
      }
      expect(consumer.totalConsumed, position);
      expect(consumer.length, expected.length - position);
      expect(consumer.isEmpty, position == expected.length);
    }
    expect(drain(consumer), expected.sublist(position));
  });

  test(
    'fragmented ANSI, Unicode and hyperlinks preserve screen and replies',
    () {
      const text =
          'plain Việt Nam 漢字 😀\r\n'
          '\x1b[32mgreen\x1b[0m\r\n'
          '\x1b]0;title 漢 😀\x07'
          '\x1b]8;;https://example.com/ảnh\x1b\\linked\x1b]8;;\x1b\\'
          '\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\'
          '\x1b7\x1b[2;3Hwrite\x1b8\x1b[6n'
          '\x1b[?25l\x1b[?25h tail';
      final expectedReplies = <String>[];
      final expectedTitles = <String>[];
      final expected = Terminal(
        onOutput: expectedReplies.add,
        onTitleChange: expectedTitles.add,
      )..write(text);
      final scalars = text.runes.map(String.fromCharCode).toList();
      for (final chunkSize in [1, 2, 3, 7, 31, 128]) {
        final replies = <String>[];
        final titles = <String>[];
        final terminal = Terminal(
          onOutput: replies.add,
          onTitleChange: titles.add,
        );
        for (var start = 0; start < scalars.length; start += chunkSize) {
          terminal.write(
            scalars
                .sublist(start, min(start + chunkSize, scalars.length))
                .join(),
          );
        }
        expect(
          jsonEncode(screen(terminal)),
          jsonEncode(screen(expected)),
          reason: 'chunk size $chunkSize',
        );
        expect(replies, expectedReplies);
        expect(titles, expectedTitles);
      }
      expect(expected.buffer.getText(), contains('linked'));
      expect(expected.buffer.getText(), isNot(contains('tmux;')));
      expect(expectedTitles, ['title 漢 😀']);
      expect(expectedReplies, isNotEmpty);
    },
  );
}
