import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/logging/http_log.dart';
import 'package:harness_mobile/logging/log_stream.dart';
import 'package:harness_mobile/logging/log_stream_sinks.dart';
import 'package:harness_mobile/logging/startup_trace.dart';

import '../viewer/fake_http.dart';

/// Every line the app log was handed, as the file would read it.
class _Recording implements AppLog {
  final lines = <({AppLogLevel level, String category, String message})>[];
  final errors = <Object?>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    lines.add((level: level, category: category, message: message));
    errors.add(error);
  }
}

void main() {
  late _Recording recording;

  setUp(() {
    recording = _Recording();
    appLog = recording;
  });

  tearDown(() => appLog = const NoopAppLog());

  group('HTTP calls in the timeline', () {
    Dio dio(Map<String, FakeReply> replies) =>
        attachHttpLog(FakeHttp(replies).dio());

    test(
      'a call that worked is one debug line: verb, url, status, time',
      () async {
        await dio({
          '/api/machines': (status: 200, body: {'success': true}),
        }).get<Object?>('/api/machines');

        final line = recording.lines.single;
        expect(line.level, AppLogLevel.debug);
        expect(line.category, 'api');
        expect(
          line.message,
          matches(
            RegExp(r'^GET https://fake\.invalid/api/machines → 200 \(\d+ms\)$'),
          ),
        );
      },
    );

    test('an answer that is not a success is a warning', () async {
      await dio({
        '/api/desk': (status: 503, body: {'success': false}),
      }).get<Object?>('/api/desk');

      expect(recording.lines.single.level, AppLogLevel.warn);
      expect(recording.lines.single.message, contains('→ 503'));
    });

    test(
      'no answer at all is a warning with the reason, never a body',
      () async {
        await expectLater(
          dio(const {}).post<Object?>(
            '/api/auth/exchange',
            data: {'code': 'one-time', 'state': 's', 'tx': 't'},
          ),
          throwsA(isA<DioException>()),
        );

        final line = recording.lines.single;
        expect(line.level, AppLogLevel.warn);
        expect(
          line.message,
          startsWith('POST https://fake.invalid/api/auth/exchange → failed'),
        );
        expect(recording.errors.single, isNotNull);
        expect('${recording.lines}', isNot(contains('one-time')));
      },
    );

    test('a credential in the query never reaches the line', () async {
      await dio({'/api/voice/stt': (status: 200, body: const {})}).get<Object?>(
        '/api/voice/stt',
        queryParameters: {'lang': 'vi', 'token': 'live-secret'},
      );

      expect(recording.lines.single.message, contains('token=<redacted>'));
      expect(recording.lines.single.message, contains('lang=vi'));
      expect(recording.lines.single.message, isNot(contains('live-secret')));
    });
  });

  group('the launch timeline', () {
    test('a mark is a moment, stamped with its offset', () {
      StartupTrace.mark('firstFrame');
      expect(recording.lines.single.category, 'startup');
      expect(
        recording.lines.single.message,
        matches(RegExp(r'^firstFrame @\d+ms$')),
      );
    });

    test('a span says what it cost and where it fell', () async {
      expect(await StartupTrace.time('prefs.load', () async => 7), 7);
      expect(StartupTrace.timeSync('parse', () => 'ok'), 'ok');

      expect(recording.lines.map((l) => l.message), [
        matches(RegExp(r'^prefs\.load took \d+ms \(at \d+ms\)$')),
        matches(RegExp(r'^parse took \d+ms \(at \d+ms\)$')),
      ]);
    });

    test('a step that throws is still timed, then rethrown', () async {
      await expectLater(
        StartupTrace.time<void>(
          'boot.configLoad',
          () async => throw StateError('x'),
        ),
        throwsStateError,
      );
      expect(
        () => StartupTrace.timeSync<void>('sync', () => throw StateError('y')),
        throwsStateError,
      );
      expect(recording.lines, hasLength(2));
      expect(recording.lines.first.message, startsWith('boot.configLoad took'));
    });
  });

  group('the debug build\'s mirror', () {
    test('a line goes to every sink, the file first', () {
      final stream = LogStream();
      FanoutAppLog([recording, StreamAppLog(stream)]).record(
        AppLogLevel.error,
        'ws',
        'dial failed',
        error: StateError('refused'),
        stackTrace: StackTrace.fromString('#0 dial'),
      );

      expect(recording.lines.single.message, 'dial failed');
      final entry = stream.entries.single;
      expect(entry.message, 'dial failed');
      expect(entry.category, 'ws');
      expect(entry.error, 'Bad state: refused');
      expect(entry.stackTrace, '#0 dial');
      expect(entry.status, LogStatus.failed);
      expect(entry.hasDetail, isTrue);
    });

    test('levels read as the list draws them', () {
      final stream = LogStream();
      final sink = StreamAppLog(stream);
      sink.warn('ws', 'redialling');
      sink.info('app', 'launched');

      expect(stream.entries.map((e) => e.status), [
        LogStatus.event,
        LogStatus.warned,
      ]);
      expect(stream.entries.first.hasDetail, isFalse);
    });

    test(
      'the ring keeps the newest lines, and notifies once per burst',
      () async {
        final stream = LogStream(maxEntries: 3);
        var notified = 0;
        stream.addListener(() => notified++);
        for (var i = 0; i < 5; i++) {
          stream.add(AppLogLevel.info, 'app', 'line $i');
        }
        expect(stream.entries.map((e) => e.message), [
          'line 4',
          'line 3',
          'line 2',
        ]);
        await Future<void>.delayed(Duration.zero);
        expect(notified, 1);
      },
    );
  });
}
