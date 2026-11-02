import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_attachment.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_file_links.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_attachment_fakes.dart';

/// Chat files open through short-lived signed links (backend fileLinks.ts):
/// one about to end is asked for again before anything opens, a reader who
/// lost access is told so and opens nothing, a failed ask can be tapped
/// again, an answer that lands after its chat went opens nothing, and a
/// message's stored address is used only when it carries no signed link.
final _now = DateTime.utc(2026, 10, 31, 18);
final _ms = _now.millisecondsSinceEpoch;

String _signed(String id, {String sig = '1'}) =>
    'https://storage.googleapis.com/bucket/super-tabs/tab/$id/f.pdf'
    '?X-Goog-Signature=$sig';
String _cdn(String id) =>
    'https://$swarmAttachmentHost/super-tabs/tab/$id/f.pdf';

Map<String, dynamic> _row(
  String id, {
  String? url,
  String? link,
  bool unsigned = false,
  int? expiresAt,
  String mime = 'application/pdf',
  String name = 'f.pdf',
}) => {
  'id': id,
  'name': name,
  'mime': mime,
  'size': 2048,
  'url': url ?? _cdn(id),
  if (!unsigned) 'link': link ?? _signed(id),
  'expiresAt': ?expiresAt,
};

/// A backend that answers fresh-link reads by [answer], recording each path.
class _Backend {
  final reads = <String>[];
  FutureOr<Map<String, dynamic>> Function(String id)? answer;

  Future<Object?> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    reads.add(path);
    final reply = answer;
    if (reply == null) {
      throw const SuperTabFailure(
        'FILE_UNAVAILABLE',
        'This file is no longer available.',
        statusCode: 404,
      );
    }
    return {'attachment': await reply(Uri.parse(path).pathSegments.last)};
  }
}

void main() {
  late List<Uri> opened;
  late _Backend backend;
  late SwarmReader reader;
  late Future<bool> Function(Uri) openFile;

  setUp(() {
    opened = [];
    backend = _Backend();
    reader = SwarmReader(
      tabId: 'tab',
      accountId: 'me',
      request: backend.request,
    );
    openFile = swarmOpenFile;
    swarmOpenFile = (url) async {
      opened.add(url);
      return true;
    };
    swarmFileClock = () => _now;
  });
  tearDown(() {
    swarmOpenFile = openFile;
    swarmFileClock = DateTime.now;
    reader.dispose();
  });

  Finder chip(String id) => find.byKey(ValueKey('swarm-file-chip-$id'));

  Widget chat(SwarmReader reader, Map<String, dynamic> row) {
    final file = SuperTabAttachment.fromJson(row);
    final ref = SwarmFileRef(
      file,
      conversationId: 'lead',
      messageId: 'm1',
      reader: reader,
    );
    return MaterialApp(
      home: Scaffold(
        body: SwarmFiles(
          reader: reader,
          child: SwarmFileChip(file: file, link: ref.current, fileRef: ref),
        ),
      ),
    );
  }

  testWidgets('a link with more than a minute left opens as it is', (
    tester,
  ) async {
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms + 300000)));
    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(opened, [Uri.parse(_signed('a1'))]);
    expect(backend.reads, isEmpty);
  });

  testWidgets('a link about to end is asked for again, then opened', (
    tester,
  ) async {
    backend.answer = (id) => _row(
      id,
      link: _signed(id, sig: 'fresh'),
      expiresAt: _ms + 600000,
    );
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms + 30000)));
    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(backend.reads, [
      '/api/super-tabs/tab/conversations/lead/messages/m1/attachments/a1',
    ]);
    expect(opened, [Uri.parse(_signed('a1', sig: 'fresh'))]);
  });

  testWidgets('with no signed link, the stored address opens as before', (
    tester,
  ) async {
    await tester.pumpWidget(chat(reader, _row('a1', unsigned: true)));
    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(opened, [Uri.parse(_cdn('a1'))]);
    expect(backend.reads, isEmpty);
  });

  testWidgets('access lost: no longer available, nothing opened', (
    tester,
  ) async {
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
    await tester.tap(chip('a1'));
    await tester.pump();
    await tester.pump();
    expect(find.text(swarmFileGone), findsOneWidget);
    expect(backend.reads, hasLength(1));
    expect(opened, isEmpty);
  });

  testWidgets('a fresh answer with no signed link never falls back to the '
      'stored address', (tester) async {
    backend.answer = (id) => _row(id, unsigned: true);
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
    await tester.tap(chip('a1'));
    await tester.pump();
    await tester.pump();
    expect(find.text(swarmFileGone), findsOneWidget);
    expect(opened, isEmpty);
  });

  testWidgets('a failed ask says try again, and the next tap works', (
    tester,
  ) async {
    backend.answer = (_) => throw StateError('Offline');
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
    await tester.tap(chip('a1'));
    await tester.pump();
    await tester.pump();
    expect(find.text(swarmFileRetry), findsOneWidget);
    expect(opened, isEmpty);

    backend.answer = (id) => _row(
      id,
      link: _signed(id, sig: 'again'),
      expiresAt: _ms + 600000,
    );
    ScaffoldMessenger.of(tester.element(chip('a1'))).clearSnackBars();
    await tester.pumpAndSettle();
    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(backend.reads, hasLength(2));
    expect(opened, [Uri.parse(_signed('a1', sig: 'again'))]);
  });

  testWidgets('an answer after the chat closed opens nothing', (tester) async {
    final answer = Completer<Map<String, dynamic>>();
    backend.answer = (_) => answer.future;
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
    await tester.tap(chip('a1'));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    answer.complete(_row('a1', expiresAt: _ms + 600000));
    await tester.pumpAndSettle();
    expect(opened, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an answer after the Swarm was read again from nothing, or '
      'access ended, opens nothing', (tester) async {
    for (final change in <void Function()>[
      () => reader.generation++,
      () => reader.accessRevoked = true,
    ]) {
      opened.clear();
      reader.accessRevoked = false;
      final answer = Completer<Map<String, dynamic>>();
      backend.answer = (_) => answer.future;
      await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
      await tester.tap(chip('a1'));
      await tester.pump();
      change();
      answer.complete(_row('a1', expiresAt: _ms + 600000));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      expect(find.text(swarmFileGone), findsNothing);
      expect(find.text(swarmFileRetry), findsNothing);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('an answer after another Swarm took the chat opens nothing', (
    tester,
  ) async {
    final answer = Completer<Map<String, dynamic>>();
    backend.answer = (_) => answer.future;
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
    await tester.tap(chip('a1'));
    await tester.pump();
    final other = SwarmReader(
      tabId: 'tab',
      accountId: 'someone-else',
      request: backend.request,
    );
    addTearDown(other.dispose);
    await tester.pumpWidget(chat(other, _row('a1', expiresAt: _ms - 1)));
    answer.complete(_row('a1', expiresAt: _ms + 600000));
    await tester.pumpAndSettle();
    expect(opened, isEmpty);
  });

  testWidgets('a file the server could not sign never opens its stored '
      'address: a fresh link is asked for', (tester) async {
    backend.answer = (id) => _row(id, expiresAt: _ms + 600000);
    await tester.pumpWidget(
      chat(reader, {..._row('a1', unsigned: true), 'unlinked': true}),
    );
    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(backend.reads, hasLength(1));
    expect(opened, [Uri.parse(_signed('a1'))]);
  });

  testWidgets('a signing failure says try again, not gone', (tester) async {
    backend.answer = (_) => throw const SuperTabFailure(
      'FILE_LINK_UNAVAILABLE',
      'Couldn’t open the file just now. Try again.',
      statusCode: 503,
    );
    await tester.pumpWidget(
      chat(reader, {..._row('a1', unsigned: true), 'unlinked': true}),
    );
    await tester.tap(chip('a1'));
    await tester.pump();
    await tester.pump();
    expect(find.text(swarmFileRetry), findsOneWidget);
    expect(find.text(swarmFileGone), findsNothing);
    expect(opened, isEmpty);
  });

  testWidgets('a fresh link that never answers ends as try again', (
    tester,
  ) async {
    final timeout = swarmFileLinkTimeout;
    swarmFileLinkTimeout = const Duration(seconds: 20);
    addTearDown(() => swarmFileLinkTimeout = timeout);
    final never = Completer<Map<String, dynamic>>();
    backend.answer = (_) => never.future;
    await tester.pumpWidget(chat(reader, _row('a1', expiresAt: _ms - 1)));
    await tester.tap(chip('a1'));
    await tester.pump(const Duration(seconds: 21));
    await tester.pump();
    expect(find.text(swarmFileRetry), findsOneWidget);
    expect(opened, isEmpty);
    // The chip takes a tap again.
    backend.answer = (id) => _row(id, expiresAt: _ms + 600000);
    ScaffoldMessenger.of(tester.element(chip('a1'))).clearSnackBars();
    await tester.pumpAndSettle();
    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(opened, [Uri.parse(_signed('a1'))]);
  });

  test('a link or expiry of another type reads as none, not a failed row', () {
    final file = SuperTabAttachment.fromJson({
      ..._row('a1'),
      'link': 42,
      'expiresAt': '1793466886541',
    });
    expect(file.link, isNull);
    expect(file.expiresAt, isNull);
    final signed = SuperTabAttachment.fromJson({
      ..._row('a2'),
      'expiresAt': 'soon',
    });
    // A signed link with no readable end is asked for again, never trusted.
    expect(SwarmFileRef(signed).current, isNull);
  });

  testWidgets('a link off file storage opens nothing and asks nothing', (
    tester,
  ) async {
    backend.answer = (id) => _row(id, expiresAt: _ms + 600000);
    for (final bad in [
      'http://storage.googleapis.com/bucket/a1/f.pdf',
      'https://storage.googleapis.com.evil.example/a1/f.pdf',
      'https://me:pw@storage.googleapis.com/bucket/a1/f.pdf',
    ]) {
      await tester.pumpWidget(
        chat(reader, _row('a1', link: bad, expiresAt: _ms + 600000)),
      );
      await tester.tap(chip('a1'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(opened, isEmpty, reason: bad);
    }
    expect(backend.reads, isEmpty);
  });

  group('a picture', () {
    late Directory root;
    late _Storage storage;
    late SwarmAttachmentStore store;

    setUp(() {
      root = Directory.systemTemp.createTempSync('swarm-file-links-');
      storage = _Storage();
      store = storeIn(root, storage);
    });
    tearDown(() {
      if (root.existsSync()) root.deleteSync(recursive: true);
    });

    final preview = find.byKey(const ValueKey('swarm-attachment-preview-p1'));
    final chipText = find.text('chip');

    Future<void> show(WidgetTester tester, Map<String, dynamic> row) async {
      await tester.runAsync(() => store.keepOnly('me'));
      final file = SuperTabAttachment.fromJson(row);
      final ref = SwarmFileRef(
        file,
        conversationId: 'lead',
        messageId: 'm1',
        reader: reader,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SwarmFiles(
              reader: reader,
              child: SwarmAttachment(
                file: file,
                link: ref.current,
                fileRef: ref,
                chip: const Text('chip'),
                store: store,
              ),
            ),
          ),
        ),
      );
    }

    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 30; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await tester.pump();
      }
    }

    Future<void> closed(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 1));
    }

    testWidgets('whose link ended is fetched by a fresh one', (tester) async {
      backend.answer = (id) => _row(
        id,
        name: 'p.png',
        mime: 'image/png',
        link: _signed(id, sig: 'fresh'),
        expiresAt: _ms + 600000,
      );
      await show(
        tester,
        _row('p1', name: 'p.png', mime: 'image/png', expiresAt: _ms - 1),
      );
      await settle(tester);
      expect(backend.reads, hasLength(1));
      expect(storage.asked.map((a) => a.url), [_signed('p1', sig: 'fresh')]);
      expect(preview, findsOneWidget);
      expect(chipText, findsNothing);
      await closed(tester);
    });

    testWidgets('that fails on its link is asked for once more, then is the '
        'chip', (tester) async {
      storage.failing = true;
      backend.answer = (id) => _row(
        id,
        name: 'p.png',
        mime: 'image/png',
        link: _signed(id, sig: 'two'),
        expiresAt: _ms + 600000,
      );
      await show(
        tester,
        _row('p1', name: 'p.png', mime: 'image/png', expiresAt: _ms + 600000),
      );
      await settle(tester);
      expect(storage.asked.map((a) => a.url), [
        _signed('p1'),
        _signed('p1', sig: 'two'),
      ]);
      expect(backend.reads, hasLength(1));
      expect(chipText, findsOneWidget);
      await closed(tester);
    });

    testWidgets('a signed link is kept by its file, not its address: a new '
        'link to the same picture fetches nothing again', (tester) async {
      await show(
        tester,
        _row('p1', name: 'p.png', mime: 'image/png', expiresAt: _ms + 600000),
      );
      await settle(tester);
      expect(preview, findsOneWidget);
      // The next read hands a new link to the same file.
      await show(
        tester,
        _row(
          'p1',
          name: 'p.png',
          mime: 'image/png',
          link: _signed('p1', sig: 'next'),
          expiresAt: _ms + 900000,
        ),
      );
      await settle(tester);
      expect(storage.asked.map((a) => a.url), [_signed('p1')]);
      expect(preview, findsOneWidget);
      await closed(tester);
    });

    testWidgets('one the server could not sign is fetched by a fresh link', (
      tester,
    ) async {
      backend.answer = (id) =>
          _row(id, name: 'p.png', mime: 'image/png', expiresAt: _ms + 600000);
      await show(tester, {
        ..._row('p1', name: 'p.png', mime: 'image/png', unsigned: true),
        'unlinked': true,
      });
      await settle(tester);
      expect(backend.reads, hasLength(1));
      expect(storage.asked.map((a) => a.url), [_signed('p1')]);
      await closed(tester);
    });
  });
}

/// File storage that refuses every link while [failing], as Cloud Storage
/// answers a signed link that has ended.
class _Storage extends FakeFileStorage {
  bool failing = false;

  @override
  Future<FileServiceResponse> get(String url, {Map<String, String>? headers}) {
    status = failing ? 403 : 200;
    return super.get(url, headers: headers);
  }
}
