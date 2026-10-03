// Run explicitly with `flutter test --no-pub test/benchmarks/diagnostic_log_benchmark.dart`.
// Real temporary files, alternating order, identical final bytes. Measures the
// logging component, not app CPU, frame latency, battery life or energy impact.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/log_append.dart';
import 'package:harness/logging/log_file.dart';

void main() {
  test('durable diagnostic writes, immediate versus bounded batches', () async {
    final root = Directory.systemTemp.createTempSync('harness-log-benchmark-');
    final results = <Map<String, Object>>[];
    try {
      for (final paced in [false, true]) {
        final trials = paced ? 3 : 5;
        final records = paced ? 64 : 2000;
        for (var trial = 0; trial < trials; trial++) {
          final outputs = <List<int>>[];
          for (final buffered in trial.isEven ? [false, true] : [true, false]) {
            final directory = Directory('${root.path}/$paced-$trial-$buffered');
            var now = DateTime(2026, 10, 1, 12);
            final writes = _Writes();
            final file = _TimedLogFile(directory, () => now, (file, contents) {
              if (buffered) {
                appendDurableLog(file, contents);
              } else {
                // The durable append used by the deployed, unbuffered logger.
                file.writeAsStringSync(
                  contents,
                  mode: FileMode.append,
                  flush: true,
                );
              }
              writes.durable++;
            });
            final log = FileAppLog(
              file,
              bufferDebug: buffered,
              clock: () => now,
            );
            final elapsed = Stopwatch()..start();
            {
              for (var i = 0; i < records; i++) {
                now = DateTime(
                  2026,
                  10,
                  1,
                  12,
                ).add(Duration(milliseconds: i * 125));
                log.debug(
                  'ws',
                  '↓ ${['agent_activity', 'turn_heartbeat', 'agent_recent'][i % 3]} '
                      '{agentId: fixture-${i % 12}, status: working, requestId: fixture-$i}',
                );
                // Include durable operational records, not just a best-case
                // all-debug burst. They must still commit the preceding tail.
                if (i % 32 == 31) {
                  log.warn('ws', 'fixture poll failed: timeout');
                }
                if (paced) {
                  await Future<void>.delayed(const Duration(milliseconds: 125));
                }
              }
              log.flush();
            }
            elapsed.stop();
            final bytes = file.currentFile.readAsBytesSync();
            outputs.add(bytes);
            final result = <String, Object>{
              'scenario': paced
                  ? '8 debug records per second'
                  : '2000-record burst',
              'trial': trial,
              'buffered': buffered,
              'records': records,
              'warnings': records ~/ 32,
              'durableAppends': writes.durable,
              'synchronousLogMs': file.work.elapsedMicroseconds / 1000,
              'elapsedMs': elapsed.elapsedMicroseconds / 1000,
              'fileBytes': bytes.length,
            };
            results.add(result);
            // ignore: avoid_print
            print('DIAGNOSTIC_LOG_BENCH ${jsonEncode(result)}');
          }
          expect(
            outputs.first,
            outputs.last,
            reason: 'buffering must retain every byte in order',
          );
        }
      }
      final output = Platform.environment['DIAGNOSTIC_LOG_BENCH_OUTPUT'];
      if (output != null) {
        File(output).writeAsStringSync(
          '${const JsonEncoder.withIndent('  ').convert({'scope': 'Real-file component benchmark. Work time includes synchronous append and timer/explicit flush execution; excludes intentional waits. No whole-app improvement claim.', 'at': DateTime.now().toUtc().toIso8601String(), 'allFinalBytesIdentical': true, 'results': results})}\n',
        );
      }
    } finally {
      root.deleteSync(recursive: true);
    }
  }, timeout: const Timeout(Duration(minutes: 3)));
}

class _TimedLogFile extends DailyLogFile {
  _TimedLogFile(
    Directory directory,
    DateTime Function() clock,
    void Function(File, String) appendFile,
  ) : super(directory, 'app', clock: clock, appendFile: appendFile);
  final work = Stopwatch();
  var depth = 0;

  void _measure(void Function() action) {
    final outer = depth++ == 0;
    if (outer) work.start();
    try {
      action();
    } finally {
      depth--;
      if (outer) work.stop();
    }
  }

  @override
  void append(String block, {bool buffered = false}) =>
      _measure(() => super.append(block, buffered: buffered));

  @override
  void flush() => _measure(super.flush);
}

class _Writes {
  var durable = 0;
}
