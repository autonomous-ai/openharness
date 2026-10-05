// Synchronous ANSI parsing only. No renderer, transport, daemon or battery data.
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:xterm/core.dart';

class ParserTarget {
  ParserTarget(dynamic terminal)
    : write = terminal.write as void Function(String),
      snapshot = (() => _screen(terminal)) {
    terminal.onOutput = replies.add;
    terminal.onTitleChange = titles.add;
  }

  final void Function(String) write;
  final Object Function() snapshot;
  final replies = <String>[];
  final titles = <String>[];

  Object get state => [snapshot(), replies, titles];
}

// Dynamic here lets the comparison runner use a separate, unmodified baseline
// Terminal class. Snapshot work is outside the timed parsing loop.
Object _screen(dynamic terminal) => {
  'grid': [terminal.viewWidth, terminal.viewHeight],
  'cursor': [terminal.buffer.cursorX, terminal.buffer.cursorY],
  'visible': terminal.cursorVisibleMode,
  'alternate': terminal.isUsingAltBuffer,
  'lines': [
    for (var i = 0; i < terminal.buffer.lines.length; i++)
      _line(terminal.buffer.lines[i]),
  ],
};

Object _line(dynamic line) => {
  'data': line.data.toList(),
  'wrapped': line.isWrapped,
  'textVersion': line.textVersion,
  'paintVersion': line.paintVersion,
  'links': [for (var x = 0; x < line.length; x++) line.getHyperlink(x)],
};

void runParserBenchmark(ParserTarget Function() createBaseline) {
  final results = <String, Object>{};
  var comparisons = 0;
  String rows(String text) =>
      '\x1b7\x1b[H${List.generate(8, (row) => '\x1b[2K\x1b[32m$row: $text\x1b[0m\r\n').join()}\x1b8';
  for (final (name, text, chunkSize) in [
    ('ascii_short', '\r\x1b[2KAgent update: tests passed', 100000),
    ('ascii_screen', rows('Agent output ${'x' * 80}'), 100000),
    ('latin1_screen', rows('résumé café £ ${'x' * 60}'), 100000),
    ('bmp_screen', rows('Việt Nam 漢字 │ ${'x' * 40}'), 100000),
    ('emoji_screen', rows('Test 😀 🐙 𐐷 ${'x' * 40}'), 100000),
    (
      'fragmented_ansi',
      '\x1b[H\x1b]8;;https://example.com/ảnh\x1b\\Label 漢 😀'
          '\x1b]8;;\x1b\\\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\\x1b[6n done',
      7,
    ),
  ]) {
    final chunks = [
      for (var i = 0; i < text.length; i += chunkSize)
        text.substring(i, min(i + chunkSize, text.length)),
    ];
    final targets = [
      createBaseline(),
      ParserTarget(
        Terminal(maxLines: 1000, reflowEnabled: false)..resize(120, 30),
      ),
    ];
    void check() {
      if (jsonEncode(targets[0].state) != jsonEncode(targets[1].state)) {
        throw StateError('$name: parser states or replies differ');
      }
      comparisons++;
    }

    for (var i = 0; i < 5; i++) {
      for (final chunk in chunks) {
        for (final target in targets) {
          target.write(chunk);
        }
        check();
      }
    }
    void batch(int version, int count) {
      final write = targets[version].write;
      for (var i = 0; i < count; i++) {
        for (final chunk in chunks) {
          write(chunk);
        }
      }
    }

    for (var version = 0; version < 2; version++) {
      batch(version, 1000);
    }
    final samples = [<int>[], <int>[]];
    for (var sample = 0; sample < 7; sample++) {
      for (final version in sample.isEven ? [0, 1] : [1, 0]) {
        final watch = Stopwatch()..start();
        batch(version, 3000);
        watch.stop();
        samples[version].add(watch.elapsedMicroseconds);
      }
    }
    check();
    results[name] = {
      'chunksPerIteration': chunks.length,
      'codeUnitsPerIteration': text.length,
      'iterations': 3000,
      'baselineMicros': samples[0],
      'candidateMicros': samples[1],
    };
  }
  final output = File(Platform.environment['HARNESS_PARSER_BENCH_OUTPUT']!);
  if (output.existsSync()) throw StateError('Output already exists');
  output.writeAsStringSync(
    jsonEncode({
      'schema': 1,
      'dartVersion': Platform.version,
      'stateComparisons': comparisons,
      'results': results,
    }),
  );
}
