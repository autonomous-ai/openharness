import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_links.dart';
import 'package:xterm/xterm.dart';

void main() {
  final cases = <(String, String, String)>[
    ('Saved /tmp/preview.png.', 'preview', '/tmp/preview.png'),
    (
      'Video: /tmp/My clips/demo (final).MP4',
      'final',
      '/tmp/My clips/demo (final).MP4',
    ),
    ('`/tmp/My art/ảnh 🖼️.png`', 'My art', '/tmp/My art/ảnh 🖼️.png'),
    ('"~/Pictures/My image.heic"', 'image', '~/Pictures/My image.heic'),
    (
      '[Watch video](</tmp/My clips/clip.mov>)',
      'Watch',
      '/tmp/My clips/clip.mov',
    ),
    ('![Image](/tmp/preview.webp)', 'Image', '/tmp/preview.webp'),
    (
      'Open file:///tmp/My%20art/preview.png',
      'preview',
      'file:///tmp/My%20art/preview.png',
    ),
    (
      'See https://example.com/a.mp4?token=a%2Fb&v=2.',
      'a.mp4',
      'https://example.com/a.mp4?token=a%2Fb&v=2',
    ),
    (
      '(https://example.com/a_(v2).mp4).',
      'v2',
      'https://example.com/a_(v2).mp4',
    ),
    ('/tmp/one.png and /tmp/two.mp4', 'two', '/tmp/two.mp4'),
    ('output/preview.gif', 'preview', 'output/preview.gif'),
    (
      r'C:\Users\Me\My art\preview.png',
      'preview',
      r'C:\Users\Me\My art\preview.png',
    ),
  ];
  for (final (text, needle, target) in cases) {
    test('recognizes $text', () {
      expect(terminalLinkInText(text, text.indexOf(needle)), target);
    });
  }
  for (final text in [
    'ordinary text',
    '/tmp/run.sh',
    'javascript:alert(1)',
    'data:image/png;base64,a',
    '[Image](command:run.png)',
  ]) {
    test('does not turn $text into an OS action', () {
      expect(terminalLinkInText(text, 0), isNull);
    });
  }
  test('does not open adjacent whitespace or punctuation', () {
    const text = 'Image: /tmp/preview.png.';
    expect(terminalLinkInText(text, 6), isNull);
    expect(terminalLinkInText(text, text.length - 1), isNull);
  });
  test('maps wide characters and emoji to the clicked terminal cells', () {
    final terminal = Terminal()..resize(100, 4);
    terminal.write('图 😀 /tmp/ảnh.png');
    expect(terminalLinkAt(terminal, const CellOffset(10, 0)), '/tmp/ảnh.png');
    expect(terminalLinkAt(terminal, const CellOffset(1, 0)), isNull);
    terminal.write('\r\n/tmp/图.png');
    // Both cells of the CJK character point to the same file.
    expect(terminalLinkAt(terminal, const CellOffset(5, 1)), '/tmp/图.png');
    expect(terminalLinkAt(terminal, const CellOffset(6, 1)), '/tmp/图.png');
  });
  test('finds the entire path across terminal soft wraps', () {
    final terminal = Terminal()..resize(20, 6);
    const path = '/tmp/a-very-long-folder/preview.mp4';
    terminal.write(path);
    expect(terminalLinkAt(terminal, const CellOffset(3, 1)), path);
  });
  test('never joins separate output lines or stale streamed content', () {
    final terminal = Terminal()..resize(80, 4);
    terminal.write('/tmp/preview.');
    expect(terminalLinkAt(terminal, const CellOffset(6, 0)), isNull);
    terminal.write('png');
    expect(
      terminalLinkAt(terminal, const CellOffset(6, 0)),
      '/tmp/preview.png',
    );
    terminal.write('\r\x1b[2KWorking...');
    expect(terminalLinkAt(terminal, const CellOffset(6, 0)), isNull);
    terminal.write('\r\n/tmp/next.\r\nmp4');
    expect(terminalLinkAt(terminal, const CellOffset(6, 1)), isNull);
  });
  test('handles scrollback and bounds extremely long output', () {
    final terminal = Terminal(maxLines: 100)..resize(20, 3);
    terminal.write('/tmp/preview.png\r\nnext\r\nnext\r\nnext');
    expect(
      terminalLinkAt(terminal, const CellOffset(6, 0)),
      '/tmp/preview.png',
    );
    terminal.write('\r\n/${'x' * 1000}.png');
    expect(
      terminalLinkAt(terminal, CellOffset(2, terminal.buffer.lines.length - 1)),
      isNull,
    );
  });

  group('OSC 8 hyperlinks', () {
    // Claude Code's table cell for `[!125](…/merge_requests/125)`, as tmux
    // hands it over: the label is shown, the address rides in OSC 8.
    const mr = 'https://git.example.com/group/project/-/merge_requests/125';

    test('opens the hidden target from any cell of the label', () {
      final terminal = Terminal()..resize(60, 4);
      terminal.write(
        '| MR | \x1b[94m\x1b]8;id=1a8pnbt;$mr\x1b\\!125\x1b[39m\x1b]8;;\x1b\\ | x',
      );
      for (var x = 7; x < 11; x++) {
        expect(terminalLinkAt(terminal, CellOffset(x, 0)), mr);
      }
      expect(terminalLinkAt(terminal, const CellOffset(6, 0)), isNull);
      expect(terminalLinkAt(terminal, const CellOffset(11, 0)), isNull);
    });

    test('BEL-terminated, with semicolons kept in the URI', () {
      const url = 'https://example.com/a;b?c=1';
      final terminal = Terminal()..resize(40, 4);
      terminal.write('\x1b]8;;$url\x07here\x1b]8;;\x07 after');
      expect(terminalLinkAt(terminal, const CellOffset(1, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(7, 0)), isNull);
    });

    test('survives an SGR reset and clears when the cell is rewritten', () {
      const url = 'https://example.com/x';
      final terminal = Terminal()..resize(40, 4);
      terminal.write('\x1b]8;;$url\x1b\\ab\x1b[0mcd\x1b]8;;\x1b\\');
      expect(terminalLinkAt(terminal, const CellOffset(3, 0)), url);
      terminal.write('\r\x1b[2Kplain');
      expect(terminalLinkAt(terminal, const CellOffset(1, 0)), isNull);
    });

    test('moves with inserted and deleted characters', () {
      const url = 'https://example.com/y';
      final terminal = Terminal()..resize(40, 4);
      terminal.write('ab\x1b]8;;$url\x1b\\LINK\x1b]8;;\x1b\\');
      terminal.write('\r\x1b[2@');
      expect(terminalLinkAt(terminal, const CellOffset(4, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(2, 0)), isNull);
      terminal.write('\r\x1b[3P');
      expect(terminalLinkAt(terminal, const CellOffset(1, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(0, 0)), isNull);
    });

    test('spans exactly the linked cells for the hover underline', () {
      final terminal = Terminal()..resize(60, 4);
      terminal.write(
        '| MR | \x1b[94m\x1b]8;id=1a8pnbt;$mr\x1b\\!125\x1b[39m\x1b]8;;\x1b\\ | x',
      );
      expect(terminalLinkSpans(terminal, const CellOffset(8, 0), mr), [
        (row: 0, start: 7, end: 10),
      ]);
    });

    test('ignores non-web schemes', () {
      final terminal = Terminal()..resize(40, 4);
      terminal.write('\x1b]8;;javascript:alert(1)\x1b\\x\x1b]8;;\x1b\\');
      expect(terminalLinkAt(terminal, const CellOffset(0, 0)), isNull);
    });
  });

  group('hard-wrapped web URLs', () {
    // What Claude Code (Ink) writes for a long address in a narrow pane: rows
    // with their own newlines, cut at the box width, each indented by the box.
    const url = 'https://commandcode.ai/0xkongamoto/settings/billing';
    Terminal ink(List<String> rows, {int width = 44}) {
      final terminal = Terminal()..resize(width, 12);
      terminal.write(rows.join('\r\n'));
      return terminal;
    }

    test('spans every row of a cut URL for the hover underline', () {
      final terminal = ink([
        '  Command Code here: https://commandc',
        '  ode.ai/0xkongamoto/settings/billing',
      ]);
      expect(terminalLinkSpans(terminal, const CellOffset(5, 1), url), [
        (row: 0, start: 21, end: 36),
        (row: 1, start: 2, end: 36),
      ]);
    });

    test('reads the whole URL from either row', () {
      final terminal = ink([
        '  Command Code here: https://commandc',
        '  ode.ai/0xkongamoto/settings/billing',
        '',
        '  * Worked for 1s',
      ]);
      expect(terminalLinkAt(terminal, const CellOffset(25, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(36, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(2, 1)), url);
      expect(terminalLinkAt(terminal, const CellOffset(30, 1)), url);
      // The label before the URL and the box indent are not the link.
      expect(terminalLinkAt(terminal, const CellOffset(5, 0)), isNull);
      expect(terminalLinkAt(terminal, const CellOffset(0, 1)), isNull);
    });

    test('spans more than two rows and still trims trailing punctuation', () {
      final terminal = ink([
        '  See https://commandcode.ai/0xkon',
        '  gamoto/settings/billing?tab=invo',
        '  ices&period=2026-09.',
      ], width: 40);
      const long = '$url?tab=invoices&period=2026-09';
      expect(terminalLinkAt(terminal, const CellOffset(10, 0)), long);
      expect(terminalLinkAt(terminal, const CellOffset(10, 1)), long);
      expect(terminalLinkAt(terminal, const CellOffset(4, 2)), long);
      expect(terminalLinkAt(terminal, const CellOffset(22, 2)), isNull);
    });

    test('joins a list item whose continuation is indented deeper', () {
      final terminal = ink([
        '  • https://commandcode.ai/0xkongam',
        '    oto/settings/billing',
      ], width: 40);
      expect(terminalLinkAt(terminal, const CellOffset(6, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(6, 1)), url);
    });

    test('does not join a word wrap that happens to end with a URL', () {
      final terminal = ink([
        '  see https://foo.com',
        '  and more words after it',
      ]);
      expect(
        terminalLinkAt(terminal, const CellOffset(8, 0)),
        'https://foo.com',
      );
      expect(terminalLinkAt(terminal, const CellOffset(3, 1)), isNull);
    });

    test('does not join a fresh URL or across a blank row', () {
      final fresh = ink([
        '  https://a.example/one-two-three-x',
        '  https://b.example/two',
      ], width: 40);
      expect(
        terminalLinkAt(fresh, const CellOffset(4, 0)),
        'https://a.example/one-two-three-x',
      );
      expect(
        terminalLinkAt(fresh, const CellOffset(4, 1)),
        'https://b.example/two',
      );
      final blank = ink(['  https://a.example/one-two-three-x', '', '  more']);
      expect(
        terminalLinkAt(blank, const CellOffset(4, 0)),
        'https://a.example/one-two-three-x',
      );
      expect(terminalLinkAt(blank, const CellOffset(3, 2)), isNull);
    });

    test('ignores the spaces a row is padded with past the cut', () {
      // Claude Code's prompt box paints its rows to the full width with
      // spaces; the address still breaks at the box width underneath them.
      final terminal = ink([
        '  here: https://commandcode.ai/0xkongamoto/ ',
        '  settings/billing" then "- NVIDIA',
      ], width: 44);
      expect(terminalLinkAt(terminal, const CellOffset(12, 0)), url);
      expect(terminalLinkAt(terminal, const CellOffset(4, 1)), url);
    });

    test('does not join a row that opens with sentence punctuation', () {
      final terminal = ink([
        '  see https://a.example/one-two-x',
        '  — and then something else',
      ], width: 40);
      expect(
        terminalLinkAt(terminal, const CellOffset(8, 0)),
        'https://a.example/one-two-x',
      );
      expect(terminalLinkAt(terminal, const CellOffset(4, 1)), isNull);
    });

    test('follows the paint of a cut address past a wider row beside it', () {
      // Claude Code paints an address bright blue (SGR 94) and carries the
      // paint onto the rows it cut it across; a tool result sits directly
      // under the wider tool-call rows, so the box width alone says no.
      final terminal = Terminal()..resize(44, 12);
      terminal.write(
        '⏺ Bash(echo "Command Code here: https://comm\r\n'
        '      andcode.ai/0xkongamoto/settings/billin\r\n'
        '      g/extra/long/path/segment")\r\n'
        '  ⎿  Command Code here: \x1b[94mhttps://command\x1b[39m\r\n'
        '     \x1b[94mcode.ai/0xkongamoto/settings/billi\x1b[39m\r\n'
        '     \x1b[94mng/extra/long/path/segment\x1b[39m',
      );
      const long = '$url/extra/long/path/segment';
      expect(terminalLinkAt(terminal, const CellOffset(30, 3)), long);
      expect(terminalLinkAt(terminal, const CellOffset(10, 4)), long);
      expect(terminalLinkAt(terminal, const CellOffset(10, 5)), long);
      expect(terminalLinkAt(terminal, const CellOffset(10, 3)), isNull);
    });

    test('a painted address is not followed into plain text', () {
      // The row is its paragraph's widest and ends with the address, but
      // the next row opens in plain paint: the sentence went on, the
      // address did not.
      final terminal = Terminal()..resize(44, 12);
      terminal.write(
        '⏺ See the docs at \x1b[94mhttps://foo.com/docs\x1b[39m\r\n'
        '  before you start.',
      );
      expect(
        terminalLinkAt(terminal, const CellOffset(20, 0)),
        'https://foo.com/docs',
      );
      expect(terminalLinkAt(terminal, const CellOffset(3, 1)), isNull);
    });

    test('a finished address in a wide pane is not glued to the next item', () {
      // Nothing wrapped here; the first row is merely the widest, and ends
      // with the bracket that closes the address.
      final terminal = Terminal()..resize(120, 6);
      terminal.write(
        '  - Ra mắt GPT-5.2 - OpenAI (\x1b[94mhttps://openai.com/vi-VN/index/introducing-gpt-5-2/\x1b[39m)\r\n'
        '  - NVIDIA Isaac-GR00T (\x1b[94mhttps://github.com/NVIDIA/Isaac-GR00T\x1b[39m)',
      );
      expect(
        terminalLinkAt(terminal, const CellOffset(40, 0)),
        'https://openai.com/vi-VN/index/introducing-gpt-5-2/',
      );
      expect(
        terminalLinkAt(terminal, const CellOffset(30, 1)),
        'https://github.com/NVIDIA/Isaac-GR00T',
      );
    });

    test('a list marker is not the rest of an address', () {
      for (final marker in ['- next item', '2. next item', '2) next item']) {
        final terminal = ink([
          '  see https://a.example/one-two-x',
          '  $marker',
        ]);
        expect(
          terminalLinkAt(terminal, const CellOffset(8, 0)),
          'https://a.example/one-two-x',
          reason: marker,
        );
      }
    });

    test('only ever assembles web URLs this way', () {
      final terminal = ink([
        '  /tmp/a-very-long-folder-name/prev',
        '  iew.png',
      ], width: 36);
      expect(terminalLinkAt(terminal, const CellOffset(6, 0)), isNull);
      expect(
        terminalLinkAt(terminal, const CellOffset(4, 1)),
        isNot('/tmp/a-very-long-folder-name/preview.png'),
      );
    });

    // Two byte streams a tmux client received from a real Claude Code
    // session on a 44-column pane (scripts: ask for the address, capture the
    // attach). They are what the pane in the app actually sees.
    for (final (name, expected) in [
      (
        'claude_code_44col_response',
        {
          // The prompt box, one paint throughout, padded with spaces.
          const CellOffset(10, 10): url,
          const CellOffset(10, 11): url,
          // The reply, address painted, broken after the slash.
          const CellOffset(30, 15): url,
          const CellOffset(10, 16): url,
          const CellOffset(10, 18): 'https://github.com/NVIDIA/Isaac-GR00T',
        },
      ),
      (
        'claude_code_44col_tool_result',
        {
          // The tool call, wider than the tool result right under it.
          const CellOffset(30, 11): '$url/extra/long/path/segment',
          // The tool result, three painted rows.
          const CellOffset(30, 13): '$url/extra/long/path/segment',
          const CellOffset(10, 14): '$url/extra/long/path/segment',
          const CellOffset(10, 15): '$url/extra/long/path/segment',
        },
      ),
    ]) {
      test('reads the addresses in the $name capture', () {
        final bytes = File('test/fixtures/$name.bin').readAsBytesSync();
        final terminal = Terminal()..resize(44, 30);
        terminal.write(utf8.decode(bytes, allowMalformed: true));
        for (final MapEntry(key: cell, value: target) in expected.entries) {
          expect(terminalLinkAt(terminal, cell), target, reason: '$cell');
        }
      });
    }

    test('gives up on a URL that spans too many rows', () {
      final rows = [
        '  https://a.example/${'x' * 16}',
        for (var i = 0; i < 9; i++) '  ${'y' * 34}',
      ];
      final terminal = ink(rows, width: 36);
      expect(terminalLinkAt(terminal, const CellOffset(4, 0)), isNull);
    });
  });
}
