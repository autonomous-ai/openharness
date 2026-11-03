import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_file_download.dart';
import 'package:harness_mobile/swarm/swarm_file_kind.dart';
import 'package:harness_mobile/swarm/swarm_file_links.dart';
import 'package:harness_mobile/swarm/swarm_file_viewer.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'swarm_attachment_fakes.dart';

/// A chat's text and Markdown files open in the app, as on the desktop: the
/// chip wears the file's kind, a tap reads the file into a viewer (Markdown
/// rendered, its source a tap away), Download hands it to the share sheet
/// under its own name, and a file that cannot be shown offers the browser.
/// Every other file still opens in the browser.
void main() {
  late Directory root;
  late FakeFileStorage storage;
  late SwarmAttachmentStore store;
  late List<Uri> opened;
  late List<({String name, String text})> shared;
  late Future<bool> Function(Uri) openFile;
  late Future<void> Function(ShareParams) shareSheet;

  final link = Uri.parse('https://cdn.example/swarm/notes.txt');

  SuperTabAttachment attachment(String name, {int size = 2048}) =>
      SuperTabAttachment.fromJson({
        'id': 'file-1',
        'name': name,
        'mime': 'text/plain',
        'size': size,
        'url': link.toString(),
      });

  setUp(() {
    root = Directory.systemTemp.createTempSync('swarm-file-viewer-');
    storage = FakeFileStorage()..bytes = utf8.encode('line one\nline two\n');
    store = storeIn(root, storage);
    opened = [];
    shared = [];
    openFile = swarmOpenFile;
    swarmOpenFile = (url) async {
      opened.add(url);
      return true;
    };
    shareSheet = swarmShareSheet;
    swarmShareSheet = (params) async {
      // Read as the sheet would, while it is up.
      final copy = File(params.files!.single.path);
      shared.add((
        name: copy.uri.pathSegments.last,
        text: copy.readAsStringSync(),
      ));
    };
  });
  tearDown(() {
    swarmOpenFile = openFile;
    swarmShareSheet = shareSheet;
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  Finder key(String value) => find.byKey(ValueKey(value));
  final chip = key('swarm-file-chip-file-1');
  final viewer = key('swarm-file-viewer');
  final download = key('swarm-file-download');

  Future<void> pump(WidgetTester tester, SuperTabAttachment file) async {
    // Real folders: outside the test's fake clock.
    await tester.runAsync(() => store.keepOnly('person-me'));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SwarmFileChip(file: file, link: link, store: store),
          ),
        ),
      ),
    );
  }

  /// Real time for the file to be fetched and read, a frame after each step,
  /// until [done] holds.
  Future<void> until(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 100 && !done(); i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(done(), isTrue);
  }

  /// The file open in the viewer and read.
  Future<void> open(WidgetTester tester, SuperTabAttachment file) async {
    await pump(tester, file);
    await tester.tap(chip);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await until(
      tester,
      () => find
          .descendant(of: viewer, matching: find.byType(SelectionArea))
          .evaluate()
          .isNotEmpty,
    );
  }

  /// Ends a test that fetched: the screen closed, and the cache's own
  /// cleanup, which it runs every few seconds, let run.
  Future<void> closed(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  }

  VoidCallback? downloadTap(WidgetTester tester) =>
      tester.widget<SwarmIconButton>(download).onPressed;

  testWidgets('the chip wears its kind, as the desktop marks it', (
    tester,
  ) async {
    for (final (name, mark) in [
      ('notes.txt', LucideIcons.fileType),
      ('plan.pdf', LucideIcons.fileText),
      ('main.dart', LucideIcons.fileCode),
      ('thing.xyz', LucideIcons.file),
    ]) {
      await pump(tester, attachment(name));
      final icon = tester.widget<Icon>(
        find.descendant(of: chip, matching: find.byType(Icon)),
      );
      expect(icon.icon, mark, reason: name);
    }
  });

  testWidgets('a text file opens in the app, as it is written', (tester) async {
    storage.bytes = utf8.encode('line one\r\n\tline two\n');
    await open(tester, attachment('notes.txt'));

    expect(viewer, findsOneWidget);
    expect(find.text('notes.txt'), findsWidgets, reason: 'its name on top');
    expect(find.text('line one'), findsOneWidget);
    expect(find.text('    line two'), findsOneWidget);
    expect(key('swarm-file-source'), findsNothing, reason: 'not Markdown');
    expect(storage.asked.single.url, link.toString());
    expect(opened, isEmpty, reason: 'not the browser');

    await tester.tap(key('swarm-file-close'));
    await tester.pumpAndSettle();
    expect(viewer, findsNothing);
    expect(chip, findsOneWidget);
    await closed(tester);
  });

  testWidgets('a Markdown file is rendered, and Show source shows it as '
      'written', (tester) async {
    storage.bytes = utf8.encode('# Plan\n\nShip **today**.\n');
    await open(tester, attachment('plan.md'));

    expect(key('swarm-file-markdown'), findsOneWidget);
    expect(find.text('Plan'), findsOneWidget);
    expect(find.text('# Plan'), findsNothing);

    await tester.tap(key('swarm-file-source'));
    await tester.pump();
    expect(key('swarm-file-text'), findsOneWidget);
    expect(find.text('# Plan'), findsOneWidget);
    expect(find.text('Ship **today**.'), findsOneWidget);
    expect(
      tester.widget<SwarmIconButton>(key('swarm-file-source')).label,
      'Show preview',
    );

    await tester.tap(key('swarm-file-source'));
    await tester.pump();
    expect(key('swarm-file-markdown'), findsOneWidget);
    await closed(tester);
  });

  testWidgets('every other file opens in the browser, as before', (
    tester,
  ) async {
    await pump(tester, attachment('plan.pdf'));
    await tester.tap(chip);
    await tester.pumpAndSettle();

    expect(opened, [link]);
    expect(viewer, findsNothing);
    expect(storage.asked, isEmpty);
  });

  testWidgets('a text file over 2 MB by its message opens in the browser', (
    tester,
  ) async {
    await pump(tester, attachment('big.log', size: swarmTextMaxBytes + 1));
    await tester.tap(chip);
    await tester.pumpAndSettle();

    expect(opened, [link]);
    expect(viewer, findsNothing);
    expect(storage.asked, isEmpty);
  });

  testWidgets('a file larger than its message said opens in the browser '
      'instead', (tester) async {
    storage.bytes = List.filled(swarmTextMaxBytes + 1, 0x61);
    await pump(tester, attachment('notes.txt'));
    await tester.tap(chip);
    await tester.pump();

    await until(tester, () => opened.isNotEmpty);
    await tester.pumpAndSettle();
    expect(opened, [link]);
    expect(viewer, findsNothing);
    await closed(tester);
  });

  testWidgets('a file that cannot be fetched says so, with Open in browser', (
    tester,
  ) async {
    storage.status = 404;
    await pump(tester, attachment('notes.txt'));
    await tester.tap(chip);
    await tester.pump();

    await until(
      tester,
      () => find.text('Can’t open this file').evaluate().isNotEmpty,
    );
    expect(
      find.text('It couldn’t be downloaded. Try again in the browser.'),
      findsOneWidget,
    );
    expect(downloadTap(tester), isNull, reason: 'nothing to download');

    await tester.pumpAndSettle();
    await tester.tap(key('swarm-file-browser'));
    await tester.pump();
    expect(opened, [link]);
    await closed(tester);
  });

  testWidgets('a file that is not text after all has no preview', (
    tester,
  ) async {
    storage.bytes = [0x50, 0x4b, 0x03, 0x04, 0, 0, 0];
    await pump(tester, attachment('notes.txt'));
    await tester.tap(chip);
    await tester.pump();

    await until(tester, () => find.text('No preview').evaluate().isNotEmpty);
    expect(
      find.text('This file isn’t text that can be shown here.'),
      findsOneWidget,
    );
    expect(downloadTap(tester), isNotNull, reason: 'it can still be saved');
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-file-browser'));
    await tester.pump();
    expect(opened, [link]);
    await closed(tester);
  });

  testWidgets('Download is off while the file is on its way', (tester) async {
    storage.hold = Completer();
    await pump(tester, attachment('notes.txt'));
    await tester.tap(chip);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(key('swarm-file-loading'), findsOneWidget);
    expect(downloadTap(tester), isNull);

    storage.hold!.complete();
    await until(tester, () => downloadTap(tester) != null);
    expect(find.text('line two'), findsOneWidget);
    await closed(tester);
  });

  testWidgets('Download hands the file to the share sheet under its own '
      'name, then lets the copy go', (tester) async {
    await open(tester, attachment('Release notes.md'));

    await tester.tap(download);
    await until(tester, () => shared.isNotEmpty);

    expect(shared.single.name, 'Release notes.md');
    expect(shared.single.text, 'line one\nline two\n');
    await until(tester, () => downloadTap(tester) != null);
    expect(
      keptUnder(root).where((path) => path.contains('shared')),
      isEmpty,
      reason: 'the copy went',
    );
    await closed(tester);
  });

  testWidgets('a Download that fails says so', (tester) async {
    swarmShareSheet = (_) async => throw StateError('No sheet');
    await open(tester, attachment('notes.txt'));

    await tester.tap(download);
    await until(
      tester,
      () => find.text(swarmFileNotSaved).evaluate().isNotEmpty,
    );
    expect(viewer, findsOneWidget);
    await closed(tester);
  });

  testWidgets('another account closes it at once, its text let go', (
    tester,
  ) async {
    await open(tester, attachment('notes.txt'));

    var changed = false;
    unawaited(store.keepOnly('person-b').whenComplete(() => changed = true));
    await tester.pump();

    expect(find.text('line one'), findsNothing, reason: 'blank at once');
    expect(
      find.descendant(of: viewer, matching: find.text('notes.txt')),
      findsNothing,
    );
    await tester.pumpAndSettle();
    expect(viewer, findsNothing);

    await until(tester, () => changed);
    await closed(tester);
  });

  group('with a signed link', () {
    final now = DateTime.utc(2026, 11, 3, 9);
    final ms = now.millisecondsSinceEpoch;
    String signed(String sig) =>
        'https://storage.googleapis.com/bucket/super-tabs/tab/f1/notes.txt'
        '?X-Goog-Signature=$sig';

    setUp(() => swarmFileClock = () => now);
    tearDown(() => swarmFileClock = DateTime.now);

    testWidgets('one about to end is asked for again before the file is '
        'fetched', (tester) async {
      final reads = <String>[];
      final reader = SwarmReader(
        tabId: 'tab',
        accountId: 'me',
        request: (method, path, {body}) async {
          reads.add(path);
          return {
            'attachment': {
              'id': 'file-1',
              'name': 'notes.txt',
              'mime': 'text/plain',
              'size': 2048,
              'url': '',
              'link': signed('fresh'),
              'expiresAt': ms + 600000,
            },
          };
        },
      );
      addTearDown(reader.dispose);
      final file = SuperTabAttachment.fromJson({
        'id': 'file-1',
        'name': 'notes.txt',
        'mime': 'text/plain',
        'size': 2048,
        'url': '',
        'link': signed('old'),
        'expiresAt': ms + 30000,
      });
      final ref = SwarmFileRef(
        file,
        conversationId: 'lead',
        messageId: 'm1',
        reader: reader,
      );
      await tester.runAsync(() => store.keepOnly('person-me'));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SwarmFiles(
              reader: reader,
              child: SwarmFileChip(
                file: file,
                link: ref.current,
                fileRef: ref,
                store: store,
              ),
            ),
          ),
        ),
      );

      await tester.tap(chip);
      await until(tester, () => find.text('line two').evaluate().isNotEmpty);

      expect(reads, [
        '/api/super-tabs/tab/conversations/lead/messages/m1/attachments/file-1',
      ]);
      expect(storage.asked.map((a) => a.url), [signed('fresh')]);
      expect(opened, isEmpty);
      await closed(tester);
    });
  });

  group('lines as drawn', () {
    test('a file\'s own lines, CRLF or LF, a tab as four spaces', () {
      expect(swarmTextLines('a\r\n\tb\nc'), ['a', '    b', 'c']);
      expect(swarmTextLines(''), ['']);
      expect(swarmTextLines('end\n'), ['end', '']);
    });

    test('a very long line is cut into pieces, the text kept whole', () {
      final line = 'x' * 4500;
      final pieces = swarmTextLines(line);
      expect(pieces.map((p) => p.length), [2000, 2000, 500]);
      expect(pieces.join(), line);
    });

    test('a cut never splits a character in two', () {
      final line = '${'x' * 1999}😀${'y' * 10}';
      final pieces = swarmTextLines(line);
      expect(pieces.first, 'x' * 1999);
      expect(pieces.join(), line);
      expect(pieces[1], startsWith('😀'));
    });
  });
}
