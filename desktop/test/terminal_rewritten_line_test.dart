import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/line_picture_cache.dart';
import 'package:xterm/xterm.dart';

import 'support/terminal_redraw_pixels.dart';

Picture _picture() {
  final recorder = PictureRecorder();
  Canvas(recorder).drawRect(const Rect.fromLTWH(0, 0, 1, 1), Paint());
  return recorder.endRecording();
}

void main() {
  test('an ANSI erase/rewrite reuses the identical final row drawing', () {
    final terminal = Terminal()..resize(80, 10);
    const output = '\x1b[H\x1b[2K\x1b[32mTask output 漢字 😀\x1b[0m';
    terminal.write(output);
    final line = terminal.buffer.lines[0];
    final cache = LinePictureCache();
    addTearDown(cache.clear);
    final picture = _picture();
    cache.beginFrame();
    cache.store(line, picture);
    cache.endFrame();
    for (var redraw = 0; redraw < 4; redraw++) {
      final before = line.paintVersion;
      terminal.write(output);
      expect(line.paintVersion, greaterThan(before));
      cache.beginFrame();
      expect(cache.lookup(line), same(picture));
      expect(cache.lookup(line), same(picture));
      cache.endFrame();
    }
    expect(terminal.buffer.getText(), contains('Task output 漢字 😀'));
  });

  for (final edit in <String, void Function(BufferLine)>{
    'foreground': (line) => line.setForeground(0, 12),
    'background': (line) => line.setBackground(0, 13),
    'attributes': (line) => line.setAttributes(0, 14),
    'code point': (line) => line.setCodePoint(0, 0x42),
    'width': (line) => line.setCell(0, 0x41, 2, CursorStyle()),
    'shorter length': (line) => line.resize(3),
    'longer length within capacity': (line) => line.resize(5),
    'larger allocation': (line) => line.resize(300),
  }.entries) {
    test('a changed ${edit.key} never reuses an old drawing', () {
      final line = BufferLine(4)..setCell(0, 0x41, 1, CursorStyle());
      final cache = LinePictureCache();
      addTearDown(cache.clear);
      cache.beginFrame();
      cache.store(line, _picture());
      cache.endFrame();
      edit.value(line);
      cache.beginFrame();
      expect(cache.lookup(line), isNull);
      cache.endFrame();
      expect(cache.length, 0);
    });
  }

  test('a restored cell still misses at another device-pixel phase', () {
    final line = BufferLine(4)..setCell(0, 0x41, 1, CursorStyle());
    final cache = LinePictureCache();
    addTearDown(cache.clear);
    final picture = _picture();
    cache.beginFrame();
    cache.store(line, picture);
    cache.endFrame();
    line.setCodePoint(0, 0x42);
    line.setCodePoint(0, 0x41);
    cache.beginFrame();
    expect(cache.lookup(line, const Offset(.5, 0)), isNull);
    expect(cache.lookup(line), same(picture));
    cache.endFrame();
  });

  test(
    'a new hyperlink destination stays live without changing drawn cells',
    () {
      final line = BufferLine(4);
      line.setCell(
        0,
        0x41,
        1,
        CursorStyle()..hyperlink = 'https://example.test/first',
      );
      final cache = LinePictureCache();
      addTearDown(cache.clear);
      final picture = _picture();
      cache.beginFrame();
      cache.store(line, picture);
      cache.endFrame();
      line.setCell(
        0,
        0x41,
        1,
        CursorStyle()..hyperlink = 'https://example.test/second',
      );
      cache.beginFrame();
      expect(cache.lookup(line), same(picture));
      expect(line.getHyperlink(0), 'https://example.test/second');
      cache.endFrame();
    },
  );

  test('the stored cells are a copy, not a view of later edits', () {
    final line = BufferLine(4)..setCell(0, 0x41, 1, CursorStyle());
    final cache = LinePictureCache();
    addTearDown(cache.clear);
    final first = _picture(), second = _picture();
    cache.beginFrame();
    cache.store(line, first);
    cache.endFrame();
    line.setCodePoint(0, 0x42);
    cache.beginFrame();
    expect(cache.lookup(line), isNull);
    cache.store(line, second);
    cache.endFrame();
    line.setCodePoint(0, 0x43);
    line.setCodePoint(0, 0x42);
    cache.beginFrame();
    expect(cache.lookup(line), same(second));
    cache.endFrame();
    cache.beginFrame();
    cache.endFrame();
    expect(cache.length, 0);
  });

  test('replacement drawings follow resized storage and pixel phase', () {
    final line = BufferLine(4)..setCell(0, 0x41, 1, CursorStyle());
    final cache = LinePictureCache();
    addTearDown(cache.clear);
    cache.beginFrame();
    cache.store(line, _picture());
    cache.endFrame();
    line.resize(300);
    final replacement = _picture();
    const phase = Offset(.5, .5);
    cache.beginFrame();
    expect(cache.lookup(line, phase), isNull);
    cache.store(line, replacement, phase);
    cache.endFrame();
    line.setCodePoint(299, 0x42);
    line.resetCell(299);
    cache.beginFrame();
    expect(cache.lookup(line), isNull);
    expect(cache.lookup(line, phase), same(replacement));
    cache.endFrame();
  });

  test(
    'rewritten terminal drawings equal uncached pixels',
    verifyTerminalRedrawPixels,
  );
}
