// Chat files open through short-lived signed links (backend fileLinks.ts):
// a link about to end is asked for again before anything opens, a reader who
// lost access is told so and opens nothing, a failed ask can be tried again,
// and an answer that lands after its screen or Swarm went changes nothing.
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/file_links.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

final _now = DateTime.utc(2026, 10, 31, 18);
final _ms = _now.millisecondsSinceEpoch;

String _signed(String id, String name, {String sig = '1'}) =>
    'https://storage.googleapis.com/bucket/super-tabs/tab/$id/$name'
    '?X-Goog-Signature=$sig';

/// A file as a read hands it: [url] its stored CDN address, [link] its
/// signed link (none when [unsigned]).
Map<String, dynamic> _file(
  String id,
  String name, {
  String mime = 'application/pdf',
  String? url,
  String? link,
  bool unsigned = false,
  int? expiresAt,
  int size = 1024,
}) => {
  'id': id,
  'name': name,
  'mime': mime,
  'size': size,
  'url': url ?? _cdn(id, name),
  if (!unsigned) 'link': link ?? _signed(id, name),
  'expiresAt': ?expiresAt,
};

String _cdn(String id, String name) =>
    'https://cdn.harness.autonomous.ai/super-tabs/tab/$id/$name';

Future<Uint8List> _png(WidgetTester tester) async =>
    (await tester.runAsync(() async {
      final recorder = ui.PictureRecorder();
      Canvas(recorder).drawRect(
        const Rect.fromLTWH(0, 0, 40, 30),
        Paint()..color = const Color(0xFF3060A0),
      );
      final image = await recorder.endRecording().toImage(40, 30);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      return data!.buffer.asUint8List();
    }))!;

void main() {
  late List<Uri> opened;
  late List<Uri> drawn;
  late Map<String, Uint8List> pictures;
  late Future<bool> Function(Uri) browser;
  late ImageProvider Function(Uri) image;

  setUp(() {
    opened = [];
    drawn = [];
    pictures = {};
    browser = browserOpener;
    image = attachmentImage;
    superTabFileClock = () => _now;
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    attachmentImage = (url) {
      drawn.add(url);
      return MemoryImage(pictures[url.toString()] ?? Uint8List(3));
    };
  });
  tearDown(() {
    browserOpener = browser;
    attachmentImage = image;
    superTabFileClock = DateTime.now;
  });

  Widget view(SuperTabController controller) => MaterialApp(
    home: Scaffold(
      body: SuperTabView(
        controller: controller,
        onInvite: () {},
        onAddAgent: (_) {},
        onOpenTerminal: (_) {},
        machineName: (_) => 'Test Mac',
      ),
    ),
  );

  Future<(ConversationServer, SuperTabController)> show(
    WidgetTester tester,
    List<Map<String, dynamic>> files, {
    FutureOr<Map<String, dynamic>> Function(String id)? fileLink,
  }) async {
    final server = ConversationServer()
      ..append('Here', attachments: files)
      ..fileLink = fileLink;
    final controller = server.controller();
    await controller.refresh();
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(view(controller));
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(Durations.short2));
    await tester.pumpAndSettle();
    return (server, controller);
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  Finder chip(String id) => find.byKey(ValueKey('super-attachment:$id'));

  group('a chip', () {
    testWidgets('opens a link with more than a minute left as it is', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms + 5 * 60000),
      ]);

      await tester.tap(chip('a1'));
      await tester.pumpAndSettle();
      expect(opened, [Uri.parse(_signed('a1', 'report.pdf'))]);
      expect(server.fileLinkReads, isEmpty);
      await close(tester, c);
    });

    testWidgets('asks for a fresh link when its own is about to end', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms + 30000),
      ]);
      server.fileLink = (id) => _file(
        id,
        'report.pdf',
        link: _signed(id, 'report.pdf', sig: 'fresh'),
        expiresAt: _ms + 10 * 60000,
      );

      await tester.tap(chip('a1'));
      await tester.pumpAndSettle();
      expect(server.fileLinkReads, [
        '/api/super-tabs/tab/conversations/lead/messages/message-1/attachments/a1',
      ]);
      expect(opened, [Uri.parse(_signed('a1', 'report.pdf', sig: 'fresh'))]);
      await close(tester, c);
    });

    testWidgets('with no signed link, the stored address opens as before', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', unsigned: true),
      ]);

      await tester.tap(chip('a1'));
      await tester.pumpAndSettle();
      expect(opened, [Uri.parse(_cdn('a1', 'report.pdf'))]);
      expect(server.fileLinkReads, isEmpty);
      await close(tester, c);
    });

    testWidgets('a signed link that ended never falls back to the stored one', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms - 1000),
      ]);
      // The fresh answer carries no signed link: not available.
      server.fileLink = (id) => _file(id, 'report.pdf', unsigned: true);

      await tester.tap(chip('a1'));
      await tester.pump();
      await tester.pump();
      expect(server.fileLinkReads, hasLength(1));
      expect(find.text(kSuperTabFileGone), findsOneWidget);
      expect(opened, isEmpty);
      await close(tester, c);
    });

    testWidgets('a file with no address at all is asked for when clicked', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', url: '', unsigned: true),
      ]);
      server.fileLink = (id) =>
          _file(id, 'report.pdf', expiresAt: _ms + 10 * 60000);

      await tester.tap(chip('a1'));
      await tester.pumpAndSettle();
      expect(server.fileLinkReads, hasLength(1));
      expect(opened, [Uri.parse(_signed('a1', 'report.pdf'))]);
      await close(tester, c);
    });

    testWidgets(
      'access lost: says the file is no longer there, opens nothing',
      (tester) async {
        final (server, c) = await show(tester, [
          _file('a1', 'report.pdf', expiresAt: _ms - 1000),
        ]);
        // Unset: the server answers 404, as for a removed member.

        await tester.tap(chip('a1'));
        await tester.pump();
        await tester.pump();
        expect(find.text(kSuperTabFileGone), findsOneWidget);
        expect(server.fileLinkReads, hasLength(1));
        expect(opened, isEmpty);
        await close(tester, c);
      },
    );

    testWidgets('a fresh link that is not on file storage opens nothing', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms - 1000),
      ]);
      server.fileLink = (id) => _file(
        id,
        'report.pdf',
        link: 'https://evil.example/a1/report.pdf',
        expiresAt: _ms + 600000,
      );

      await tester.tap(chip('a1'));
      await tester.pump();
      await tester.pump();
      expect(find.text(kSuperTabFileGone), findsOneWidget);
      expect(opened, isEmpty);
      await close(tester, c);
    });

    testWidgets('a failed ask says try again, and the next click works', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms - 1000),
      ]);
      server.fileLink = (_) => throw StateError('Offline');

      await tester.tap(chip('a1'));
      await tester.pump();
      await tester.pump();
      expect(find.text(kSuperTabFileRetry), findsOneWidget);
      expect(opened, isEmpty);

      server.fileLink = (id) => _file(
        id,
        'report.pdf',
        link: _signed(id, 'report.pdf', sig: 'again'),
        expiresAt: _ms + 600000,
      );
      ScaffoldMessenger.of(tester.element(chip('a1'))).clearSnackBars();
      await tester.pumpAndSettle();
      await tester.tap(chip('a1'));
      await tester.pumpAndSettle();
      expect(server.fileLinkReads, hasLength(2));
      expect(opened, [Uri.parse(_signed('a1', 'report.pdf', sig: 'again'))]);
      await close(tester, c);
    });

    testWidgets('an answer after the chat closed opens nothing', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms - 1000),
      ]);
      final answer = Completer<Map<String, dynamic>>();
      server.fileLink = (_) => answer.future;

      await tester.tap(chip('a1'));
      await tester.pump();
      expect(server.fileLinkReads, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      answer.complete(_file('a1', 'report.pdf', expiresAt: _ms + 600000));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      expect(tester.takeException(), isNull);
      await c.flush();
      c.dispose();
    });

    testWidgets('an answer after the Swarm changed under it opens nothing', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('a1', 'report.pdf', expiresAt: _ms - 1000),
      ]);
      final answer = Completer<Map<String, dynamic>>();
      server.fileLink = (_) => answer.future;

      await tester.tap(chip('a1'));
      await tester.pump();
      // Another account's controller over the same chat: the same chip, a new
      // fresh-link source.
      final other = server.controller(account: 'other');
      await other.refresh();
      await tester.pumpWidget(view(other));
      await tester.pump();
      expect(chip('a1'), findsOneWidget);
      answer.complete(_file('a1', 'report.pdf', expiresAt: _ms + 600000));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      expect(find.text(kSuperTabFileGone), findsNothing);
      expect(find.text(kSuperTabFileRetry), findsNothing);
      await close(tester, other);
      await c.flush();
      c.dispose();
    });

    testWidgets('a link off file storage is refused without asking', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file(
          'a1',
          'one.pdf',
          link: 'http://storage.googleapis.com/bucket/a1/one.pdf',
        ),
        _file(
          'a2',
          'two.pdf',
          link: 'https://storage.googleapis.com.evil.example/a2/two.pdf',
        ),
        _file(
          'a3',
          'three.pdf',
          link: 'https://me:pw@storage.googleapis.com/bucket/a3/three.pdf',
        ),
      ]);
      server.fileLink = (id) => _file(id, 'x.pdf', expiresAt: _ms + 600000);

      for (final id in ['a1', 'a2', 'a3']) {
        await tester.tap(chip(id));
        await tester.pump();
        expect(
          find.text(
            'This file isn’t on Harness’s file storage, so it wasn’t opened.',
          ),
          findsOneWidget,
          reason: id,
        );
        ScaffoldMessenger.of(tester.element(chip(id))).clearSnackBars();
        await tester.pumpAndSettle();
      }
      expect(opened, isEmpty);
      expect(server.fileLinkReads, isEmpty);
      await close(tester, c);
    });
  });

  group('a picture', () {
    final inline = find.byKey(const ValueKey('super-attachment-inline:p1'));

    testWidgets('whose link ended is drawn from a fresh one', (tester) async {
      final fresh = _signed('p1', 'shot.png', sig: 'fresh');
      pictures[fresh] = await _png(tester);
      final server = ConversationServer()
        ..append(
          'Here',
          attachments: [
            _file('p1', 'shot.png', mime: 'image/png', expiresAt: _ms - 1),
          ],
        );
      server.fileLink = (id) => _file(
        id,
        'shot.png',
        mime: 'image/png',
        link: fresh,
        expiresAt: _ms + 600000,
      );
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(view(c));
      await tester.pumpAndSettle();
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();

      expect(server.fileLinkReads, hasLength(1));
      expect(drawn.toSet(), {Uri.parse(fresh)});
      expect(inline, findsOneWidget);
      expect(find.text('shot.png can’t be shown here.'), findsNothing);
      await close(tester, c);
    });

    testWidgets('that fails to load is asked for once more, then given up', (
      tester,
    ) async {
      final first = _signed('p1', 'shot.png');
      final second = _signed('p1', 'shot.png', sig: 'two');
      final (server, c) = await show(
        tester,
        [_file('p1', 'shot.png', mime: 'image/png', expiresAt: _ms + 600000)],
        fileLink: (id) => _file(
          id,
          'shot.png',
          mime: 'image/png',
          link: second,
          expiresAt: _ms + 600000,
        ),
      );
      // Neither link draws: the first ended under it, the second is broken.
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(() => Future<void>.delayed(Durations.short2));
        await tester.pumpAndSettle();
      }

      expect(drawn.toSet(), {Uri.parse(first), Uri.parse(second)});
      expect(server.fileLinkReads, hasLength(1));
      expect(find.text('shot.png can’t be shown here.'), findsOneWidget);
      await close(tester, c);
    });

    testWidgets('whose fresh link is refused says it can\'t be shown', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        _file('p1', 'shot.png', mime: 'image/png', expiresAt: _ms - 1),
      ]);

      expect(server.fileLinkReads, hasLength(1));
      expect(drawn, isEmpty);
      expect(find.text('shot.png can’t be shown here.'), findsOneWidget);
      await close(tester, c);
    });

    testWidgets('full screen, Open in browser asks again once the link ends', (
      tester,
    ) async {
      final first = _signed('p1', 'shot.png');
      pictures[first] = await _png(tester);
      final (server, c) = await show(tester, [
        _file('p1', 'shot.png', mime: 'image/png', expiresAt: _ms + 120000),
      ]);
      server.fileLink = (id) => _file(
        id,
        'shot.png',
        mime: 'image/png',
        link: _signed(id, 'shot.png', sig: 'later'),
        expiresAt: _ms + 900000,
      );

      await tester.tap(inline);
      await tester.pumpAndSettle();
      // The viewer stayed open past the link's last minute.
      superTabFileClock = () => _now.add(const Duration(minutes: 2));
      await tester.tap(find.text('Open in browser'));
      await tester.pumpAndSettle();
      expect(server.fileLinkReads, hasLength(1));
      expect(opened, [Uri.parse(_signed('p1', 'shot.png', sig: 'later'))]);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await close(tester, c);
    });

    testWidgets('an answer after the Swarm changed under it still lets the '
        'new one load', (tester) async {
      final fresh = _signed('p1', 'shot.png', sig: 'fresh');
      pictures[fresh] = await _png(tester);
      final answer = Completer<Map<String, dynamic>>();
      final (server, c) = await show(tester, [
        _file('p1', 'shot.png', mime: 'image/png', expiresAt: _ms - 1),
      ], fileLink: (_) => answer.future);
      expect(server.fileLinkReads, hasLength(1));
      // Another account's controller over the same chat: the same picture,
      // a new fresh-link source, asked for while the first ask still runs.
      final other = server.controller(account: 'other');
      await other.refresh();
      await tester.pumpWidget(view(other));
      await tester.pump();
      answer.complete(
        _file(
          'p1',
          'shot.png',
          mime: 'image/png',
          link: fresh,
          expiresAt: _ms + 600000,
        ),
      );
      for (var i = 0; i < 4; i++) {
        await tester.runAsync(() => Future<void>.delayed(Durations.short2));
        await tester.pumpAndSettle();
      }
      expect(server.fileLinkReads, hasLength(2));
      expect(drawn.toSet(), {Uri.parse(fresh)});
      expect(inline, findsOneWidget);
      await close(tester, other);
      await c.flush();
      c.dispose();
    });
  });

  group('a file the server could not sign', () {
    testWidgets('never opens its stored address: a fresh link is asked for', (
      tester,
    ) async {
      final (server, c) = await show(tester, [
        {..._file('a1', 'report.pdf', unsigned: true), 'unlinked': true},
      ], fileLink: (id) => _file(id, 'report.pdf', expiresAt: _ms + 600000));

      await tester.tap(chip('a1'));
      await tester.pumpAndSettle();
      expect(server.fileLinkReads, hasLength(1));
      expect(opened, [Uri.parse(_signed('a1', 'report.pdf'))]);
      await close(tester, c);
    });

    testWidgets('a signing failure says try again, not gone', (tester) async {
      final (server, c) = await show(
        tester,
        [
          {..._file('a1', 'report.pdf', unsigned: true), 'unlinked': true},
        ],
        fileLink: (_) => throw const SuperTabFailure(
          'FILE_LINK_UNAVAILABLE',
          'Couldn’t open the file just now. Try again.',
          statusCode: 503,
        ),
      );

      await tester.tap(chip('a1'));
      await tester.pump();
      await tester.pump();
      expect(find.text(kSuperTabFileRetry), findsOneWidget);
      expect(find.text(kSuperTabFileGone), findsNothing);
      expect(server.fileLinkReads, hasLength(1));
      expect(opened, isEmpty);
      await close(tester, c);
    });
  });

  test('a link or expiry of another type reads as none, not a failed row', () {
    final file = SuperTabAttachment.fromJson({
      ..._file('a1', 'report.pdf'),
      'link': 42,
      'expiresAt': '1793466886541',
    });
    expect(file.link, isNull);
    expect(file.expiresAt, isNull);
    final signed = SuperTabAttachment.fromJson({
      ..._file('a2', 'report.pdf'),
      'expiresAt': 'soon',
    });
    // A signed link with no readable end is asked for again, never trusted.
    expect(signed.expiresAt, isNull);
    expect(SuperTabFileRef(signed).current, isNull);
  });

  testWidgets('a text file\'s viewer asks for a fresh link once its own ends', (
    tester,
  ) async {
    final fetched = <Uri>[];
    final fetcher = attachmentFetcher;
    attachmentFetcher = (url, {maxBytes}) async {
      fetched.add(url);
      return Uint8List.fromList('# Notes'.codeUnits);
    };
    addTearDown(() => attachmentFetcher = fetcher);
    final (server, c) = await show(
      tester,
      [
        _file(
          'a1',
          'notes.md',
          mime: 'text/markdown',
          size: 7,
          expiresAt: _ms + 120000,
        ),
      ],
      fileLink: (id) => _file(
        id,
        'notes.md',
        mime: 'text/markdown',
        link: _signed(id, 'notes.md', sig: 'later'),
        expiresAt: _ms + 900000,
      ),
    );

    await tester.tap(chip('a1'));
    await tester.pumpAndSettle();
    expect(fetched, [Uri.parse(_signed('a1', 'notes.md'))]);
    expect(server.fileLinkReads, isEmpty);
    // The viewer stayed open past the link's last minute.
    superTabFileClock = () => _now.add(const Duration(minutes: 2));
    await tester.tap(find.text('Open in browser'));
    await tester.pumpAndSettle();
    expect(server.fileLinkReads, hasLength(1));
    expect(opened, [Uri.parse(_signed('a1', 'notes.md', sig: 'later'))]);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    await close(tester, c);
  });
}
