// Images in a Swarm conversation: pasted or dropped into the composer,
// uploaded in parts before the message, and shown as thumbnails.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/attachments.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// A real 1×1 PNG, so a thumbnail has something to draw.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA'
  '60e6kgAAAABJRU5ErkJggg==',
);

/// A PNG header followed by enough bytes to need two parts.
Uint8List _large() =>
    Uint8List(kSuperTabImagePartBytes + 10)..setRange(0, _png.length, _png);

void main() {
  test('only PNG, JPEG and WebP images, four at most and 5 MB each', () {
    final images = SuperTabImages();
    addTearDown(images.dispose);
    expect(
      images.add([
        HarnessAttachment(
          'notes.pdf',
          Uint8List.fromList('%PDF-1.7'.codeUnits),
        ),
        HarnessAttachment('cat.gif', Uint8List.fromList('GIF89a'.codeUnits)),
      ]),
      '2 files are not PNG, JPEG or WebP images.',
    );
    expect(
      images.add([
        HarnessAttachment(
          'huge.png',
          Uint8List(kSuperTabImageMaxBytes + 1)..setRange(0, 8, _png),
        ),
      ]),
      'huge.png is over 5 MB.',
    );
    final jpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0]);
    final webp = Uint8List.fromList([
      ...'RIFF'.codeUnits,
      0,
      0,
      0,
      0,
      ...'WEBP'.codeUnits,
    ]);
    expect(
      images.addPasted([
        for (var i = 0; i < 3; i++) HarnessAttachment('shot.png', _png),
        HarnessAttachment('photo.jpg', jpeg),
        HarnessAttachment('art.webp', webp),
      ]),
      'A message can carry up to 4 images.',
    );
    expect(images.files.map((f) => f.name), [
      'shot.png',
      'shot-2.png',
      'shot-3.png',
      'photo.jpg',
    ]);
  });

  test('images upload in parts before an image-only send, and only their IDs are saved', () async {
    final server = ConversationServer();
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    final large = _large();
    c.images('lead').add([HarnessAttachment('shot.png', large)]);
    final sent = await c.send();
    expect(sent, isNotNull);
    expect(server.uploads, hasLength(2));
    expect(server.uploads.first, {
      'name': 'shot.png',
      'size': large.length,
      'data': base64Encode(large.sublist(0, kSuperTabImagePartBytes)),
    });
    final command = server.posts.single['command'] as Map;
    expect(command['text'], '');
    expect(command['attachmentIds'], ['image-1']);
    expect(c.images('lead').isEmpty, isTrue);
    expect(
      jsonEncode(server.saved),
      isNot(contains(server.uploads.last['data'])),
    );

    final message = c.messages('lead').single;
    expect(message.text, '[image]');
    expect(message.shownText, '');
    expect(message.preview, 'Image');
    final attachment = message.attachments.single;
    expect(attachment.parts, 2);
    expect(await c.attachmentBytes(attachment), large);
  });

  test(
    'a failed upload sends nothing and keeps the images for a retry',
    () async {
      final server = ConversationServer()..failUploads = true;
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      c.setDraft('lead', 'See the screenshot');
      c.images('lead').add([HarnessAttachment('shot.png', _png)]);
      expect(await c.send(), isNull);
      expect(server.posts, isEmpty);
      expect(c.operationError, 'Could not upload the image. Try again.');
      expect(c.images('lead').files, hasLength(1));
      server.failUploads = false;
      expect(await c.send(), isNotNull);
      expect(
        (server.posts.single['command'] as Map)['text'],
        'See the screenshot',
      );
      expect(c.images('lead').isEmpty, isTrue);
    },
  );

  test('an interrupted upload resumes with its missing parts', () async {
    final server = ConversationServer()..failUploadAt = 2;
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    final large = Uint8List(2 * kSuperTabImagePartBytes + 3)
      ..setRange(0, _png.length, _png);
    c.images('lead').add([HarnessAttachment('shot.png', large)]);
    expect(await c.send(), isNull);
    expect(await c.send(), isNotNull);
    expect(server.uploads.where((u) => u.containsKey('name')), hasLength(1));
    expect(server.uploads, hasLength(4));
    expect(
      await c.attachmentBytes(c.messages('lead').single.attachments.single),
      large,
    );
  });

  test('a removed or replaced image is deleted from the backend', () async {
    final server = ConversationServer()..failUploadAt = 2;
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    final images = c.images('lead');
    images.add([HarnessAttachment('shot.png', _large())]);
    expect(await c.send(), isNull);
    images.add([HarnessAttachment('shot.png', _png)]);
    await pumpEventQueue();
    expect(server.deletedAttachments, ['image-1']);
    images.add([HarnessAttachment('two.png', _large())]);
    server.failUploadAt = 5;
    expect(await c.send(), isNull);
    expect(server.attachments.keys, ['image-2', 'image-3']);
    images.remove(images.files.last);
    await pumpEventQueue();
    expect(server.deletedAttachments, ['image-1', 'image-3']);
  });

  testWidgets('a copied file that is not an image pastes its name as text', (
    tester,
  ) async {
    final dir = Directory.systemTemp.createTempSync('swarm-paste-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final notes = File('${dir.path}/notes.txt')..writeAsStringSync('hello');
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      return switch (call.method) {
        'Clipboard.getData' => {'text': 'notes.txt'},
        'Clipboard.hasStrings' => {'value': true},
        _ => null,
      };
    });
    const clipboard = MethodChannel('harness/clipboard_image');
    messenger.setMockMethodCallHandler(clipboard, (call) async {
      return switch (call.method) {
        'readImagePng' => _png,
        'readFilePaths' => [notes.path],
        _ => null,
      };
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(clipboard, null);
    });
    await tester.binding.setSurfaceSize(const Size(1100, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = ConversationServer();
    final c = server.controller();
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-message-composer')));
    await tester.runAsync(() async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-composer-images')), findsNothing);
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('super-message-composer')),
          )
          .controller!
          .text,
      'notes.txt',
    );
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a pasted screenshot is a chip until sent, then a thumbnail', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      return call.method == 'Clipboard.hasStrings' ? {'value': false} : null;
    });
    const clipboard = MethodChannel('harness/clipboard_image');
    messenger.setMockMethodCallHandler(clipboard, (call) async {
      return switch (call.method) {
        'readImagePng' => _png,
        'readFilePaths' => <String>[],
        _ => null,
      };
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(clipboard, null);
    });
    await tester.binding.setSurfaceSize(const Size(1100, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = ConversationServer();
    final c = server.controller();
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-message-composer')));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-composer-images')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('new-harness-attachment:pasted-image.png')),
      findsOneWidget,
    );

    await tester.tap(find.byTooltip('Send message'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-composer-images')), findsNothing);
    expect((server.posts.single['command'] as Map)['attachmentIds'], [
      'image-1',
    ]);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('super-message-image:image-1')),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    debugDefaultTargetPlatformOverride = null;
  });
}
