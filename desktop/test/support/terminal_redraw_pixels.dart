import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

String _screen() =>
    [
          'Repeated terminal output',
          '\x1b[31mred\x1b[0m \x1b[44mbackground\x1b[0m',
          '\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m',
          '\x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m',
          'wide 漢字 emoji 😀 blocks ▀▄█▌▐░▒▓ box ┌─┬─┐',
          '\x1b[38;2;255;128;0;48;2;0;64;128mrgb\x1b[0m',
          '\x1b]8;;https://example.test/first\x1b\\link\x1b]8;;\x1b\\',
        ]
        .asMap()
        .entries
        .map((row) => '\x1b[${row.key + 1};1H\x1b[2K${row.value}')
        .join();

Future<Uint8List> _raster(
  TerminalPainter painter,
  Terminal terminal, {
  required bool cached,
  required double ratio,
}) async {
  final cell = painter.cellSize;
  final width = ((terminal.viewWidth * cell.width + 4) * ratio).ceil();
  final height = ((terminal.viewHeight * cell.height + 4) * ratio).ceil();
  final recorder = PictureRecorder();
  final canvas = Canvas(recorder)..scale(ratio);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width / ratio, height / ratio),
    Paint()..color = painter.theme.background,
  );
  painter.beginFrame();
  final lines = terminal.buffer.lines;
  final first = lines.length - terminal.viewHeight;
  for (var row = 0; row < terminal.viewHeight; row++) {
    final offset = Offset(1.5, 2.5 + row * cell.height);
    if (cached) {
      painter.paintLineCached(canvas, offset, lines[first + row]);
    } else {
      painter.paintLine(canvas, offset, lines[first + row]);
    }
  }
  painter.endFrame();
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  final bytes = await image.toByteData(format: ImageByteFormat.rawRgba);
  image.dispose();
  return bytes!.buffer.asUint8List();
}

/// Same checks in the headless renderer and native macOS renderer. Only
/// synthetic text; no real transport, session files, input or saved app state.
Future<void> verifyTerminalRedrawPixels() async {
  for (final ratio in [1.0, 1.5, 2.0]) {
    final terminal = Terminal(maxLines: 100)..resize(80, 12);
    TerminalPainter painter() => TerminalPainter(
      theme: TerminalThemes.defaultTheme,
      textStyle: const TerminalStyle(),
      textScaler: TextScaler.noScaling,
    )..devicePixelRatio = ratio;
    final direct = painter(), cached = painter();
    final changes = <String, void Function()>{
      'initial': () => terminal.write(_screen()),
      'erase and rewrite': () => terminal.write(_screen()),
      'repeat identical final cells': () => terminal.write(_screen()),
      'changed text and colors': () => terminal.write(
        '\x1b[1;1H\x1b[2K\x1b[32mCHANGED\x1b[0m '
        '\x1b[48;2;45;46;47mcolor\x1b[0m',
      ),
      'wide characters replaced': () => terminal.write(
        '\x1b[5;1H\x1b[2K😀 漢字 \x1b[4munderlined wide 字\x1b[0m',
      ),
      'hyperlink destination': () => terminal.write(
        '\x1b[7;1H\x1b[2K\x1b]8;;https://example.test/second\x1b\\'
        'link\x1b]8;;\x1b\\',
      ),
      'insert and delete': () => terminal.write('\x1b[1;3H\x1b[2@ab\x1b[2P'),
      'shrink': () => terminal.resize(48, 12),
      'grow': () => terminal.resize(88, 12),
      'alternate screen': () => terminal.write('\x1b[?1049h${_screen()}'),
      'main screen': () => terminal.write('\x1b[?1049l'),
      'scroll': () => terminal.write('\x1b[12;1H\r\nnew bottom row'),
      'text size': () {
        direct.textStyle = cached.textStyle = const TerminalStyle(fontSize: 17);
      },
      'text scale': () {
        direct.textScaler = cached.textScaler = const TextScaler.linear(1.25);
      },
    };
    try {
      for (final change in changes.entries) {
        change.value();
        final expected = await _raster(
          direct,
          terminal,
          cached: false,
          ratio: ratio,
        );
        final actual = await _raster(
          cached,
          terminal,
          cached: true,
          ratio: ratio,
        );
        expect(actual, expected, reason: '${change.key} at ${ratio}x');
        expect(cached.cachedLineCount, terminal.viewHeight);
      }
    } finally {
      direct.clearLineCache();
      cached.clearLineCache();
    }
  }
}
