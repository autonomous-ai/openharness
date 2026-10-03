// Parsing plus picture recording for terminal redraws. This is a headless
// component benchmark, not display latency, GPU energy, or whole-app CPU.
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

String _redraw(String mode, int tick) {
  final text = StringBuffer();
  for (var row = 0; row < 30; row++) {
    final changed =
        mode == 'all_changed' || (mode == 'one_changed' && row == 15);
    text.write('\x1b[${row + 1};1H');
    if (mode != 'overwrite_identical') text.write('\x1b[2K');
    text.write(
      '\x1b[32mRow ${row.toString().padLeft(2, '0')} '
      '${changed ? tick % 2 : 0}: ${'terminal output ' * 5}\x1b[0m',
    );
  }
  return text.toString();
}

void main() {
  test('terminal row redraw benchmark', () {
    final output = Platform.environment['HARNESS_LINE_REDRAW_OUTPUT'];
    if (output == null || File(output).existsSync()) {
      throw StateError('Set HARNESS_LINE_REDRAW_OUTPUT to a new result file');
    }
    final results = <Map<String, Object>>[];
    for (final count in [1, 4]) {
      for (final mode in [
        'overwrite_identical',
        'erase_identical',
        'one_changed',
        'all_changed',
      ]) {
        final terminals = List.generate(
          count,
          (_) => Terminal(maxLines: 100)..resize(120, 30),
        );
        final painters = List.generate(
          count,
          (_) => TerminalPainter(
            theme: TerminalThemes.defaultTheme,
            textStyle: const TerminalStyle(),
            textScaler: TextScaler.noScaling,
          ),
        );
        final redraws = [_redraw(mode, 0), _redraw(mode, 1)];
        final rounds = <Map<String, double>>[];
        var tick = 0;
        int parsed = 0;
        int painted = 0;
        void frame() {
          final watch = Stopwatch()..start();
          for (final terminal in terminals) {
            terminal.write(redraws[tick % 2]);
          }
          final parse = watch.elapsedMicroseconds;
          for (var i = 0; i < count; i++) {
            final painter = painters[i];
            final recorder = PictureRecorder();
            final canvas = Canvas(recorder);
            painter.beginFrame();
            for (var row = 0; row < 30; row++) {
              painter.paintLineCached(
                canvas,
                Offset(0, row * painter.cellSize.height),
                terminals[i].buffer.lines[row],
              );
            }
            painter.endFrame();
            recorder.endRecording().dispose();
          }
          parsed += parse;
          painted += watch.elapsedMicroseconds - parse;
          tick++;
        }

        for (var i = 0; i < 40; i++) {
          frame();
        }
        for (var round = 0; round < 7; round++) {
          parsed = 0;
          painted = 0;
          for (var i = 0; i < 40; i++) {
            frame();
          }
          rounds.add({
            'parseUs': parsed / 40,
            'paintUs': painted / 40,
            'totalUs': (parsed + painted) / 40,
          });
        }
        // Every terminal still has the same complete screen as a fresh parser.
        final expected = Terminal(maxLines: 100)
          ..resize(120, 30)
          ..write(redraws[(tick - 1) % 2]);
        for (final terminal in terminals) {
          expect(terminal.buffer.getText(), expected.buffer.getText());
        }
        for (final painter in painters) {
          painter.clearLineCache();
        }
        double median(String key) {
          final values = rounds.map((r) => r[key]!).toList()..sort();
          return values[values.length ~/ 2];
        }

        results.add({
          'terminals': count,
          'rows': 30,
          'columns': 120,
          'mode': mode,
          'rounds': rounds,
          'medianParseUs': median('parseUs'),
          'medianPaintUs': median('paintUs'),
          'medianTotalUs': median('totalUs'),
        });
      }
    }
    File(output).writeAsStringSync(
      '${const JsonEncoder.withIndent('  ').convert({'schema': 1, 'scope': 'headless_debug_parse_and_picture_recording', 'completedAt': DateTime.now().toUtc().toIso8601String(), 'warmupFrames': 40, 'rounds': 7, 'framesPerRound': 40, 'results': results})}\n',
    );
  });
}
