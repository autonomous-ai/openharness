import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/line_picture_cache.dart';
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

TerminalPainter _painter({TerminalTheme? theme}) => TerminalPainter(
      theme: theme ?? TerminalThemes.defaultTheme,
      textStyle: const TerminalStyle(),
      textScaler: TextScaler.noScaling,
    );

/// A screen exercising everything a line can draw: colours, inverse, faint,
/// bold/italic/underline, wide CJK, emoji, block glyphs, box drawing, RGB.
Terminal _sampleTerminal() {
  final terminal = Terminal(maxLines: 200)..resize(60, 12);
  terminal.write('plain text, then \x1b[31mred\x1b[0m \x1b[42mgreen bg\x1b[0m\r\n');
  terminal.write('\x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m \x1b[1mbold\x1b[0m '
      '\x1b[3mitalic\x1b[0m \x1b[4munder line \x1b[0m\r\n');
  terminal.write('wide 漢字テスト emoji 😀 done\r\n');
  terminal.write('blocks ▀▄█▌▐░▒▓ box ┌─┬─┐│ │└─┴─┘\r\n');
  terminal.write('\x1b[38;2;255;128;0;48;2;0;64;128mrgb run\x1b[0m end\r\n');
  terminal.write('\x1b[44m                    \x1b[0m trailing spaces on blue\r\n');
  return terminal;
}

List<BufferLine> _visible(Terminal terminal) {
  final lines = terminal.buffer.lines;
  final first = lines.length - terminal.viewHeight;
  return [for (var i = 0; i < terminal.viewHeight; i++) lines[first + i]];
}

Future<Uint8List> _render(
  TerminalPainter painter,
  List<BufferLine> lines,
  void Function(Canvas canvas, Offset offset, BufferLine line) paint,
) async {
  final cell = painter.cellSize;
  final width = (lines.first.length * cell.width).ceil();
  final height = (lines.length * cell.height).ceil();
  final recorder = PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = painter.theme.background,
  );
  for (var i = 0; i < lines.length; i++) {
    paint(canvas, Offset(0, (i * cell.height).truncateToDouble()), lines[i]);
  }
  final image = await recorder.endRecording().toImage(width, height);
  final bytes = await image.toByteData(format: ImageByteFormat.rawRgba);
  image.dispose();
  return bytes!.buffer.asUint8List();
}

/// The renderer before merged backgrounds and glyph runs: each cell's
/// background, then its glyph, one cell at a time.
void _paintCellByCell(
  TerminalPainter painter,
  Canvas canvas,
  Offset offset,
  BufferLine line,
) {
  final cellData = CellData.empty();
  for (var i = 0; i < line.length; i++) {
    line.getCellData(i, cellData);
    painter.paintCell(
      canvas,
      offset.translate(i * painter.cellSize.width, 0),
      cellData,
    );
    if (cellData.content >> CellContent.widthShift == 2) i++;
  }
}

void main() {
  group('BufferLine.paintVersion', () {
    test('ignores a cell rewritten with the value it already has', () {
      final line = BufferLine(10);
      final style = CursorStyle(foreground: 1, background: 2, attrs: 3);
      line.setCell(0, 0x41, 1, style);
      final version = line.paintVersion;
      final text = line.textVersion;

      line.setCell(0, 0x41, 1, style);
      final data = CellData.empty();
      line.getCellData(0, data);
      line.setCellData(0, data);
      line.setForeground(0, 1);

      expect(line.paintVersion, version);
      // Text caches keep their old, unconditional rule.
      expect(line.textVersion, greaterThan(text));
    });

    test('moves on a colour-only change, which textVersion ignores', () {
      final line = BufferLine(10)..setCell(0, 0x41, 1, CursorStyle());
      final version = line.paintVersion;
      final text = line.textVersion;

      line.setForeground(0, 7);
      expect(line.paintVersion, greaterThan(version));
      line.setBackground(0, 7);
      line.setAttributes(0, 7);
      expect(line.paintVersion, version + 3);
      expect(line.textVersion, text);
    });

    test('moves on every edit that reshapes the line', () {
      final style = CursorStyle();
      BufferLine filled() {
        final line = BufferLine(10);
        for (var i = 0; i < 10; i++) {
          line.setCell(i, 0x61 + i, 1, style);
        }
        return line;
      }

      final edits = <String, void Function(BufferLine)>{
        'insertCells': (l) => l.insertCells(2, 3),
        'removeCells': (l) => l.removeCells(2, 3),
        'eraseRange': (l) => l.eraseRange(2, 5, style),
        'eraseCell': (l) => l.eraseCell(0, style),
        'resetCell': (l) => l.resetCell(0),
        'setContent': (l) => l.setContent(0, 0x7a | (1 << CellContent.widthShift)),
        'setCodePoint': (l) => l.setCodePoint(0, 0x7a),
        'resize': (l) => l.resize(4),
        'copyFrom': (l) => l.copyFrom(BufferLine(10), 0, 0, 5),
      };
      for (final MapEntry(key: name, value: edit) in edits.entries) {
        final line = filled();
        final version = line.paintVersion;
        edit(line);
        expect(line.paintVersion, greaterThan(version), reason: name);
      }
    });

    test('a zero-count insert or remove is not a change', () {
      final line = BufferLine(10)..setCell(0, 0x41, 1, CursorStyle());
      final version = line.paintVersion;
      line.insertCells(9, 0);
      line.removeCells(9, 0);
      expect(line.paintVersion, version);
    });
  });

  group('LinePictureCache', () {
    Picture picture() {
      final recorder = PictureRecorder();
      Canvas(recorder).drawRect(const Rect.fromLTWH(0, 0, 1, 1), Paint());
      return recorder.endRecording();
    }

    test('hits while the line is unchanged, misses once it changes', () {
      final cache = LinePictureCache();
      final line = BufferLine(4);
      final drawn = picture();

      cache.beginFrame();
      expect(cache.lookup(line), isNull);
      cache.store(line, drawn);
      cache.endFrame();

      cache.beginFrame();
      expect(cache.lookup(line), same(drawn));
      cache.endFrame();

      line.setCell(0, 0x41, 1, CursorStyle());
      cache.beginFrame();
      expect(cache.lookup(line), isNull);
      cache.endFrame();
    });

    test('keeps only the lines the last frame drew', () {
      final cache = LinePictureCache();
      final kept = BufferLine(4), gone = BufferLine(4);

      cache.beginFrame();
      cache.store(kept, picture());
      cache.store(gone, picture());
      cache.endFrame();
      expect(cache.length, 2);

      cache.beginFrame();
      expect(cache.lookup(kept), isNotNull);
      cache.endFrame();
      expect(cache.length, 1);

      cache.clear();
      expect(cache.length, 0);
    });
  });

  group('TerminalPainter.paintLine', () {
    test('merged backgrounds fill exactly what cell-by-cell painting filled', () async {
      // Backgrounds alone: runs of colours, inverse, a wide cell, gaps.
      final terminal = Terminal(maxLines: 50)..resize(40, 4);
      terminal.write('\x1b[41m   \x1b[42m  \x1b[0m  \x1b[44m    \x1b[0m\r\n');
      terminal.write('\x1b[7m     \x1b[0m \x1b[48;2;10;20;30m   \x1b[48;2;10;20;31m  \x1b[0m\r\n');
      terminal.write('\x1b[45m\u3000 \u3000\x1b[0m\r\n');
      final lines = _visible(terminal);
      final painter = _painter();
      final expected = await _render(
        painter,
        lines,
        (canvas, offset, line) => _paintCellByCell(painter, canvas, offset, line),
      );
      expect(await _render(painter, lines, painter.paintLine), expected);
    });

    test('glyphs on coloured backgrounds differ only where they overhang a neighbour', () async {
      // Cell by cell, the next cell's background was drawn over the edge of
      // the glyph before it — but only on a coloured background, never on the
      // default one. Backgrounds first shows that edge on both, alike. The
      // difference is confined to those edges: a sliver of the grid.
      final lines = _visible(_sampleTerminal());
      final painter = _painter();
      final expected = await _render(
        painter,
        lines,
        (canvas, offset, line) => _paintCellByCell(painter, canvas, offset, line),
      );
      final actual = await _render(painter, lines, painter.paintLine);
      var differing = 0;
      for (var i = 0; i < actual.length; i += 4) {
        if (actual[i] != expected[i] ||
            actual[i + 1] != expected[i + 1] ||
            actual[i + 2] != expected[i + 2]) {
          differing++;
        }
      }
      expect(differing / (actual.length / 4), lessThan(0.002));
    });
  });

  group('ASCII runs', () {
    int runsIn(String text, {int cols = 60}) {
      final terminal = Terminal(maxLines: 50)..resize(cols, 3);
      terminal.write(text);
      final painter = _painter();
      final recorder = PictureRecorder();
      painter.paintLine(Canvas(recorder), Offset.zero, terminal.buffer.lines[0]);
      recorder.endRecording().dispose();
      return painter.debugAsciiRunsPainted;
    }

    test('are cut wherever the style or the kind of character changes', () {
      expect(runsIn('plain words here'), 1);
      expect(runsIn('ab\x1b[31mcd\x1b[0mef'), 3);
      expect(runsIn('ab\x1b[1mcd\x1b[0m\x1b[3mef\x1b[0m\x1b[4mgh\x1b[0m'), 4);
      expect(runsIn('ab\x1b[7mcd\x1b[0m\x1b[2mef\x1b[0m'), 3);
      // Wide, non-ASCII and block glyphs stay cell by cell and split the run.
      expect(runsIn('ab漢cd'), 2);
      expect(runsIn('abé cd'), 2);
      expect(runsIn('ab█cd'), 2);
      // A single ASCII cell between two breaks is not a run.
      expect(runsIn('a漢b'), 0);
    });

    test('skip runs of bare spaces but keep underlined ones', () {
      expect(runsIn('\x1b[41m      \x1b[0m'), 0);
      expect(runsIn('\x1b[4m      \x1b[0m'), 1);
    });

    test('draw what cell-by-cell painting drew', () async {
      final terminal = Terminal(maxLines: 50)..resize(60, 8);
      terminal.write('The quick brown fox jumps over the lazy dog 0123456789\r\n');
      terminal.write('\x1b[31mred \x1b[1mbold \x1b[3mitalic\x1b[0m \x1b[2mfaint\x1b[0m \x1b[7minverse\x1b[0m\r\n');
      terminal.write('\x1b[4munderlined words and trailing   \x1b[0m!\r\n');
      terminal.write('\x1b[38;5;208m256-colour\x1b[0m \x1b[38;2;1;2;3;48;2;200;200;200mrgb on rgb\x1b[0m\r\n');
      terminal.write(r'punctuation !"#$%&()*+,-./:;<=>?@[\]^_`{|}~' '\r\n');
      terminal.write('mixed ascii 漢字 and ▀▄ blocks, then ascii again\r\n');
      final lines = _visible(terminal);
      final painter = _painter();
      final expected = await _render(
        painter,
        lines,
        (canvas, offset, line) => _paintCellByCell(painter, canvas, offset, line),
      );
      final actual = await _render(painter, lines, painter.paintLine);
      expect(painter.debugAsciiRunsPainted, greaterThan(10));
      // A run is shaped as one line of text, so an edge (an underline most of
      // all) can antialias a shade differently than cell-sized pieces did —
      // never by more than a faint shade, and never a glyph out of place.
      var differing = 0, largest = 0;
      for (var i = 0; i < actual.length; i++) {
        final delta = (actual[i] - expected[i]).abs();
        if (delta > 0) differing++;
        if (delta > largest) largest = delta;
      }
      expect(largest, lessThanOrEqualTo(16));
      expect(differing / actual.length, lessThan(0.001));
    });
  });

  group('TerminalPainter.paintLineCached', () {
    test('replays pixel for pixel what paintLine draws', () async {
      final terminal = _sampleTerminal();
      final lines = _visible(terminal);
      final direct = _painter();
      final cached = _painter();

      final expected = await _render(direct, lines, direct.paintLine);
      // First frame records, second replays: both must match a direct paint.
      for (var frame = 0; frame < 2; frame++) {
        cached.beginFrame();
        final actual = await _render(cached, lines, cached.paintLineCached);
        cached.endFrame();
        expect(actual, expected, reason: 'frame $frame');
      }
      expect(cached.cachedLineCount, lines.length);
    });

    test('matches a direct paint at a fractional pixel ratio', () async {
      // At 1.5x a line at y = 7 starts half a device pixel into a pixel, and
      // lines are recorded at that phase and moved by whole device pixels.
      // (This software rasterizer honours isAntiAlias: false, so it cannot
      // show the seam an unsnapped block edge leaves under Impeller's MSAA —
      // it guards that the phase handling itself draws the same pixels.)
      final terminal = Terminal(maxLines: 50)..resize(30, 3);
      terminal.write('blocks ▀▄█▌▐ \x1b[41mred\x1b[0m text');
      final line = terminal.buffer.lines[0];
      const ratio = 1.5;

      Future<Uint8List> render(TerminalPainter painter, bool cached) async {
        final recorder = PictureRecorder();
        final canvas = Canvas(recorder)..scale(ratio);
        for (final y in [7.0, 23.0, 7.0]) {
          painter.beginFrame();
          if (cached) {
            painter.paintLineCached(canvas, Offset(0, y), line);
          } else {
            painter.paintLine(canvas, Offset(0, y), line);
          }
          painter.endFrame();
        }
        final image = await recorder.endRecording().toImage(
          (30 * painter.cellSize.width * ratio).ceil(),
          (48 * ratio).ceil(),
        );
        final bytes = await image.toByteData(format: ImageByteFormat.rawRgba);
        image.dispose();
        return bytes!.buffer.asUint8List();
      }

      TerminalPainter at(double ratio) => _painter()..devicePixelRatio = ratio;
      expect(await render(at(ratio), true), await render(at(ratio), false));
    });

    test('redraws a line written since it was recorded', () async {
      final terminal = _sampleTerminal();
      final painter = _painter();

      painter.beginFrame();
      await _render(painter, _visible(terminal), painter.paintLineCached);
      painter.endFrame();

      terminal.write('\x1b[1;1H\x1b[35mCHANGED\x1b[0m');
      final lines = _visible(terminal);
      painter.beginFrame();
      final actual = await _render(painter, lines, painter.paintLineCached);
      painter.endFrame();
      expect(actual, await _render(_painter(), lines, _painter().paintLine));
    });

    test('reuses a line\'s drawing after it scrolls up the screen', () {
      final terminal = Terminal(maxLines: 200)..resize(40, 5);
      for (var i = 0; i < 5; i++) {
        terminal.write('line $i\r\n');
      }
      final painter = _painter();
      final recorder = PictureRecorder();
      final canvas = Canvas(recorder);

      painter.beginFrame();
      for (final line in _visible(terminal)) {
        painter.paintLineCached(canvas, Offset.zero, line);
      }
      painter.endFrame();
      final before = {for (final line in _visible(terminal)) line: line.paintVersion};

      terminal.write('line 5\r\n');
      final after = _visible(terminal);
      // Every line but the newest is an object the last frame already drew,
      // and of those only the row the cursor was on ('line 5') was written.
      final kept = after.where(before.containsKey).toList();
      expect(kept.length, after.length - 1);
      expect(kept.where((line) => line.paintVersion != before[line]).length, 1);
      recorder.endRecording().dispose();
    });

    test('forgets every drawing when the theme changes', () {
      final terminal = _sampleTerminal();
      final painter = _painter();
      final recorder = PictureRecorder();
      final canvas = Canvas(recorder);
      painter.beginFrame();
      for (final line in _visible(terminal)) {
        painter.paintLineCached(canvas, Offset.zero, line);
      }
      painter.endFrame();
      expect(painter.cachedLineCount, greaterThan(0));

      painter.theme = TerminalTheme(
        cursor: const Color(0xFFFFFFFF),
        selection: const Color(0xFFFFFFFF),
        foreground: const Color(0xFF000000),
        background: const Color(0xFFFFFFFF),
        black: const Color(0xFF000000),
        red: const Color(0xFFFF0000),
        green: const Color(0xFF00FF00),
        yellow: const Color(0xFFFFFF00),
        blue: const Color(0xFF0000FF),
        magenta: const Color(0xFFFF00FF),
        cyan: const Color(0xFF00FFFF),
        white: const Color(0xFFFFFFFF),
        brightBlack: const Color(0xFF808080),
        brightRed: const Color(0xFFFF0000),
        brightGreen: const Color(0xFF00FF00),
        brightYellow: const Color(0xFFFFFF00),
        brightBlue: const Color(0xFF0000FF),
        brightMagenta: const Color(0xFFFF00FF),
        brightCyan: const Color(0xFF00FFFF),
        brightWhite: const Color(0xFFFFFFFF),
        searchHitBackground: const Color(0xFFFFFF00),
        searchHitBackgroundCurrent: const Color(0xFFFF0000),
        searchHitForeground: const Color(0xFF000000),
      );
      expect(painter.cachedLineCount, 0);
      painter.devicePixelRatio = 2;
      expect(painter.cachedLineCount, 0);
      recorder.endRecording().dispose();
    });
  });
}

