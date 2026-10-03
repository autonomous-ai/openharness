import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/logging/error_burst_filter.dart';
import 'package:harness_mobile/logging/log_file.dart';

/// The day files a phone writes under `~/.harness/logs` — here in a temporary
/// directory, never a real Harness home.
void main() {
  late Directory dir;
  late DateTime now;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('file_logs_test');
    now = DateTime(2026, 9, 27, 9, 5, 7);
  });

  tearDown(() => dir.deleteSync(recursive: true));

  DailyLogFile daily({int retentionDays = 14}) =>
      DailyLogFile(dir, 'app', retentionDays: retentionDays, clock: () => now);

  List<String> names() =>
      [for (final e in dir.listSync()) e.uri.pathSegments.last]..sort();

  group('stamps', () {
    test('a dated file name, a wall clock, and a short duration', () {
      expect(dailyLogName('app', DateTime(2026, 1, 2)), 'app-20260102.log');
      expect(logStamp(DateTime(2026, 1, 2, 3, 4, 5)), '2026-01-02 03:04:05');
      expect(logClock(DateTime(2026, 1, 2, 13, 4, 5)), '13:04:05');
      expect(logDuration(const Duration(seconds: 59)), '59s');
      expect(logDuration(const Duration(seconds: 61)), '1m1s');
    });
  });

  group('the day file', () {
    test('appends a line to today\'s file, creating the folder', () {
      final file = DailyLogFile(
        Directory('${dir.path}/logs'),
        'app',
        clock: () => now,
      );
      file.append('one');
      file.append('two');

      expect(file.currentFile.path, endsWith('/logs/app-20260927.log'));
      expect(file.currentFile.readAsStringSync(), 'one\ntwo\n');
    });

    test('a new day writes a new file and prunes past the retention', () {
      for (final day in ['20260901', '20260912', '20260913', '20260926']) {
        File('${dir.path}/app-$day.log').writeAsStringSync('old\n');
      }
      // Not this base's, or not a dated name: never touched.
      File('${dir.path}/cli-20260101.log').writeAsStringSync('cli\n');
      File('${dir.path}/app-notes.log').writeAsStringSync('mine\n');
      File('${dir.path}/app-20260101.txt').writeAsStringSync('mine\n');

      daily().append('today');

      expect(names(), [
        'app-20260101.txt',
        'app-20260913.log',
        'app-20260926.log',
        'app-20260927.log',
        'app-notes.log',
        'cli-20260101.log',
      ]);
    });

    test('pruning runs once per day, not on every line', () {
      final file = daily();
      file.append('first');
      File('${dir.path}/app-20200101.log').writeAsStringSync('old\n');
      file.append('second');
      expect(File('${dir.path}/app-20200101.log').existsSync(), isTrue);

      now = now.add(const Duration(days: 1));
      file.append('tomorrow');
      expect(File('${dir.path}/app-20200101.log').existsSync(), isFalse);
      expect(File('${dir.path}/app-20260928.log').existsSync(), isTrue);
    });

    test('a retention of zero keeps everything', () {
      File('${dir.path}/app-20200101.log').writeAsStringSync('old\n');
      daily(retentionDays: 0).append('today');
      expect(File('${dir.path}/app-20200101.log').existsSync(), isTrue);
    });

    test('a folder that cannot be made costs the line, never the caller', () {
      final blocked = File('${dir.path}/blocked')..writeAsStringSync('file');
      final file = DailyLogFile(
        Directory('${blocked.path}/logs'),
        'app',
        clock: () => now,
      );
      file.append('lost');
      expect(file.currentFile.existsSync(), isFalse);
    });
  });

  group('the app log', () {
    late DailyLogFile file;
    late ErrorBurstFilter burst;
    late FileAppLog log;

    setUp(() {
      file = daily();
      burst = ErrorBurstFilter(clock: () => now);
      log = FileAppLog(file, burst: burst, clock: () => now);
    });

    List<String> lines() => file.currentFile.readAsLinesSync();

    test('one stamped line per event, level and category in columns', () {
      log.debug('ws', 'frame');
      log.info('startup', 'firstFrame @12ms');
      log.warn('api', 'GET /api/machines → 503', error: 'unavailable');

      expect(lines(), [
        '[2026-09-27 09:05:07] DEBUG ws      frame',
        '[2026-09-27 09:05:07] INFO  startup firstFrame @12ms',
        '[2026-09-27 09:05:07] WARN  api     GET /api/machines → 503  '
            'err=unavailable',
      ]);
    });

    test('a failure carries its stack, indented under it', () {
      log.failure(
        'flutter',
        'build threw',
        error: StateError('bad'),
        stackTrace: StackTrace.fromString('#0 main\n#1 run\n'),
      );

      expect(lines(), [
        '[2026-09-27 09:05:07] ERROR flutter build threw  err=Bad state: bad',
        '    #0 main',
        '    #1 run',
      ]);
    });

    test('an error repeating every frame is written once, then counted', () {
      for (var i = 0; i < 5; i++) {
        log.failure('flutter', 'paint threw');
      }
      expect(lines(), hasLength(1));

      now = now.add(const Duration(seconds: 31));
      log.failure('flutter', 'paint threw');
      expect(
        lines().last,
        '[2026-09-27 09:05:38] ERROR flutter paint threw  '
        '[+4 identical since the last copy]',
      );
    });

    test('lower levels are said once by choice and never filtered', () {
      log.warn('ws', 'redialling');
      log.warn('ws', 'redialling');
      expect(lines(), hasLength(2));
    });

    test('the default sink is silent', () {
      const NoopAppLog().record(AppLogLevel.error, 'app', 'nothing');
    });
  });

  group('the burst filter', () {
    test('matches on the first line, so a changing tail is one burst', () {
      final filter = ErrorBurstFilter(clock: () => now);
      expect(filter.admit('boom\nat frame 1'), 'boom\nat frame 1');
      expect(filter.admit('boom\nat frame 2'), isNull);
      expect(filter.admit('other'), 'other');
      expect(filter.trackedCount, 2);
    });

    test('a very long first line is signed by its first 200 characters', () {
      final filter = ErrorBurstFilter(clock: () => now);
      final head = 'x' * 200;
      expect(filter.admit('${head}a'), isNotNull);
      expect(filter.admit('${head}b'), isNull);
    });

    test('never tracks more than its bound', () {
      final filter = ErrorBurstFilter(clock: () => now);
      for (var i = 0; i < 300; i++) {
        filter.admit('error $i');
      }
      expect(filter.trackedCount, lessThanOrEqualTo(256));
    });
  });
}
