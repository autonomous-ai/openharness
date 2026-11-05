import 'package:flutter_test/flutter_test.dart';
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

    test('the first chat is marked once, however many rows are built', () {
      marks.start();
      now = const Duration(milliseconds: 1500);
      marks.firstChat();
      now = const Duration(milliseconds: 1700);
      marks.firstChat();

      expect(written.where((l) => l.contains('first_chat_painted')), [
        'launch step=first_chat_painted ms=1500',
      ]);
    });

    test('a messages read keeps its kind, rows and both times', () {
      marks.messages(kind: 'older', rows: 50, requestMs: 180, totalMs: 240);

      expect(written, [
        'messages kind=older rows=50 request_ms=180 total_ms=240',
      ]);
    });

    test('an image keeps its bytes and time, a failed one says so', () {
      marks.image(ms: 95, bytes: 48213);
      marks.image(ms: 3000);

      expect(written, [
        'image ok=1 bytes=48213 ms=95',
        'image ok=0 bytes=0 ms=3000',
      ]);
    });

    test('a line carries no name, id, path or address', () {
      marks.start();
      marks.launch('Sign in as huy@example.com /Users/huy');
      marks.messages(kind: 'latest', rows: 3, requestMs: 1, totalMs: 2);
      marks.image(ms: 1, bytes: 2);

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
      expect(
        () =>
            broken.messages(kind: 'latest', rows: 1, requestMs: 1, totalMs: 1),
        returnsNormally,
      );
      expect(() => broken.image(ms: 1, bytes: 1), returnsNormally);
    });

    test('a second launch in one process starts the steps over', () {
      marks.start();
      marks.launch('tools');
      marks.restart();
      marks.launch('tools');

      expect(written.where((l) => l.contains('step=tools')), hasLength(2));
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
          'launch step=first_chat_painted ms=3300',
        ]),
      );

      expect(report.slowestLaunch.map((s) => s.name), [
        'signed-in_check',
        'first_chat_painted',
        'daemon',
      ]);
      expect(report.slowestLaunch.first.tookMs, 1600);
      expect(report.launchToFirstChatMs, 3300);
    });

    test('only the last launch in the log is reported', () {
      final report = SpeedReport.parse(
        lines([
          'launch step=started ms=0',
          'launch step=first_chat_painted ms=9000',
          'launch step=started ms=0',
          'launch step=first_chat_painted ms=2000',
        ]),
      );
      expect(report.launchToFirstChatMs, 2000);
    });

    test('names the three slowest message reads and sums the images', () {
      final report = SpeedReport.parse(
        lines([
          'messages kind=latest rows=50 request_ms=300 total_ms=380',
          'messages kind=older rows=50 request_ms=900 total_ms=1000',
          'messages kind=older rows=50 request_ms=200 total_ms=250',
          'messages kind=older rows=50 request_ms=500 total_ms=560',
          'image ok=1 bytes=1000 ms=100',
          'image ok=1 bytes=3000 ms=300',
          'image ok=0 bytes=0 ms=3000',
        ]),
      );

      expect(report.slowestReads.map((r) => r.totalMs), [1000, 560, 380]);
      expect(report.images.where((i) => i.ok), hasLength(2));
      expect(report.imageBytes, 4000);
    });

    test('reads and images before the last launch are not reported', () {
      final report = SpeedReport.parse(
        lines([
          'launch step=started ms=0',
          'messages kind=latest rows=50 request_ms=9000 total_ms=9500',
          'messages kind=older rows=50 request_ms=9000 total_ms=9500',
          'image ok=1 bytes=99999 ms=9000',
          'launch step=started ms=0',
          'launch step=first_chat_painted ms=2000',
          'messages kind=latest rows=3 request_ms=100 total_ms=120',
          'messages kind=latest rows=50 request_ms=300 total_ms=380',
          'image ok=1 bytes=1000 ms=100',
        ]),
      );

      // Both first pages of this launch (the chat shown at launch and the big
      // chat opened after it), none of the earlier launch.
      expect(report.reads.map((r) => r.totalMs), [120, 380]);
      expect(report.images, hasLength(1));
      expect(report.imageBytes, 1000);
      final table = report.markdown();
      expect(table, contains('| latest | 3 |'));
      expect(table, contains('| latest | 50 |'));
      expect(table, isNot(contains('9500')));
    });

    test('steps after the first chat are not among the slowest of launch', () {
      final report = SpeedReport.parse(
        lines([
          'launch step=started ms=0',
          'launch step=tools ms=500',
          'launch step=first_chat_painted ms=1500',
          'launch step=machines_listed ms=9000',
        ]),
      );

      expect(report.slowestLaunch.map((s) => s.name), [
        'first_chat_painted',
        'tools',
        'started',
      ]);
    });

    test('the table has launch, big-chat and image rows', () {
      final table = SpeedReport.parse(
        lines([
          'launch step=started ms=0',
          'launch step=first_chat_painted ms=2000',
          'messages kind=latest rows=50 request_ms=300 total_ms=380',
          'image ok=1 bytes=1000 ms=100',
        ]),
      ).markdown();

      expect(table, contains('| Open the app to a painted chat | 2000 ms |'));
      expect(table, contains('latest'));
      expect(table, contains('Images'));
    });

    test('lines that are not speed marks are ignored', () {
      final report = SpeedReport.parse([
        '2026-11-05T09:00:00.000 INFO  ws connected',
        'speed junk',
        '${stamp}messages kind=latest rows=x request_ms=1 total_ms=2',
      ]);
      expect(report.reads, isEmpty);
      expect(report.launch, isEmpty);
    });
  });
}
