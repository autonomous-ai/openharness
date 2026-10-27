import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_attachment.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';

import 'swarm_attachment_fakes.dart';

/// A picture in a chat shows in place: a skeleton in a fixed 4:3 box while it
/// loads, then the picture in the same box, decoded at the box's size, and a
/// tap opens it full screen. Every other file, and a picture that cannot be
/// shown, keeps the chip.
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

  bool drawn(WidgetTester tester) => find
      .descendant(of: preview, matching: find.byType(RawImage))
      .evaluate()
      .any((e) => (e.widget as RawImage).image != null);

  testWidgets('a picture shows a skeleton in a 4:3 box while it loads, then '
      'the picture in the same box', (tester) async {
    storage.hold = Completer();
    await pump(tester);
    await tester.pump();

    expect(preview, findsOneWidget);
    expect(tester.getSize(preview), const Size(240, 180));
    expect(
      find.descendant(of: preview, matching: find.byType(Skeleton)),
      findsOneWidget,
    );
    expect(chip, findsNothing);
    expect(find.byType(Text), findsNothing, reason: 'no words while loading');

    storage.hold!.complete();
    await until(tester, () => drawn(tester));

    expect(tester.getSize(preview), const Size(240, 180), reason: 'no jump');
    expect(
      find.descendant(of: preview, matching: find.byType(Skeleton)),
      findsNothing,
    );
    final image = tester.widget<Image>(
      find.descendant(of: preview, matching: find.byType(Image)),
    );
    expect(image.image, isA<ResizeImage>());
    expect((image.image as ResizeImage).width, 480, reason: '240 at 2x');

    await closed(tester);
  });

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
}
