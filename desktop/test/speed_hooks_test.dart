import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';

import 'support/super_tab_fixture.dart';

// Task #3176: the places that call the speed recorder. Each risk the task names
// has a test that fails without its hook: message reads (first page and
// scroll-up pages), image fetches, and a poll that must stay out of the log.

class _Recorder implements AppLog {
  final lines = <String>[];
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

void main() {
  late _Recorder log;
  late AppLog before;

  setUp(() {
    before = appLog;
    appLog = log = _Recorder();
  });
  tearDown(() => appLog = before);

  group('message reads', () {
    test('the first page and each scroll-up page are recorded', () async {
      final server = ConversationServer()..messagePage = 2;
      for (final text in ['one', 'two', 'three', 'four', 'five']) {
        server.append(text);
      }
      final c = server.controller();
      await c.refresh();
      expect(
        log.lines.where((l) => l.startsWith('messages kind=latest rows=2 ')),
        hasLength(1),
      );

      await c.loadMessages('lead', older: true);
      await c.loadMessages('lead', older: true);
      expect(
        log.lines.where((l) => l.startsWith('messages kind=older ')),
        hasLength(2),
      );
      expect(
        log.lines.where((l) => l.startsWith('messages ')),
        everyElement(
          matches(r'^messages kind=\w+ rows=\d+ request_ms=\d+ total_ms=\d+$'),
        ),
      );
    });

    test('a poll that finds nothing new records nothing', () async {
      final server = ConversationServer()..messagePage = 2;
      for (final text in ['one', 'two']) {
        server.append(text);
      }
      final c = server.controller();
      await c.refresh();
      log.lines.clear();

      await c.loadMessages('lead');

      expect(log.lines.where((l) => l.startsWith('messages ')), isEmpty);
    });
  });

  group('images', () {
    late Future<Uint8List> Function(Uri, {int? maxBytes}) fetcher;
    setUp(() => fetcher = attachmentFetcher);
    tearDown(() => attachmentFetcher = fetcher);

    test('a fetched picture records its bytes and time', () async {
      attachmentFetcher = (url, {maxBytes}) async => Uint8List(4321);

      final bytes = await readPicture(Uri.parse('https://files.example/a.png'));

      expect(bytes, hasLength(4321));
      expect(log.lines, [matches(r'^image ok=1 bytes=4321 ms=\d+$')]);
    });

    test('a failed picture records ok=0 and still throws', () async {
      attachmentFetcher = (url, {maxBytes}) async => throw StateError('404');

      await expectLater(
        readPicture(Uri.parse('https://files.example/a.png')),
        throwsStateError,
      );
      expect(log.lines, [matches(r'^image ok=0 bytes=0 ms=\d+$')]);
    });

    test('the line holds no address', () async {
      attachmentFetcher = (url, {maxBytes}) async => Uint8List(1);

      await readPicture(Uri.parse('https://files.example/secret-name.png'));

      expect(log.lines.single, isNot(contains('secret')));
      expect(log.lines.single, isNot(contains('files.example')));
    });
  });
}
