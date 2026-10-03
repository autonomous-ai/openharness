import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/crash_log.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/error_burst_filter.dart';
import 'package:harness/logging/log_export.dart';
import 'package:harness/logging/log_append.dart';
import 'package:harness/logging/log_file.dart';
import 'package:harness/logging/log_stream.dart';
import 'package:harness/logging/log_stream_sinks.dart';

void main() {
  late Directory dir;
  late AppLog previousLog;
  final files = <DailyLogFile>[];

  setUp(() {
    dir = Directory.systemTemp.createTempSync('harness-buffered-log-');
    previousLog = appLog;
  });
  tearDown(() {
    for (final file in files) {
      file.flush();
    }
    files.clear();
    appLog = previousLog;
    CrashLog.testFile = null;
    dir.deleteSync(recursive: true);
  });

  DailyLogFile file({
    DateTime Function()? clock,
    int maxCharacters = 64 * 1024,
    int maxEntries = 256,
    Directory? directory,
  }) {
    final result = DailyLogFile(
      directory ?? dir,
      'app',
      clock: clock ?? () => DateTime(2026, 10, 1, 12),
      maxBufferedCharacters: maxCharacters,
      maxBufferedEntries: maxEntries,
    );
    files.add(result);
    return result;
  }

  testWidgets('one deadline batches entries without extending on each event', (
    tester,
  ) async {
    final sink = file();
    sink.append('first', buffered: true);
    await tester.pump(const Duration(milliseconds: 900));
    sink.append('second', buffered: true);
    expect(sink.currentFile.existsSync(), isFalse);
    await tester.pump(const Duration(milliseconds: 100));
    expect(sink.currentFile.readAsStringSync(), 'first\nsecond\n');
    final modified = sink.currentFile.lastModifiedSync();
    await tester.pump(const Duration(minutes: 1));
    expect(sink.currentFile.lastModifiedSync(), modified);
  });

  testWidgets('explicit flush cancels the deadline and permits a new batch', (
    tester,
  ) async {
    final sink = file();
    sink.flush();
    expect(sink.currentFile.existsSync(), isFalse);
    sink.append('one', buffered: true);
    await tester.pump(const Duration(milliseconds: 900));
    sink.flush();
    sink.flush();
    sink.append('two', buffered: true);
    await tester.pump(const Duration(milliseconds: 100));
    expect(sink.currentFile.readAsStringSync(), 'one\n');
    await tester.pump(const Duration(milliseconds: 900));
    expect(sink.currentFile.readAsStringSync(), 'one\ntwo\n');
  });

  test('immediate append commits pending context in order', () {
    final sink = file();
    sink.append('before', buffered: true);
    sink.append('warning');
    expect(sink.currentFile.readAsStringSync(), 'before\nwarning\n');
    sink.flush();
    expect(sink.currentFile.readAsStringSync(), 'before\nwarning\n');
  });

  test('entry limit bounds a burst and does not drop entries', () {
    final sink = file(maxEntries: 2);
    sink.append('one', buffered: true);
    expect(sink.currentFile.existsSync(), isFalse);
    sink.append('two', buffered: true);
    expect(sink.currentFile.readAsStringSync(), 'one\ntwo\n');
    sink.append('three', buffered: true);
    sink.flush();
    expect(sink.currentFile.readAsStringSync(), 'one\ntwo\nthree\n');
  });

  test('character limit flushes before overflow and on an exact fit', () {
    final sink = file(maxCharacters: 8);
    sink.append('abc', buffered: true);
    sink.append('def', buffered: true);
    expect(sink.currentFile.readAsStringSync(), 'abc\ndef\n');
    sink.append('12345', buffered: true);
    sink.append('678', buffered: true);
    expect(sink.currentFile.readAsStringSync(), 'abc\ndef\n12345\n');
    sink.flush();
    expect(sink.currentFile.readAsStringSync(), 'abc\ndef\n12345\n678\n');
  });

  test('oversized blocks are written directly, after any pending entries', () {
    final sink = file(maxCharacters: 8);
    sink.append('1234567', buffered: true);
    expect(sink.currentFile.readAsStringSync(), '1234567\n');
    sink.append('x', buffered: true);
    sink.append('a larger block', buffered: true);
    expect(sink.currentFile.readAsStringSync(), '1234567\nx\na larger block\n');
  });

  test('Unicode, multiline blocks and empty blocks preserve exact bytes', () {
    final immediate = DailyLogFile(Directory('${dir.path}/before'), 'app');
    final buffered = file(directory: Directory('${dir.path}/after'));
    final blocks = ['', 'hello 🦋', '日本語\nsecond line', '\n', 'a' * 90000];
    for (final block in blocks) {
      immediate.append(block);
      buffered.append(block, buffered: true);
    }
    buffered.flush();
    expect(
      buffered.currentFile.readAsBytesSync(),
      immediate.currentFile.readAsBytesSync(),
    );
  });

  test('a Unicode log path preserves both prior and appended bytes', () {
    final output = File('${dir.path}/log 日本語 🦋.txt');
    appendDurableLog(output, 'first\n');
    appendDurableLog(output, 'second\n');
    expect(output.readAsStringSync(), 'first\nsecond\n');
  });

  test('an invalid NUL path never appends to its valid prefix', () {
    final output = File('${dir.path}/existing');
    output.writeAsStringSync('preserved');
    expect(
      () => appendDurableLog(File('${output.path}\u0000suffix'), 'bad'),
      throwsArgumentError,
    );
    expect(output.readAsStringSync(), 'preserved');
  });

  test('opening a directory as a log fails without altering it', () {
    expect(
      () => appendDurableLog(File(dir.path), 'bad'),
      throwsA(isA<FileSystemException>()),
    );
    expect(dir.listSync(), isEmpty);
  });

  test('a full device reports failure and releases the handle', () {
    final descriptors = Directory('/proc/self/fd');
    final before = descriptors.listSync().length;
    for (var i = 0; i < 32; i++) {
      expect(
        () => appendDurableLog(File('/dev/full'), 'cannot fit'),
        throwsA(isA<FileSystemException>()),
      );
    }
    expect(descriptors.listSync().length, lessThanOrEqualTo(before + 1));
  }, skip: !Platform.isLinux);

  test(
    'independent writers retain complete records in a shared daily file',
    () async {
      final directory = dir.path;
      await Future.wait([
        for (var writer = 0; writer < 2; writer++)
          Isolate.run(() => _writeConcurrentBatch(directory, writer)),
      ]);
      final lines = File('$directory/app-20261001.log').readAsLinesSync();
      expect(lines, hasLength(2000));
      for (var writer = 0; writer < 2; writer++) {
        expect(
          lines.where((line) => line.startsWith('writer $writer ')),
          List.generate(1000, (i) => 'writer $writer record $i 🦋'),
        );
      }
    },
    skip: !Platform.isMacOS && !Platform.isLinux,
  );

  for (final backwards in [false, true]) {
    test(
      'a ${backwards ? 'backwards clock jump' : 'new day'} preserves dates',
      () {
        var now = DateTime(2026, 10, 1, 23, 59, 59);
        final sink = file(clock: () => now);
        sink.append('original day', buffered: true);
        now = backwards
            ? now.subtract(const Duration(days: 1))
            : now.add(const Duration(seconds: 2));
        sink.append('changed day', buffered: true);
        expect(
          File('${dir.path}/app-20261001.log').readAsStringSync(),
          'original day\n',
        );
        sink.flush();
        expect(sink.currentFile.readAsStringSync(), 'changed day\n');
      },
    );
  }

  testWidgets('a timer crossing midnight still writes to the original day', (
    tester,
  ) async {
    var now = DateTime(2026, 10, 1, 23, 59, 59);
    final sink = file(clock: () => now);
    sink.append('late record', buffered: true);
    now = now.add(const Duration(seconds: 2));
    await tester.pump(const Duration(seconds: 1));
    expect(
      File('${dir.path}/app-20261001.log').readAsStringSync(),
      'late record\n',
    );
    expect(sink.currentFile.existsSync(), isFalse);
  });

  testWidgets('a failed timed write drops its batch and permits recovery', (
    tester,
  ) async {
    final blocker = File('${dir.path}/blocker')..writeAsStringSync('x');
    final sink = file(directory: Directory('${blocker.path}/logs'));
    sink.append('failed batch', buffered: true);
    await tester.pump(const Duration(seconds: 1));
    blocker.deleteSync();
    sink.append('recovered', buffered: true);
    await tester.pump(const Duration(seconds: 1));
    expect(sink.currentFile.readAsStringSync(), 'recovered\n');
  });

  for (final level in [AppLogLevel.info, AppLogLevel.warn, AppLogLevel.error]) {
    test('$level makes its preceding debug context durable immediately', () {
      final sink = file();
      final log = FileAppLog(sink, bufferDebug: true);
      log.debug('ws', 'preceding context');
      expect(sink.currentFile.existsSync(), isFalse);
      log.record(
        level,
        'app',
        'important event',
        stackTrace: StackTrace.fromString('frame one'),
      );
      final text = sink.currentFile.readAsStringSync();
      expect(
        text.indexOf('preceding context'),
        lessThan(text.indexOf('important event')),
      );
      expect(text, contains('    frame one'));
    });
  }

  test(
    'duplicate errors preserve burst protection with interleaved debug context',
    () {
      final at = DateTime(2026, 10, 1);
      final sink = file(clock: () => at);
      final log = FileAppLog(
        sink,
        bufferDebug: true,
        burst: ErrorBurstFilter(clock: () => at),
      );
      log.failure('flutter', 'same error');
      log.debug('ws', 'new context');
      log.failure('flutter', 'same error');
      expect(
        sink.currentFile.readAsStringSync(),
        isNot(contains('new context')),
      );
      log.flush();
      final text = sink.currentFile.readAsStringSync();
      expect('same error'.allMatches(text), hasLength(1));
      expect(text, contains('new context'));
    },
  );

  test('buffered debug stacks retain their order', () {
    final sink = file();
    final log = FileAppLog(sink, bufferDebug: true);
    log.record(
      AppLogLevel.debug,
      'ws',
      'with stack',
      stackTrace: StackTrace.fromString('one\ntwo'),
    );
    expect(sink.currentFile.existsSync(), isFalse);
    log.flush();
    expect(
      sink.currentFile.readAsStringSync(),
      contains('with stack\n    one\n    two\n'),
    );
  });

  test('a crash commits its preceding context and stack to both logs', () {
    final sink = file();
    appLog = FileAppLog(sink, bufferDebug: true);
    CrashLog.testFile = File('${dir.path}/errors.log');
    appLog.debug('ws', 'before crash');
    CrashLog.record(
      StateError('test crash'),
      StackTrace.fromString('crash frame'),
    );
    final text = sink.currentFile.readAsStringSync();
    expect(text, contains('before crash'));
    expect(text, contains('test crash'));
    expect(text, contains('crash frame'));
    expect(CrashLog.testFile!.readAsStringSync(), contains('crash frame'));
  });

  test('the Debug mirror is immediate and a fanout flush commits the file', () {
    final sink = file();
    final stream = LogStream();
    appLog = FanoutAppLog([
      FileAppLog(sink, bufferDebug: true),
      StreamAppLog(stream),
    ]);
    appLog.debug('ws', 'visible immediately');
    expect(stream.entries.single.message, 'visible immediately');
    expect(sink.currentFile.existsSync(), isFalse);
    flushAppLog();
    expect(
      sink.currentFile.readAsStringSync(),
      contains('visible immediately'),
    );
    appLog = const NoopAppLog();
    expect(flushAppLog, returnsNormally);
  });

  test(
    'export flushes the pending tail before the CLI collects files',
    () async {
      final sink = file();
      appLog = FileAppLog(sink, bufferDebug: true);
      appLog.debug('ws', 'newest exported entry');
      final result = await exportLogs(
        _ExportRunner(() {
          expect(
            sink.currentFile.readAsStringSync(),
            contains('newest exported entry'),
          );
        }),
      );
      expect(result.path, '/fixture/logs.zip');
    },
  );
}

void _writeConcurrentBatch(String directory, int writer) {
  final file = DailyLogFile(
    Directory(directory),
    'app',
    clock: () => DateTime(2026, 10, 1),
  );
  for (var i = 0; i < 1000; i++) {
    file.append('writer $writer record $i 🦋', buffered: true);
  }
  file.flush();
}

class _ExportRunner extends HarnessCliRunner {
  _ExportRunner(this.beforeExport);
  final void Function() beforeExport;

  @override
  Future<ProcessResult> run(List<String> arguments) async {
    expect(arguments, ['logs', 'export', '--json']);
    beforeExport();
    return ProcessResult(
      0,
      0,
      '{"path":"/fixture/logs.zip","included":[]}',
      '',
    );
  }
}
