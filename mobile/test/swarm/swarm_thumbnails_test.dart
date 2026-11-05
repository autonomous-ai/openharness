import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_attachment.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_file_links.dart';

import '../temp_folder.dart';
import 'picture_loads.dart';
import 'swarm_attachment_fakes.dart';

// Task #3177: a chat draws a picture from the small thumbnail the server made at upload (backend thumbnails.ts) and the full
// screen viewer opens the original; a picture without a thumbnail, or whose thumbnail cannot be fetched, is drawn from the
// original as before.
void main() {
  late Directory root;
  late FakeFileStorage storage;
  late PictureReads reads;
  late SwarmAttachmentStore store;

  final original = Uri.parse('https://cdn.example/swarm/photo.jpg');
  final thumb = Uri.parse('https://cdn.example/swarm/photo.jpg.thumb.webp');

  Map<String, dynamic> row({bool withThumb = true}) => {
    'id': 'file-1',
    'name': 'photo.jpg',
    'mime': 'image/jpeg',
    'size': 4000000,
    'url': original.toString(),
    if (withThumb) ...{
      'width': 4000,
      'height': 3000,
      'thumb': {
        'url': thumb.toString(),
        'width': 720,
        'height': 540,
        'size': 40000,
        'link': thumb.toString(),
        'expiresAt': 1,
      },
    },
  };

  setUp(() {
    root = Directory.systemTemp.createTempSync('swarm-thumbnails-');
    storage = FakeFileStorage();
    reads = PictureReads();
    store = storeIn(root, storage, reads: reads);
  });
  tearDown(() => deleteTempFolder(root));

  final preview = find.byKey(const ValueKey('swarm-attachment-preview-file-1'));
  final viewer = find.byKey(const ValueKey('swarm-attachment-viewer'));

  Future<void> pump(
    WidgetTester tester, {
    bool withThumb = true,
    bool useThumb = true,
  }) async {
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.runAsync(() => store.keepOnly('person-me'));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 320,
            child: SwarmAttachment(
              file: SuperTabAttachment.fromJson(row(withThumb: withThumb)),
              link: original,
              thumb: withThumb && useThumb ? thumb : null,
              chip: const Text('chip', key: ValueKey('chip')),
              store: store,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> until(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 100 && !done(); i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(done(), isTrue);
  }

  bool drawn(WidgetTester tester) => find
      .descendant(of: preview, matching: find.byType(RawImage))
      .evaluate()
      .any((e) => (e.widget as RawImage).image != null);

  Future<List<int>> png(WidgetTester tester) async =>
      (await tester.runAsync(() async {
        final recorder = ui.PictureRecorder();
        Canvas(recorder).drawRect(
          const Rect.fromLTWH(0, 0, 40, 30),
          Paint()..color = const Color(0xFF3060A0),
        );
        final image = await recorder.endRecording().toImage(40, 30);
        return (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer
            .asUint8List();
      }))!;

  Future<void> closed(WidgetTester tester) async {
    await picturesLoaded(tester);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  }

  List<String> asked() => [for (final a in storage.asked) a.url];

  group('the facts a message carries', () {
    test('a thumbnail and the picture\'s size are read', () {
      final file = SuperTabAttachment.fromJson(row());
      expect((file.width, file.height), (4000, 3000));
      expect(file.thumb?.url, thumb.toString());
      expect(
        (file.thumb?.width, file.thumb?.height, file.thumb?.size),
        (720, 540, 40000),
      );
      expect(file.thumb?.expiresAt, 1);
    });

    test('a file from an older server has none', () {
      final file = SuperTabAttachment.fromJson(row(withThumb: false));
      expect(file.thumb, isNull);
      expect(file.width, isNull);
    });

    test('a field of the wrong type reads as absent, never a failed row', () {
      final file = SuperTabAttachment.fromJson({
        ...row(),
        'thumb': {'url': 5, 'width': 'wide'},
        'width': 'x',
      });
      expect(file.thumb, isNull);
      expect(file.width, isNull);
      expect(file.id, 'file-1');
    });
  });

  group('the file ref', () {
    final t = DateTime.utc(2026, 11, 5, 9);
    setUp(() => swarmFileClock = () => t);
    tearDown(() => swarmFileClock = DateTime.now);

    SwarmFileRef ref(Map<String, dynamic> thumbRow, {bool unlinked = false}) =>
        SwarmFileRef(
          SuperTabAttachment.fromJson({
            ...row(),
            'link': 'https://storage.googleapis.com/b/p.jpg?s=1',
            'expiresAt': t.millisecondsSinceEpoch + 600000,
            if (unlinked) 'unlinked': true,
            'thumb': {
              'url': thumb.toString(),
              'width': 720,
              'height': 540,
              'size': 4,
              ...thumbRow,
            },
          }),
        );

    test('hands the thumbnail\'s signed link while it opens for more than a minute', () {
      final link = ref({
        'link': 'https://storage.googleapis.com/b/p.jpg.thumb.webp?s=1',
        'expiresAt': t.millisecondsSinceEpoch + 600000,
      }).currentThumb;
      expect(link?.path, '/b/p.jpg.thumb.webp');
    });

    test('hands none for one about to end, unsigned, unlinked or off the files host', () {
      expect(
        ref({
          'link': 'https://storage.googleapis.com/b/t.webp?s=1',
          'expiresAt': t.millisecondsSinceEpoch + 10000,
        }).currentThumb,
        isNull,
      );
      expect(ref({}).currentThumb, isNull);
      expect(ref({'unlinked': true}).currentThumb, isNull);
      expect(
        ref({
          'link': 'https://evil.example/t.webp',
          'expiresAt': t.millisecondsSinceEpoch + 600000,
        }).currentThumb,
        isNull,
      );
      expect(
        ref({
          'link': 'https://storage.googleapis.com/b/t.webp?s=1',
          'expiresAt': t.millisecondsSinceEpoch + 600000,
        }, unlinked: true).currentThumb,
        isNull,
      );
    });
  });

  group('the chat', () {
    testWidgets('draws the thumbnail and fetches only that', (tester) async {
      storage.bytes = await png(tester);
      await pump(tester);
      await until(tester, () => drawn(tester));

      expect(asked(), [thumb.toString()]);
      await closed(tester);
    });

    testWidgets(
      'fetches the original when the picture is opened, and shows that',
      (tester) async {
        storage.bytes = await png(tester);
        await pump(tester);
        await until(tester, () => drawn(tester));

        await tester.tap(preview);
        await until(tester, () => viewer.evaluate().isNotEmpty);

        // Kept apart: the thumbnail's cache entry is not the original's.
        expect(asked(), [thumb.toString(), original.toString()]);
        await picturesLoaded(tester);
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(minutes: 1));
      },
    );

    testWidgets('draws the original when the file has no thumbnail', (
      tester,
    ) async {
      storage.bytes = await png(tester);
      await pump(tester, withThumb: false);
      await until(tester, () => drawn(tester));

      expect(asked(), [original.toString()]);
      await closed(tester);
    });

    testWidgets('draws the original when no thumbnail link is at hand', (
      tester,
    ) async {
      storage.bytes = await png(tester);
      await pump(tester, useThumb: false);
      await until(tester, () => drawn(tester));

      expect(asked(), [original.toString()]);
      await closed(tester);
    });

    testWidgets(
      'falls back to the original when the thumbnail cannot be fetched',
      (tester) async {
        storage.bytes = await png(tester);
        storage.statusFor[thumb.toString()] = 404;
        await pump(tester);
        await until(tester, () => drawn(tester));

        expect(asked(), [thumb.toString(), original.toString()]);
        expect(find.byKey(const ValueKey('chip')), findsNothing);
        await closed(tester);
      },
    );
  });
}
