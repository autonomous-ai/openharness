// Synchronous link hit-testing only. Excludes terminal rendering, pointer
// dispatch, network access, and whole-app CPU or battery consumption.
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:collection/collection.dart';
import 'package:harness/terminal/terminal_links.dart';
import 'package:xterm/core.dart';

class LinkImplementation {
  const LinkImplementation(this.name, this.inText, this.at, this.spans);
  final String name;
  final String? Function(String, int) inText;
  final String? Function(Terminal, CellOffset) at;
  final List<TerminalLinkSpan> Function(Terminal, CellOffset, String) spans;
}

const currentLinks = LinkImplementation(
  'candidate',
  terminalLinkInText,
  terminalLinkAt,
  terminalLinkSpans,
);

void main() => runLinkBenchmark();

void checkEqual(Object? actual, Object? expected, {String? reason}) {
  if (!const DeepCollectionEquality().equals(actual, expected)) {
    throw StateError(
      '${reason ?? 'Link validation failed'}: $actual != $expected',
    );
  }
}

void runChecked(String name, void Function() run) {
  run();
  stdout.writeln('LINK_BENCH_CHECK passed: $name');
}

void runLinkBenchmark({
  List<LinkImplementation> implementations = const [currentLinks],
}) {
  final equivalence = <String, int>{};
  if (implementations.length == 2) {
    runChecked(
      'matches reference targets and extents through output and resize',
      () {
        final random = Random(551551);
        const fragments = [
          'ordinary_text',
          'a.png',
          '/tmp/My image.PNG',
          '~/out/video.mp4',
          'https://example.com/a_(b)?x=1',
          'https://example.com/a.',
          '[Image](/tmp/image.webp)',
          '[no](command:run.png)',
          '`/tmp/ảnh 🖼️.png`',
          '<https://example.com/x>',
          '图 😀',
          '[',
          ']',
          '(',
          ')',
          '.',
          '/',
          ' ',
          '\t',
          'javascript:alert(1)',
          'https://bad[',
          'clip.movz',
        ];
        final before = implementations.first;
        final after = implementations.last;
        var textChecks = 0, cellChecks = 0, spanChecks = 0;
        for (var sample = 0; sample < 400; sample++) {
          final text = List.generate(
            2 + random.nextInt(6),
            (_) => fragments[random.nextInt(fragments.length)],
          ).join(' ');
          for (var at = -1; at <= text.length; at += 7) {
            checkEqual(
              after.inText(text, at),
              before.inText(text, at),
              reason: 'text sample $sample, offset $at: $text',
            );
            textChecks++;
          }
          final terminal = Terminal(maxLines: 100)
            ..resize([12, 20, 44, 120][random.nextInt(4)], 12);
          terminal.write(sample.isEven ? '\x1b[94m$text\x1b[0m' : text);
          for (var revision = 0; revision < 2; revision++) {
            final lines = terminal.buffer.lines;
            for (var point = 0; point < 8; point++) {
              final row = random.nextInt(lines.length);
              final cell = CellOffset(random.nextInt(lines[row].length), row);
              final target = before.at(terminal, cell);
              checkEqual(
                after.at(terminal, cell),
                target,
                reason: 'cell sample $sample revision $revision at $cell',
              );
              cellChecks++;
              if (target != null) {
                checkEqual(
                  after.spans(terminal, cell, target),
                  before.spans(terminal, cell, target),
                  reason: 'extent sample $sample revision $revision at $cell',
                );
                spanChecks++;
              }
            }
            terminal.write(
              '\r\x1b[2K\x1b]8;;https://example.com/changed\x1b\\new link\x1b]8;;\x1b\\',
            );
            terminal.resize(24 + random.nextInt(80), 12);
          }
        }
        equivalence.addAll({
          'textChecks': textChecks,
          'cellChecks': cellChecks,
          'spanChecks': spanChecks,
          'seed': 551551,
          'fixtures': 400,
        });
        stdout.writeln('TERMINAL_LINK_EQUIVALENCE ${jsonEncode(equivalence)}');
      },
    );
  }
  runChecked('terminal link hit-testing benchmark', () {
    final results = <Map<String, Object>>[];

    void measure(
      String name,
      void Function(LinkImplementation) operation, {
      int batch = 10,
    }) {
      // Alternate implementations within every sample to reduce ordering bias.
      for (var i = 0; i < 20; i++) {
        for (final implementation in implementations) {
          operation(implementation);
        }
      }
      final samples = {
        for (final implementation in implementations)
          implementation.name: <double>[],
      };
      for (var i = 0; i < 30; i++) {
        for (final implementation
            in i.isEven ? implementations : implementations.reversed) {
          final watch = Stopwatch()..start();
          for (var j = 0; j < batch; j++) {
            operation(implementation);
          }
          watch.stop();
          samples[implementation.name]!.add(watch.elapsedMicroseconds / batch);
        }
      }
      for (final entry in samples.entries) {
        final sorted = entry.value.toList()..sort();
        final result = <String, Object>{
          'case': name,
          'implementation': entry.key,
          'batch': batch,
          'samplesMicrosPerOperation': entry.value,
          'medianMicros': sorted[sorted.length ~/ 2],
          'p95Micros': sorted[(sorted.length * .95).ceil() - 1],
        };
        results.add(result);
        stdout.writeln('TERMINAL_LINK_BENCH ${jsonEncode(result)}');
      }
    }

    for (final length in [80, 512, 2048]) {
      final text = 'a' * length;
      checkEqual(terminalLinkInText(text, length ~/ 2), null);
      measure('plain_token_$length', (implementation) {
        if (implementation.inText(text, length ~/ 2) != null) {
          throw StateError('Ordinary text became a link');
        }
      });
    }

    final adjacent = '${'a' * 2048} image.png';
    for (final implementation in implementations) {
      checkEqual(implementation.inText(adjacent, 1024), null);
      checkEqual(implementation.inText(adjacent, 2052), 'image.png');
    }
    measure('plain_token_beside_media_2048', (implementation) {
      if (implementation.inText(adjacent, 1024) != null) {
        throw StateError('Ordinary neighboring text became a link');
      }
    });

    for (final length in [40, 160, 1000]) {
      final target = 'https://example.com/${'a' * length}';
      final terminal = Terminal()..resize(120, 20);
      terminal.write(target);
      const cell = CellOffset(10, 0);
      checkEqual(terminalLinkAt(terminal, cell), target);
      final expectedSpans = [
        for (var offset = 0; offset < target.length; offset += 120)
          (
            row: offset ~/ 120,
            start: 0,
            end: (target.length - offset - 1).clamp(0, 119),
          ),
      ];
      checkEqual(terminalLinkSpans(terminal, cell, target), expectedSpans);
      measure('url_lookup_$length', (implementation) {
        if (implementation.at(terminal, cell) != target) {
          throw StateError('Incorrect URL');
        }
      });
      measure('url_extent_$length', (implementation) {
        final spans = implementation.spans(terminal, cell, target);
        if (spans.length != expectedSpans.length ||
            spans.last != expectedSpans.last) {
          throw StateError('Incorrect URL extent');
        }
      }, batch: length == 1000 ? 1 : 5);
    }

    final output = Platform.environment['HARNESS_LINK_BENCH_OUTPUT'];
    if (output != null) {
      final file = File(output);
      if (file.existsSync()) throw StateError('Output already exists: $output');
      file.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert({
          'schema': 1,
          'recordedAt': DateTime.now().toUtc().toIso8601String(),
          'boundary': 'headless synchronous hit-testing elapsed time; runtime supplied by comparison runner',
          'dartVersion': Platform.version,
          'operatingSystem': Platform.operatingSystem,
          'equivalence': equivalence,
          'results': results,
        }),
      );
    }
  });
}
