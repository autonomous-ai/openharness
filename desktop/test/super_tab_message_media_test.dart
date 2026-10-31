// What a chat message shows besides its words, as Slack does: pictures in
// the row, up to 360 px with their shape kept, that open full screen; code
// in a block with Copy; every other file one compact chip (Dee, 10-29).
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

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

Map<String, dynamic> _file(
  String id,
  String name,
  String mime, {
  String? url,
  int size = 120 * 1024,
}) => {
  'id': id,
  'name': name,
  'mime': mime,
  'size': size,
  'url': url ?? 'https://cdn.harness.autonomous.ai/$id/$name',
};

void main() {
  late List<Uri> loaded;
  late Map<String, Uint8List> pictures;
  late ImageProvider Function(Uri) original;

  setUp(() {
    loaded = [];
    pictures = {};
    original = attachmentImage;
    attachmentImage = (url) {
      loaded.add(url);
      return MemoryImage(pictures[url.pathSegments.last]!);
    };
  });
  tearDown(() => attachmentImage = original);

  /// A conversation whose one message says [text] and carries [files].
  Future<SuperTabController> show(
    WidgetTester tester, {
    String text = 'Here',
    List<Map<String, dynamic>> files = const [],
  }) async {
    final server = ConversationServer()..append(text, attachments: files);
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
    // Decoding happens off the fake clock.
    await tester.runAsync(() => Future<void>.delayed(Durations.short2));
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  group('pictures', () {
    for (final (width, height, shown) in [
      (720, 360, const Size(360, 180)),
      (200, 800, const Size(90, 360)),
      (120, 80, const Size(120, 80)),
    ]) {
      testWidgets('a ${width}x$height picture shows in the message at $shown', (
        tester,
      ) async {
        pictures['shot.png'] = await _png(tester, width, height);
        final c = await show(
          tester,
          files: [_file('a1', 'shot.png', 'image/png')],
        );

        final picture = find.byKey(
          const ValueKey('super-attachment-inline:a1'),
        );
        expect(picture, findsOneWidget);
        expect(tester.getSize(picture), shown);
        // Only the message's own link, however often the row rebuilds.
        expect(loaded.toSet(), {
          Uri.parse('https://cdn.harness.autonomous.ai/a1/shot.png'),
        });
        // The picture is the file: no chip besides it.
        expect(find.byKey(const ValueKey('super-attachment:a1')), findsNothing);
        await close(tester, c);
      });
    }

    testWidgets('a picture over 10 MB is a chip, and nothing is fetched', (
      tester,
    ) async {
      final c = await show(
        tester,
        files: [_file('a1', 'huge.png', 'image/png', size: 11 * 1024 * 1024)],
      );

      expect(find.byKey(const ValueKey('super-attachment:a1')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('super-attachment-inline:a1')),
        findsNothing,
      );
      expect(loaded, isEmpty);
      await close(tester, c);
    });

    testWidgets('a picture of 1 MB, or 10 MB itself, still shows in place', (
      tester,
    ) async {
      final png = await _png(tester, 120, 80);
      pictures['one.png'] = png;
      pictures['ten.png'] = png;
      final c = await show(
        tester,
        files: [
          _file('a1', 'one.png', 'image/png', size: 1024 * 1024),
          _file('a2', 'ten.png', 'image/png', size: 10 * 1024 * 1024),
        ],
      );

      for (final id in ['a1', 'a2']) {
        expect(
          find.byKey(ValueKey('super-attachment-inline:$id')),
          findsOneWidget,
        );
      }
      expect(loaded.toSet(), hasLength(2));
      await close(tester, c);
    });

    testWidgets('a picture is read at most 10 MB, whatever its row says', (
      tester,
    ) async {
      int? asked;
      final fetcher = attachmentFetcher;
      attachmentFetcher = (url, {maxBytes}) async {
        asked = maxBytes;
        throw const AttachmentTooLarge();
      };
      addTearDown(() => attachmentFetcher = fetcher);
      final failed = Completer<Object>();
      AttachmentImage(
            Uri.parse('https://cdn.harness.autonomous.ai/a1/lies.png'),
          )
          .resolve(ImageConfiguration.empty)
          .addListener(
            ImageStreamListener(
              (_, _) {},
              onError: (error, _) {
                if (!failed.isCompleted) failed.complete(error);
              },
            ),
          );

      expect(
        await tester.runAsync(() => failed.future),
        isA<AttachmentTooLarge>(),
      );
      expect(asked, kSuperTabFormAttachmentMaxBytes);
    });

    testWidgets('a click opens the picture full screen, with Download', (
      tester,
    ) async {
      pictures['shot.png'] = await _png(tester, 720, 360);
      final c = await show(
        tester,
        files: [_file('a1', 'shot.png', 'image/png')],
      );

      await tester.tap(
        find.byKey(const ValueKey('super-attachment-inline:a1')),
      );
      await tester.pumpAndSettle();
      final viewer = find.byKey(const ValueKey('super-attachment-viewer:a1'));
      expect(viewer, findsOneWidget);
      expect(tester.getSize(viewer), const Size(1100, 800));
      expect(
        find.byKey(const ValueKey('super-attachment-image:a1')),
        findsOneWidget,
      );
      expect(find.text('Download'), findsOneWidget);
      expect(find.text('Open in browser'), findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(viewer, findsNothing);
      await close(tester, c);
    });

    testWidgets('a picture off the attachments host stays a chip, unloaded', (
      tester,
    ) async {
      final c = await show(
        tester,
        files: [
          _file(
            'a1',
            'shot.png',
            'image/png',
            url: 'https://evil.example/a1/shot.png',
          ),
          _file(
            'a2',
            'plain.png',
            'image/png',
            url: 'http://cdn.harness.autonomous.ai/a2/plain.png',
          ),
          // A look-alike host: the name must match exactly.
          _file(
            'a3',
            'near.png',
            'image/png',
            url: 'https://cdn.harness.autonomous.ai.evil.example/a3/near.png',
          ),
        ],
      );

      expect(find.byKey(const ValueKey('super-attachment:a1')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-attachment:a2')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-attachment:a3')), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(loaded, isEmpty);
      await close(tester, c);
    });

    testWidgets('a picture that fails to load says so in its place', (
      tester,
    ) async {
      pictures['shot.png'] = Uint8List.fromList([1, 2, 3]);
      final c = await show(
        tester,
        files: [_file('a1', 'shot.png', 'image/png')],
      );

      expect(find.text('shot.png can’t be shown here.'), findsOneWidget);
      await close(tester, c);
    });
  });

  testWidgets('other files are one compact chip each: name · size', (
    tester,
  ) async {
    pictures['shot.png'] = await _png(tester, 720, 360);
    final c = await show(
      tester,
      files: [
        _file('a1', 'shot.png', 'image/png'),
        _file('a2', 'report.pdf', 'application/pdf'),
      ],
    );

    final chip = find.byKey(const ValueKey('super-attachment:a2'));
    expect(chip, findsOneWidget);
    for (final part in ['report.pdf', '·', '120 KB']) {
      expect(
        find.descendant(of: chip, matching: find.text(part)),
        findsOneWidget,
      );
    }
    await close(tester, c);
  });

  group('code', () {
    late List<String> copied;
    setUp(() {
      copied = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
            if (call.method == 'Clipboard.setData') {
              copied.add((call.arguments as Map)['text'] as String);
            }
            return null;
          });
    });
    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    testWidgets('a code block is monospace, named, and Copy copies it', (
      tester,
    ) async {
      final c = await show(
        tester,
        text: 'Try this:\n\n```main.dart\nfinal x = 1;\nprint(x);\n```',
      );

      final code = find.text('final x = 1;\nprint(x);');
      expect(code, findsOneWidget);
      expect(
        tester.widget<Text>(code).style?.fontFamily,
        grid.AppType.mono().fontFamily,
      );
      expect(find.text('main.dart'), findsOneWidget);
      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(copied, ['final x = 1;\nprint(x);']);
      expect(find.text('Code copied'), findsOneWidget);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await close(tester, c);
    });

    testWidgets('a block with no language still has Copy', (tester) async {
      final c = await show(tester, text: '```\nls -la\n```');

      expect(find.text('ls -la'), findsOneWidget);
      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(copied, ['ls -la']);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await close(tester, c);
    });

    testWidgets('a long block folds with Show more, and Copy takes it all', (
      tester,
    ) async {
      final lines = [for (var i = 1; i <= 30; i++) 'line $i'];
      final c = await show(tester, text: '```\n${lines.join('\n')}\n```');

      expect(find.text(lines.take(12).join('\n')), findsOneWidget);
      expect(find.textContaining('line 13'), findsNothing);
      await tester.tap(find.text('Show more'));
      await tester.pump();
      expect(find.text(lines.join('\n')), findsOneWidget);
      await tester.tap(find.text('Show less'));
      await tester.pump();
      expect(find.textContaining('line 13'), findsNothing);

      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(copied, [lines.join('\n')]);
      await tester.pumpAndSettle(const Duration(seconds: 3));
      await close(tester, c);
    });

    testWidgets('a short block has no Show more', (tester) async {
      final lines = [for (var i = 1; i <= 12; i++) 'line $i'];
      final c = await show(tester, text: '```\n${lines.join('\n')}\n```');

      expect(find.text(lines.join('\n')), findsOneWidget);
      expect(find.text('Show more'), findsNothing);
      await close(tester, c);
    });
  });
}
