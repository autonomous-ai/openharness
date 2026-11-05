// Task #3177: a chat draws a picture from the small thumbnail the server made
// at upload (backend thumbnails.ts) and the full-screen viewer opens the
// original; a file without a thumbnail, or whose thumbnail cannot be had, is
// drawn from the original as before.
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/file_links.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

final _now = DateTime.utc(2026, 11, 5, 9);
final _ms = _now.millisecondsSinceEpoch;

String _signed(String key, {String sig = '1'}) =>
    'https://storage.googleapis.com/bucket/super-tabs/tab/$key?X-Goog-Signature=$sig';
const _original = 'abc/photo.jpg';
const _thumbKey = 'abc/photo.jpg.thumb.webp';
String _cdn(String key) =>
    'https://cdn.harness.autonomous.ai/super-tabs/tab/$key';

/// A picture as a read hands it. [thumb] adds the thumbnail; [thumbLink] and
/// [thumbExpiresAt] are its signed link and end (none when [thumbUnlinked]).
Map<String, dynamic> _picture({
  bool thumb = true,
  bool thumbUnlinked = false,
  int? thumbExpiresAt,
}) => {
  'id': 'p1',
  'name': 'photo.jpg',
  'mime': 'image/jpeg',
  'size': 4000000,
  'url': _cdn(_original),
  'link': _signed(_original),
  'expiresAt': _ms + 600000,
  if (thumb) ...{
    'width': 4000,
    'height': 3000,
    'thumb': {
      'url': _cdn(_thumbKey),
      'width': 720,
      'height': 540,
      'size': 40000,
      if (thumbUnlinked)
        'unlinked': true
      else ...{
        'link': _signed(_thumbKey),
        'expiresAt': thumbExpiresAt ?? _ms + 600000,
      },
    },
  },
};

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
  late List<Uri> drawn;
  late Map<String, Uint8List> pictures;
  late ImageProvider Function(Uri) image;

  setUp(() {
    drawn = [];
    pictures = {};
    image = attachmentImage;
    superTabFileClock = () => _now;
    attachmentImage = (url) {
      drawn.add(url);
      return MemoryImage(pictures[url.toString()] ?? Uint8List(3));
    };
  });
  tearDown(() {
    attachmentImage = image;
    superTabFileClock = DateTime.now;
  });

  Future<(ConversationServer, SuperTabController)> show(
    WidgetTester tester,
    Map<String, dynamic> file,
  ) async {
    final server = ConversationServer()..append('Here', attachments: [file]);
    final controller = server.controller();
    await controller.refresh();
    await tester.binding.setSurfaceSize(const Size(1100, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
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

  // A widget asks for its picture on each build: what matters is which, in order.
  List<Uri> urls() => drawn.toSet().toList();

  final inline = find.byKey(const ValueKey('super-attachment-inline:p1'));

  group('the facts a message carries', () {
    test('a thumbnail and the picture\'s size are read', () {
      final file = SuperTabAttachment.fromJson(_picture());
      expect(file.width, 4000);
      expect(file.height, 3000);
      expect(file.thumb, isNotNull);
      expect(file.thumb!.link, _signed(_thumbKey));
      expect(file.thumb!.width, 720);
      expect(file.thumb!.expiresAt, _ms + 600000);
      expect(file.thumb!.unlinked, isFalse);
    });

    test('a file from an older server has none', () {
      final file = SuperTabAttachment.fromJson(_picture(thumb: false));
      expect(file.thumb, isNull);
      expect(file.width, isNull);
    });

    test('a field of the wrong type reads as absent, never a failed row', () {
      final row = _picture()
        ..['thumb'] = {'url': 5, 'width': 'wide'}
        ..['width'] = 'x';
      final file = SuperTabAttachment.fromJson(row);
      expect(file.thumb, isNull);
      expect(file.width, isNull);
      expect(file.id, 'p1');
    });
  });

  group('the chat', () {
    testWidgets('draws the thumbnail and does not fetch the original', (
      tester,
    ) async {
      pictures[_signed(_thumbKey)] = await _png(tester);
      pictures[_signed(_original)] = await _png(tester);
      final (_, c) = await show(tester, _picture());

      expect(inline, findsOneWidget);
      expect(urls(), [Uri.parse(_signed(_thumbKey))]);
      await close(tester, c);
    });

    testWidgets('opens the original full screen', (tester) async {
      pictures[_signed(_thumbKey)] = await _png(tester);
      pictures[_signed(_original)] = await _png(tester);
      final (_, c) = await show(tester, _picture());

      await tester.tap(inline);
      await tester.pumpAndSettle();
      expect(urls(), contains(Uri.parse(_signed(_original))));
      await tester.tap(find.byKey(const ValueKey('super-image-close')));
      await tester.pumpAndSettle();
      await close(tester, c);
    });

    testWidgets('draws the original when the file has no thumbnail', (
      tester,
    ) async {
      pictures[_signed(_original)] = await _png(tester);
      final (_, c) = await show(tester, _picture(thumb: false));

      expect(urls(), [Uri.parse(_signed(_original))]);
      await close(tester, c);
    });

    testWidgets('draws the original when the thumbnail could not be signed', (
      tester,
    ) async {
      pictures[_signed(_original)] = await _png(tester);
      final (_, c) = await show(tester, _picture(thumbUnlinked: true));

      expect(urls(), [Uri.parse(_signed(_original))]);
      await close(tester, c);
    });

    testWidgets(
      'draws the original when the thumbnail\'s link is about to end',
      (tester) async {
        pictures[_signed(_original)] = await _png(tester);
        final (_, c) = await show(
          tester,
          _picture(thumbExpiresAt: _ms + 10000),
        );

        expect(urls(), [Uri.parse(_signed(_original))]);
        await close(tester, c);
      },
    );

    testWidgets('falls back to the original when the thumbnail will not load', (
      tester,
    ) async {
      // No bytes for the thumbnail: it fails to decode.
      pictures[_signed(_original)] = await _png(tester);
      final (_, c) = await show(tester, _picture());
      // The original starts loading once the thumbnail has failed: give its
      // decode the time it has in the app.
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();

      expect(urls(), [
        Uri.parse(_signed(_thumbKey)),
        Uri.parse(_signed(_original)),
      ]);
      expect(find.text('photo.jpg can’t be shown here.'), findsNothing);
      await close(tester, c);
    });
  });
}
