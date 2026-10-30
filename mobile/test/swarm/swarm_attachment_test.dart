import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_attachment.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';

import 'swarm_attachment_fakes.dart';

/// A picture in a chat shows in place, as Slack shows one (Dee, 10-29): a
/// skeleton in a 4:3 box while it loads, then the picture at its own shape, up
/// to 360 points each way and never wider than its message, decoded at the
/// size it shows; a tap opens it full screen. Every other file, and a picture
/// that cannot be shown, keeps the chip.
void main() {
  late Directory root;
  late FakeFileStorage storage;
  late SwarmAttachmentStore store;

  final link = Uri.parse('https://cdn.example/swarm/a.png');

  SuperTabAttachment attachment({String mime = 'image/png'}) =>
      SuperTabAttachment.fromJson({
        'id': 'file-1',
        'name': 'screen.png',
        'mime': mime,
        'size': 2048,
        'url': link.toString(),
      });

  setUp(() {
    root = Directory.systemTemp.createTempSync('swarm-attachments-');
    storage = FakeFileStorage();
    store = storeIn(root, storage);
  });
  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  Finder key(String value) => find.byKey(ValueKey(value));
  final chip = key('chip');
  final preview = key('swarm-attachment-preview-file-1');

  /// [file] in a message [width] wide, on a phone at 2x.
  Future<void> pump(
    WidgetTester tester, {
    SuperTabAttachment? file,
    Uri? linked,
    bool noLink = false,
    double width = 320,
    String? signedIn = 'person-me',
  }) async {
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    // Real files: outside the test's fake clock.
    await tester.runAsync(() => store.keepOnly(signedIn));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SwarmAttachment(
                    file: file ?? attachment(),
                    link: noLink ? null : linked ?? link,
                    chip: const Text('chip', key: ValueKey('chip')),
                    store: store,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Real time for the file to be written and the picture decoded, a frame
  /// after each step, until [done] holds.
  Future<void> until(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 100 && !done(); i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(done(), isTrue);
  }

  /// Ends a test that fetched: the chat closed, and the cache's own cleanup,
  /// which it runs every few seconds, let run.
  Future<void> closed(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 1));
  }

  /// A real [width]×[height] PNG for the storage to serve.
  Future<List<int>> png(WidgetTester tester, int width, int height) async =>
      (await tester.runAsync(() async {
        final recorder = ui.PictureRecorder();
        Canvas(recorder).drawRect(
          Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
          Paint()..color = const Color(0xFF3060A0),
        );
        final image = await recorder.endRecording().toImage(width, height);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        return data!.buffer.asUint8List();
      }))!;

  bool drawn(WidgetTester tester) => find
      .descendant(of: preview, matching: find.byType(RawImage))
      .evaluate()
      .any((e) => (e.widget as RawImage).image != null);

  testWidgets('a picture shows a skeleton in a 4:3 box while it loads, then '
      'the picture at its own shape', (tester) async {
    storage.bytes = await png(tester, 720, 360);
    storage.hold = Completer();
    await pump(tester);
    await tester.pump();

    expect(preview, findsOneWidget);
    expect(tester.getSize(preview), const Size(320, 240));
    expect(
      find.descendant(of: preview, matching: find.byType(Skeleton)),
      findsOneWidget,
    );
    expect(chip, findsNothing);
    expect(find.byType(Text), findsNothing, reason: 'no words while loading');

    storage.hold!.complete();
    await until(tester, () => drawn(tester));

    expect(tester.getSize(preview), const Size(320, 160));
    expect(
      find.descendant(of: preview, matching: find.byType(Skeleton)),
      findsNothing,
    );
    final image = tester.widget<Image>(
      find.descendant(of: preview, matching: find.byType(Image)),
    );
    final resized = image.image as ResizeImage;
    expect(resized.policy, ResizeImagePolicy.fit);
    expect((resized.width, resized.height), (640, 720), reason: 'at 2x');

    await closed(tester);
  });

  for (final (width, height, message, shown) in [
    (720, 360, 480.0, const Size(360, 180)),
    (200, 800, 320.0, const Size(90, 360)),
    (120, 80, 320.0, const Size(120, 80)),
  ]) {
    testWidgets(
      'a ${width}x$height picture in a ${message.round()} wide message '
      'shows at $shown',
      (tester) async {
        storage.bytes = await png(tester, width, height);
        await pump(tester, width: message);
        await until(tester, () => drawn(tester));

        expect(tester.getSize(preview), shown);
        await closed(tester);
      },
    );
  }

  testWidgets('a narrow message makes the box narrower, still 4:3', (
    tester,
  ) async {
    storage.hold = Completer();
    await pump(tester, width: 200);
    await tester.pump();

    expect(tester.getSize(preview), const Size(200, 150));
    storage.hold!.complete();

    await closed(tester);
  });

  testWidgets('the box sits 8 points under what is above it, and the skeleton '
      'and the picture share the row corner of 10', (tester) async {
    storage.hold = Completer();
    await pump(tester);
    await tester.pump();

    expect(tester.getTopLeft(preview).dy, 8);
    expect(
      tester
          .widget<Skeleton>(
            find.descendant(of: preview, matching: find.byType(Skeleton)),
          )
          .radius,
      10,
    );
    storage.hold!.complete();
    await until(tester, () => drawn(tester));

    expect(
      tester
          .widget<ClipRRect>(
            find.descendant(of: preview, matching: find.byType(ClipRRect)),
          )
          .borderRadius,
      BorderRadius.circular(10),
    );

    await closed(tester);
  });

  testWidgets('a file that is not a picture keeps the chip, and nothing is '
      'fetched', (tester) async {
    await pump(tester, file: attachment(mime: 'application/pdf'));
    await tester.pump();

    expect(chip, findsOneWidget);
    expect(preview, findsNothing);
    expect(storage.asked, isEmpty);
  });

  testWidgets("a picture not on Harness's file storage keeps the chip", (
    tester,
  ) async {
    await pump(tester, noLink: true);
    await tester.pump();

    expect(chip, findsOneWidget);
    expect(storage.asked, isEmpty);
  });

  testWidgets('a picture that cannot be fetched shows the chip instead', (
    tester,
  ) async {
    storage.status = 404;
    await pump(tester);

    await until(tester, () => chip.evaluate().isNotEmpty);
    expect(preview, findsNothing);

    await closed(tester);
  });

  testWidgets('a file that is not a picture after all shows the chip instead', (
    tester,
  ) async {
    storage.bytes = 'not a picture'.codeUnits;
    await pump(tester);

    await until(tester, () => chip.evaluate().isNotEmpty);
    expect(preview, findsNothing);

    await closed(tester);
  });

  testWidgets('with no account to keep files for, the chip', (tester) async {
    await pump(tester, signedIn: null);

    await until(tester, () => chip.evaluate().isNotEmpty);
    expect(storage.asked, isEmpty);

    await closed(tester);
  });

  testWidgets('drawn again from above, it fetches nothing more', (
    tester,
  ) async {
    await pump(tester);
    await until(tester, () => drawn(tester));

    await pump(tester);
    await tester.pump();

    expect(storage.asked, hasLength(1));
    expect(drawn(tester), isTrue, reason: 'no skeleton again');

    await closed(tester);
  });

  testWidgets('a tap opens it full screen, to zoom; close goes back', (
    tester,
  ) async {
    await pump(tester);
    await until(tester, () => drawn(tester));

    await tester.tap(preview);
    await tester.pumpAndSettle();
    final viewer = key('swarm-attachment-viewer');
    expect(viewer, findsOneWidget);
    expect(
      find.descendant(of: viewer, matching: find.byType(InteractiveViewer)),
      findsOneWidget,
    );
    expect(find.text('screen.png'), findsOneWidget);
    final image = tester.widget<Image>(
      find.descendant(of: viewer, matching: find.byType(Image)),
    );
    expect(
      (image.image as ResizeImage).width,
      (tester.view.physicalSize.width * 2).round(),
      reason: 'the screen, twice over, for zoom',
    );

    await tester.tap(key('swarm-attachment-close'));
    await tester.pumpAndSettle();
    expect(viewer, findsNothing);
    expect(preview, findsOneWidget);

    await closed(tester);
  });

  group('open full screen, the picture goes with its account', () {
    final viewer = key('swarm-attachment-viewer');

    /// A second of frames: after a change the preview fetches again under a
    /// skeleton, which breathes, so the screen never settles.
    Future<void> frames(WidgetTester tester) async {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    /// The picture open full screen and decoded; the image cache's key for
    /// its decoded picture.
    Future<Object> opened(WidgetTester tester) async {
      await pump(tester);
      await until(tester, () => drawn(tester));
      await tester.tap(preview);
      await tester.pumpAndSettle();
      final picture = tester
          .widget<Image>(
            find.descendant(of: viewer, matching: find.byType(Image)),
          )
          .image;
      final key = (await tester.runAsync(
        () => picture.obtainKey(ImageConfiguration.empty),
      ))!;
      await until(
        tester,
        () => PaintingBinding.instance.imageCache.containsKey(key),
      );
      return key;
    }

    final changes = <String, Future<void> Function()>{
      'another account': () => store.keepOnly('person-b'),
      'sign-out or Swarm off': () => store.keepOnly(null),
      "a Swarm leaving the account's list": () => store.clear(),
    };
    for (final MapEntry(key: change, value: run) in changes.entries) {
      testWidgets('$change closes it at once, and lets the picture go', (
        tester,
      ) async {
        final picture = await opened(tester);

        // On the test's clock, as the keeper asks it: the cache it closes
        // was opened there.
        var changed = false;
        unawaited(run().whenComplete(() => changed = true));
        await tester.pump();

        expect(
          find.descendant(of: viewer, matching: find.byType(Image)),
          findsNothing,
          reason: 'blank from the first frame',
        );
        await frames(tester);
        expect(viewer, findsNothing);
        expect(
          PaintingBinding.instance.imageCache.containsKey(picture),
          isFalse,
        );

        await until(tester, () => changed);
        await closed(tester);
      });
    }

    testWidgets('another account between the tap and the next frame: it never '
        'shows the old picture or its name', (tester) async {
      await pump(tester);
      await until(tester, () => drawn(tester));

      await tester.tap(preview);
      var changed = false;
      unawaited(store.keepOnly('person-b').whenComplete(() => changed = true));
      // Every frame of the opening, its first (offstage) one included.
      final opening = find.byKey(
        const ValueKey('swarm-attachment-viewer'),
        skipOffstage: false,
      );
      for (var frame = 0; frame < 8; frame++) {
        await tester.pump(const Duration(milliseconds: 50));
        expect(
          find.descendant(
            of: opening,
            matching: find.byType(Image, skipOffstage: false),
          ),
          findsNothing,
          reason: 'frame $frame',
        );
        expect(
          find.descendant(
            of: opening,
            matching: find.text('screen.png', skipOffstage: false),
          ),
          findsNothing,
          reason: 'frame $frame',
        );
      }
      await frames(tester);
      expect(opening, findsNothing);

      await until(tester, () => changed);
      await closed(tester);
    });

    testWidgets('another account while the preview fetches again: a skeleton, '
        'never the old picture, and a tap opens nothing', (tester) async {
      await pump(tester);
      await until(tester, () => drawn(tester));
      storage.hold = Completer();

      var changed = false;
      unawaited(store.keepOnly('person-b').whenComplete(() => changed = true));
      await until(tester, () => storage.asked.length == 2);

      expect(drawn(tester), isFalse, reason: "the old account's picture");
      expect(
        find.descendant(of: preview, matching: find.byType(Skeleton)),
        findsOneWidget,
      );
      await tester.tap(preview);
      await frames(tester);
      expect(viewer, findsNothing);

      storage.hold!.complete();
      await until(tester, () => changed && drawn(tester));
      await closed(tester);
    });

    testWidgets('after another account, the preview fetches its picture '
        'again, for that account', (tester) async {
      await pump(tester);
      await until(tester, () => drawn(tester));

      var changed = false;
      unawaited(store.keepOnly('person-b').whenComplete(() => changed = true));
      await until(
        tester,
        () => changed && storage.asked.length == 2 && drawn(tester),
      );

      await tester.tap(preview);
      await tester.pumpAndSettle();
      expect(viewer, findsOneWidget, reason: "the new account's picture opens");
      await closed(tester);
    });

    testWidgets('the same account kept again leaves it open', (tester) async {
      await opened(tester);

      await tester.runAsync(() => store.keepOnly('person-me'));
      await tester.pumpAndSettle();

      expect(viewer, findsOneWidget);
      await closed(tester);
    });
  });
}
