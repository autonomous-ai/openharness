import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/measurement/speed_marks.dart';
import 'package:harness/measurement/speed_report.dart';

// Task #3176: the numbers that pick the speed work and stay as its "before".

void main() {
  late Duration now;
  late List<String> written;
  late SpeedMarks marks;

  setUp(() {
    now = Duration.zero;
    written = [];
    marks = SpeedMarks(sink: written.add, elapsed: () => now);
  });

  group('SpeedMarks', () {
    test('a launch step is kept once, in milliseconds since launch', () {
      marks.start();
      now = const Duration(milliseconds: 120);
      marks.launch('first frame');
      now = const Duration(milliseconds: 900);
      marks.launch('first frame');
      marks.launch('saved tabs');

      expect(written, [
        'launch step=started ms=0',
        'launch step=first_frame ms=120',
        'launch step=saved_tabs ms=900',
      ]);
    });

    test('a line carries no name, id, path or address', () {
      marks.start();
      marks.launch('Sign in as huy@example.com /Users/huy');

      for (final line in written) {
        expect(line, isNot(contains('@')));
        expect(line, isNot(contains('/')));
        expect(line, isNot(contains(' as ')));
      }
    });

    test('a sink that throws never reaches the caller', () {
      final broken = SpeedMarks(
        sink: (_) => throw StateError('disk full'),
        elapsed: () => now,
      );
      expect(() => broken.start(), returnsNormally);
      expect(() => broken.launch('x'), returnsNormally);
    });

    test('a second launch in one process starts the steps over', () {
      marks.start();
      marks.launch('tools');
      marks.restart();
      marks.launch('tools');

      expect(written.where((l) => l.contains('step=tools')), hasLength(2));
    });
  });

  group('before the log is installed', () {
    test('marks wait for the real log and then arrive in order', () {
      // main() starts the marks before installFileLogs() has replaced the
      // no-op log: the launch line must not be lost with it.
      AppLog current = const NoopAppLog();
      final seen = <String>[];
      final early = SpeedMarks(log: () => current, elapsed: () => now);
      early.start();
      now = const Duration(milliseconds: 40);
      early.launch('settings loaded');

      current = _Seen(seen);
      now = const Duration(milliseconds: 90);
      early.launch('window configured');

      expect(seen, [
        'launch step=started ms=0',
        'launch step=settings_loaded ms=40',
        'launch step=window_configured ms=90',
      ]);
    });

    test('a log that never comes holds only the first 64 lines', () {
      AppLog current = const NoopAppLog();
      final seen = <String>[];
      final early = SpeedMarks(log: () => current, elapsed: () => now);
      for (var i = 0; i < 500; i++) {
        early.launch('step $i');
      }
      current = _Seen(seen);
      early.launch('one more');

      expect(seen, hasLength(65));
    });
  });

  group('SpeedReport', () {
    const stamp = '2026-11-05T09:00:00.000 INFO  speed ';
    List<String> lines(List<String> raw) => [
      '2026-11-05T08:59:00.000 INFO  app launched',
      for (final r in raw) '$stamp$r',
    ];

    test('names the three slowest launch steps by the time each took', () {
      final report = SpeedReport.parse(
        lines([
          'launch step=started ms=0',
          'launch step=settings ms=40',
          'launch step=first_frame ms=300',
          'launch step=tools ms=350',
          'launch step=signed-in_check ms=1950',
          'launch step=daemon ms=2250',
          'launch step=window ms=2300',
          'launch step=first_screen_painted ms=3300',
        ]),
      );

      expect(report.slowestLaunch.map((s) => s.name), [
        'signed-in_check',
        'first_screen_painted',
        'daemon',
      ]);
      expect(report.slowestLaunch.first.tookMs, 1600);
    });

    test('only the last launch in the log is reported', () {
      final report = SpeedReport.parse(
        lines([
          'launch step=started ms=0',
          'launch step=first_screen_painted ms=9000',
          'launch step=started ms=0',
          'launch step=first_screen_painted ms=2000',
        ]),
      );
      expect(report.launch.last.atMs, 2000);
      expect(report.markdown(), isNot(contains('9000')));
    });

    test('lines that are not speed marks are ignored', () {
      final report = SpeedReport.parse([
        '2026-11-05T09:00:00.000 INFO  ws connected',
        'speed junk',
        '${stamp}launch step=started ms=x',
      ]);
      expect(report.launch, isEmpty);
    });
  });
}

class _Seen implements AppLog {
  _Seen(this.lines);
  final List<String> lines;
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (category == 'speed') lines.add(message);
  }
}
