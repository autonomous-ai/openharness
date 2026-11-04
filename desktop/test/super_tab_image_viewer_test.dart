// A chat's picture opens as Slack opens one (Huy, 11-04): over a dark veil,
// its sender, when and where at the top left, previous and next through the
// other pictures, rotate and zoom at the bottom left, Download, Open in
// browser and More at the bottom right; Esc or a click outside closes it.
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_image.dart';
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/file_links.dart';
import 'package:harness/super_tabs/model.dart';

/// A [width]×[height] PNG, drawn for real so a picture has a shape to keep.
Future<Uint8List> _png(WidgetTester tester, int width, int height) async =>
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

SuperTabImageItem _item(
  String id, {
  String sender = 'Huy',
  Duration ago = const Duration(days: 14, hours: 1),
  String place = '# openharness',
  VoidCallback? onShowInChat,
}) => SuperTabImageItem(
  ref: SuperTabFileRef(
    SuperTabAttachment.fromJson({
      'id': id,
      'name': '$id.png',
      'mime': 'image/png',
      'size': 120 * 1024,
      'url': 'https://cdn.harness.autonomous.ai/$id/$id.png',
    }),
  ),
  sender: sender,
  avatar: SizedBox.square(key: ValueKey('avatar-$sender'), dimension: 32),
  postedAt: DateTime.now().subtract(ago),
  place: place,
  onShowInChat: onShowInChat,
);

void main() {
  late ImageProvider Function(Uri) original;
  late Uint8List png;

  setUp(() => original = attachmentImage);
  tearDown(() => attachmentImage = original);

  Finder picture(String id) =>
      find.byKey(ValueKey('super-attachment-image:$id'));
  Finder button(String name) => find.byKey(ValueKey('super-image-$name'));

  /// The viewer over a 1100×800 window, at [index] of [images].
  Future<List<int>> open(
    WidgetTester tester,
    List<SuperTabImageItem> images, {
    int index = 0,
  }) async {
    png = await _png(tester, 720, 360);
    attachmentImage = (_) => MemoryImage(png);
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final closed = <int>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabImageViewer(
            images: images,
            index: index,
            onClose: () => closed.add(1),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.runAsync(() => Future<void>.delayed(Durations.short2));
    await tester.pumpAndSettle();
    return closed;
  }

  double scale(WidgetTester tester) => tester
      .widget<InteractiveViewer>(find.byType(InteractiveViewer))
      .transformationController!
      .value
      .getMaxScaleOnAxis();

  int turns(WidgetTester tester, String id) => tester
      .widget<RotatedBox>(
        find.ancestor(of: picture(id), matching: find.byType(RotatedBox)),
      )
      .quarterTurns;

  group('previous and next', () {
    testWidgets('the arrows page through the pictures, none past the ends', (
      tester,
    ) async {
      await open(tester, [_item('a1'), _item('a2'), _item('a3')]);
      expect(picture('a1'), findsOneWidget);
      expect(button('previous'), findsNothing);

      await tester.tap(button('next'));
      await tester.pumpAndSettle();
      expect(picture('a2'), findsOneWidget);
      expect(picture('a1'), findsNothing);
      expect(button('previous'), findsOneWidget);

      await tester.tap(button('next'));
      await tester.pumpAndSettle();
      expect(picture('a3'), findsOneWidget);
      expect(button('next'), findsNothing);

      await tester.tap(button('previous'));
      await tester.pumpAndSettle();
      expect(picture('a2'), findsOneWidget);
    });

    testWidgets('the Left and Right keys do the same', (tester) async {
      await open(tester, [_item('a1'), _item('a2'), _item('a3')], index: 1);
      expect(picture('a2'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pumpAndSettle();
      expect(picture('a3'), findsOneWidget);
      // The last stays the last.
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pumpAndSettle();
      expect(picture('a3'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pumpAndSettle();
      expect(picture('a1'), findsOneWidget);
    });

    testWidgets('one picture alone has no arrows', (tester) async {
      await open(tester, [_item('a1')]);
      expect(button('previous'), findsNothing);
      expect(button('next'), findsNothing);
    });

    testWidgets('the header follows the picture shown', (tester) async {
      await open(tester, [
        _item('a1'),
        _item('a2', sender: 'River', ago: const Duration(minutes: 5)),
      ]);
      expect(find.text('Huy'), findsOneWidget);
      expect(
        find.text('14 days ago in # openharness · a1.png'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('avatar-Huy')), findsOneWidget);

      await tester.tap(button('next'));
      await tester.pumpAndSettle();
      expect(find.text('River'), findsOneWidget);
      expect(
        find.text('5 minutes ago in # openharness · a2.png'),
        findsOneWidget,
      );
    });
  });

  group('zoom and rotate', () {
    testWidgets('plus and minus step the zoom by 25%, shown beside it', (
      tester,
    ) async {
      await open(tester, [_item('a1')]);
      expect(find.text('100%'), findsOneWidget);
      expect(scale(tester), 1);

      await tester.tap(button('zoom-in'));
      await tester.pumpAndSettle();
      expect(find.text('125%'), findsOneWidget);
      expect(scale(tester), closeTo(1.25, 1e-9));
      expect(tester.widget<Slider>(button('zoom')).value, 1.25);

      await tester.tap(button('zoom-out'));
      await tester.tap(button('zoom-out'));
      await tester.pumpAndSettle();
      // 100% is the least.
      expect(find.text('100%'), findsOneWidget);
      expect(scale(tester), closeTo(1, 1e-9));
    });

    testWidgets('the slider zooms up to 400%', (tester) async {
      await open(tester, [_item('a1')]);
      await tester.drag(button('zoom'), const Offset(400, 0));
      await tester.pumpAndSettle();
      expect(find.text('400%'), findsOneWidget);
      expect(scale(tester), closeTo(4, 1e-9));

      await tester.tap(button('zoom-in'));
      await tester.pumpAndSettle();
      expect(find.text('400%'), findsOneWidget);
    });

    testWidgets('rotate turns a quarter each click', (tester) async {
      await open(tester, [_item('a1')]);
      expect(turns(tester, 'a1'), 0);
      await tester.tap(button('rotate'));
      await tester.pumpAndSettle();
      expect(turns(tester, 'a1'), 1);
      await tester.tap(button('rotate'));
      await tester.pumpAndSettle();
      expect(turns(tester, 'a1'), 2);
    });

    testWidgets('the next picture starts unturned at 100%', (tester) async {
      await open(tester, [_item('a1'), _item('a2')]);
      await tester.tap(button('rotate'));
      await tester.tap(button('zoom-in'));
      await tester.pumpAndSettle();
      await tester.tap(button('next'));
      await tester.pumpAndSettle();
      expect(turns(tester, 'a2'), 0);
      expect(find.text('100%'), findsOneWidget);
      expect(scale(tester), closeTo(1, 1e-9));
    });
  });

  group('closing', () {
    testWidgets('Esc closes it', (tester) async {
      final closed = await open(tester, [_item('a1')]);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(closed, [1]);
    });

    testWidgets('a click on the veil closes it, on the picture does not', (
      tester,
    ) async {
      final closed = await open(tester, [_item('a1'), _item('a2')]);
      await tester.tap(picture('a1'));
      await tester.tap(button('next'));
      await tester.tap(button('rotate'));
      await tester.pump();
      expect(closed, isEmpty);

      // Beside the picture, below the header.
      await tester.tapAt(const Offset(120, 200));
      await tester.pump();
      expect(closed, [1]);
    });

    // Lynx's test of #2892: minus at 100% closed it, the click falling
    // through to the veil.
    testWidgets('a click on the bars, a control at its end included, leaves '
        'it open', (tester) async {
      final closed = await open(tester, [_item('a1')]);
      await tester.tap(button('zoom-out'));
      await tester.tap(find.text('100%'));
      await tester.tap(find.text('Huy'));
      await tester.drag(button('zoom'), const Offset(400, 0));
      await tester.pumpAndSettle();
      await tester.tap(button('zoom-in'));
      await tester.pump();
      expect(find.text('400%'), findsOneWidget);
      expect(closed, isEmpty);
    });

    testWidgets('× closes it', (tester) async {
      final closed = await open(tester, [_item('a1')]);
      await tester.tap(button('close'));
      await tester.pump();
      expect(closed, [1]);
    });
  });

  group('actions', () {
    testWidgets('Download and Open in browser stay, and Close is ×', (
      tester,
    ) async {
      await open(tester, [_item('a1')]);
      expect(find.text('Download'), findsOneWidget);
      expect(find.text('Open in browser'), findsOneWidget);
      expect(find.text('Close'), findsNothing);
    });

    testWidgets('More holds Show in chat, which closes the viewer', (
      tester,
    ) async {
      var shown = 0;
      final closed = await open(tester, [
        _item('a1', onShowInChat: () => shown++),
      ]);
      await tester.tap(find.byTooltip('More'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Show in chat'));
      await tester.pumpAndSettle();
      expect(shown, 1);
      expect(closed, [1]);
    });
  });

  group('links', () {
    final now = DateTime.utc(2026, 11, 4, 3);
    setUp(() => superTabFileClock = () => now);
    tearDown(() => superTabFileClock = DateTime.now);

    String signed(String id, {String sig = '1'}) =>
        'https://$kSuperTabFilesHost/bucket/super-tabs/tab/$id/$id.png'
        '?X-Goog-Signature=$sig';

    /// [id]'s picture whose signed link ended a minute ago; [fresh] answers
    /// the ask for another.
    SuperTabImageItem ended(
      String id,
      Future<SuperTabAttachment> Function() fresh,
    ) => SuperTabImageItem(
      ref: SuperTabFileRef(
        SuperTabAttachment.fromJson({
          'id': id,
          'name': '$id.png',
          'mime': 'image/png',
          'size': 120 * 1024,
          'url': 'https://cdn.harness.autonomous.ai/$id/$id.png',
          'link': signed(id),
          'expiresAt': now.millisecondsSinceEpoch - 60000,
        }),
        conversationId: 'lead',
        messageId: 'message-$id',
        fresh: (_, _, _) => fresh(),
      ),
      sender: 'Huy',
    );

    testWidgets('a later picture whose link ended is drawn from a fresh one', (
      tester,
    ) async {
      var asked = 0;
      final drawn = <Uri>[];
      await open(tester, [
        _item('a1'),
        ended('a2', () async {
          asked++;
          return SuperTabAttachment.fromJson({
            'id': 'a2',
            'name': 'a2.png',
            'mime': 'image/png',
            'size': 120 * 1024,
            'url': 'https://cdn.harness.autonomous.ai/a2/a2.png',
            'link': signed('a2', sig: 'fresh'),
            'expiresAt': now.millisecondsSinceEpoch + 900000,
          });
        }),
      ]);
      attachmentImage = (url) {
        drawn.add(url);
        return MemoryImage(png);
      };
      // Asked for only once it is shown.
      expect(asked, 0);
      await tester.tap(button('next'));
      await tester.pumpAndSettle();
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();
      expect(asked, 1);
      expect(picture('a2'), findsOneWidget);
      expect(drawn, [Uri.parse(signed('a2', sig: 'fresh'))]);
    });

    testWidgets('one with no fresh link says it can’t be shown', (
      tester,
    ) async {
      await open(tester, [
        _item('a1'),
        ended('a2', () async => throw StateError('offline')),
      ]);
      await tester.tap(button('next'));
      await tester.pumpAndSettle();
      expect(picture('a2'), findsNothing);
      expect(find.text('This image can’t be shown here.'), findsOneWidget);
      // Its place still reads, and the way back still works.
      expect(find.textContaining('a2.png'), findsOneWidget);
      await tester.tap(button('previous'));
      await tester.pumpAndSettle();
      expect(picture('a1'), findsOneWidget);
    });
  });

  test('times read in words', () {
    expect(superTabPostedAgo(const Duration(seconds: 20)), 'just now');
    expect(superTabPostedAgo(const Duration(minutes: 1)), '1 minute ago');
    expect(superTabPostedAgo(const Duration(minutes: 5)), '5 minutes ago');
    expect(superTabPostedAgo(const Duration(hours: 1)), '1 hour ago');
    expect(superTabPostedAgo(const Duration(hours: 3)), '3 hours ago');
    expect(superTabPostedAgo(const Duration(days: 1)), '1 day ago');
    expect(superTabPostedAgo(const Duration(days: 14)), '14 days ago');
  });
}
