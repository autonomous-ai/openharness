// Files in a Swarm conversation: the composer takes pasted, dropped and picked
// files and uploads them before the message, and a message shows its files as
// chips that load nothing until clicked (pictures, shown in place, are in
// super_tab_message_media_test.dart).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart' show CancelToken;
import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/finder/widgets/finder_code_editor.dart';
import 'package:harness/finder/widgets/finder_markdown_view.dart';
import 'package:harness/super_tabs/attachment_upload.dart';
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/widgets/new_harness_paste.dart';

import 'support/super_tab_fixture.dart';

/// A real 1×1 PNG, so a chip has something to draw.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA'
  '60e6kgAAAABJRU5ErkJggg==',
);

/// A picked file, which `XFile.fromData` cannot name off the web.
class _Picked extends XFile {
  _Picked(this.name, this.bytes) : super('/picked/$name');

  @override
  final String name;
  final Uint8List bytes;

  @override
  Future<Uint8List> readAsBytes() async => bytes;
}

class _Picker extends FileSelectorPlatform {
  _Picker(this.files);
  final List<XFile> files;

  @override
  Future<List<XFile>> openFiles({
    List<XTypeGroup>? acceptedTypeGroups,
    String? initialDirectory,
    String? confirmButtonText,
  }) async => files;
}

/// A save dialog that answers with [path], or cancels when it is null.
class _SaveTo extends FileSelectorPlatform {
  _SaveTo(this.path);
  final String? path;
  final suggested = <String?>[];

  @override
  Future<FileSaveLocation?> getSaveLocation({
    List<XTypeGroup>? acceptedTypeGroups,
    SaveDialogOptions options = const SaveDialogOptions(),
  }) async {
    suggested.add(options.suggestedName);
    return path == null ? null : FileSaveLocation(path!);
  }
}

void main() {
  final composer = find.byKey(const ValueKey('super-message-composer'));
  final send = find.byTooltip('Send message');

  Future<void> mount(WidgetTester tester, SuperTabController controller) async {
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
  }

  Future<(ConversationServer, SuperTabController)> open(
    WidgetTester tester,
  ) async {
    final server = ConversationServer();
    final controller = server.controller();
    await controller.refresh();
    await mount(tester, controller);
    return (server, controller);
  }

  /// Takes the view down and settles the draft save before the test ends.
  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  List<String> names(SuperTabController c) => [
    for (final file in c.attachments('lead').files) file.name,
  ];

  test('a web page is sent as an unknown kind, never as html', () {
    expect(mimeForName('page.html'), 'application/octet-stream');
    expect(mimeForName('shot.PNG'), 'image/png');
    expect(mimeForName('old.bmp'), 'application/octet-stream');
  });

  test('only the kinds the backend shows in place open as pictures', () {
    SuperTabAttachment of(String mime) => SuperTabAttachment.fromJson({
      'id': 'a',
      'name': 'f',
      'mime': mime,
      'size': 1,
      'url': 'https://cdn.harness.autonomous.ai/a/f',
    });
    for (final mime in ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(of(mime).isImage, isTrue, reason: mime);
    }
    for (final mime in ['image/bmp', 'image/svg+xml', 'application/pdf']) {
      expect(of(mime).isImage, isFalse, reason: mime);
    }
  });

  group('adding files', () {
    testWidgets('a pasted picture becomes a chip', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        const MethodChannel('harness/clipboard_image'),
        (call) async => call.method == 'readImagePng' ? _png : <String>[],
      );
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        return switch (call.method) {
          'Clipboard.getData' => null,
          'Clipboard.hasStrings' => {'value': false},
          _ => null,
        };
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(
          const MethodChannel('harness/clipboard_image'),
          null,
        );
        messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      });
      final (_, controller) = await open(tester);

      await tester.tap(composer);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();

      expect(names(controller), [kPastedImageName]);
      expect(
        find.byKey(const ValueKey('new-harness-attachment:$kPastedImageName')),
        findsOneWidget,
      );
      debugDefaultTargetPlatformOverride = null;
      await close(tester, controller);
    });

    testWidgets('a dropped file becomes a chip', (tester) async {
      // One logical pixel per device pixel, so the platform's drop position
      // needs no scaling on any host.
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetDevicePixelRatio);
      final (_, controller) = await open(tester);
      final file = File('${Directory.systemTemp.path}/swarm-drop-test.log');
      await tester.runAsync(() => file.writeAsString('boom'));
      addTearDown(() => file.deleteSync());
      final inside = tester.getCenter(
        find.byKey(const ValueKey('super-message-composer-surface')),
      );

      Future<void> platform(String method, Object arguments) =>
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .handlePlatformMessage(
                'desktop_drop',
                const StandardMethodCodec().encodeMethodCall(
                  MethodCall(method, arguments),
                ),
                (_) {},
              );
      await platform('entered', [inside.dx, inside.dy]);
      await tester.pump();
      expect(find.text('Drop files to attach'), findsOneWidget);

      await tester.runAsync(() async {
        await platform('performOperation', [file.path]);
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      expect(names(controller), ['swarm-drop-test.log']);
      expect(
        find.byKey(
          const ValueKey('new-harness-attachment:swarm-drop-test.log'),
        ),
        findsOneWidget,
      );
      await close(tester, controller);
    });

    testWidgets('a picked file becomes a chip', (tester) async {
      final original = FileSelectorPlatform.instance;
      FileSelectorPlatform.instance = _Picker([
        _Picked('trace.zip', Uint8List.fromList([1, 2, 3])),
      ]);
      addTearDown(() => FileSelectorPlatform.instance = original);
      final (_, controller) = await open(tester);

      await tester.tap(find.byKey(const ValueKey('new-harness-attach')));
      await tester.pumpAndSettle();

      expect(names(controller), ['trace.zip']);
      await close(tester, controller);
    });

    test('a file over 10 MB, or an eleventh file, is refused', () {
      final controller = ConversationServer().controller();
      addTearDown(controller.dispose);
      final files = controller.attachments('lead');

      expect(
        files.add([
          HarnessAttachment(
            'big.bin',
            Uint8List(kSuperTabAttachmentMaxBytes + 1),
          ),
        ]),
        'big.bin is over 10 MB.',
      );
      expect(files.isEmpty, isTrue);

      String? problem;
      for (var i = 0; i <= kSuperTabAttachmentMaxFiles; i++) {
        problem = files.add([
          HarnessAttachment('f$i.txt', Uint8List.fromList([1])),
        ]);
      }
      expect(files.files, hasLength(kSuperTabAttachmentMaxFiles));
      expect(problem, 'Attach at most 10 files.');
    });
  });

  group('sending', () {
    testWidgets('uploads each file, then sends the ids', (tester) async {
      final (server, controller) = await open(tester);
      controller.attachments('lead').add([
        HarnessAttachment('shot.png', _png),
        HarnessAttachment('notes.txt', Uint8List.fromList([104, 105])),
      ]);
      await tester.enterText(composer, 'See these');
      await tester.pump();

      await tester.tap(send);
      await tester.pumpAndSettle();

      expect(
        server.uploads.map((u) => (u['conversationId'], u['name'], u['mime'])),
        [
          ('lead', 'shot.png', 'image/png'),
          ('lead', 'notes.txt', 'text/plain'),
        ],
      );
      expect(server.uploads.first['file'], _png);
      expect(server.uploads.last['file'], [104, 105]);
      expect(server.posts, hasLength(1));
      final command = server.posts.single['command'] as Map;
      expect(command['type'], 'message.send');
      expect(command['text'], 'See these');
      expect(command['attachmentIds'], ['attachment-1', 'attachment-2']);
      expect(controller.attachments('lead').isEmpty, isTrue);
      // The picture shows in place, the text file as a chip.
      expect(
        find.byKey(const ValueKey('super-attachment-inline:attachment-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('super-attachment:attachment-2')),
        findsOneWidget,
      );
      await close(tester, controller);
    });

    testWidgets('a file alone can be sent without text', (tester) async {
      final (server, controller) = await open(tester);
      controller.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      await tester.pump();

      await tester.tap(send);
      await tester.pumpAndSettle();

      final command = server.posts.single['command'] as Map;
      expect(command['text'], '');
      expect(command['attachmentIds'], hasLength(1));
      await close(tester, controller);
    });

    testWidgets('a failed upload says so under its own conversation only', (
      tester,
    ) async {
      final (server, controller) = await open(tester);
      server.failUpload = 'two.png';
      controller.attachments('lead').add([HarnessAttachment('two.png', _png)]);
      await tester.pump();
      await tester.tap(send);
      await tester.pumpAndSettle();
      expect(find.text('The file is too large.'), findsOneWidget);

      await controller.select('offline');
      await tester.pumpAndSettle();
      expect(find.text('The file is too large.'), findsNothing);

      await controller.select('lead');
      await tester.pumpAndSettle();
      expect(find.text('The file is too large.'), findsOneWidget);
      await close(tester, controller);
    });

    testWidgets('a failed upload keeps the draft and the files, and a retry '
        'sends only the file that did not go up', (tester) async {
      final (server, controller) = await open(tester);
      server.failUpload = 'two.png';
      controller.attachments('lead').add([
        HarnessAttachment('one.png', _png),
        HarnessAttachment('two.png', Uint8List.fromList([..._png, 0])),
      ]);
      await tester.enterText(composer, 'Look');
      await tester.pump();

      await tester.tap(send);
      await tester.pumpAndSettle();

      expect(server.posts, isEmpty);
      expect(controller.draft('lead'), 'Look');
      expect(names(controller), ['one.png', 'two.png']);
      expect(controller.composerError('lead'), 'The file is too large.');
      expect(find.text('The file is too large.'), findsOneWidget);
      expect(controller.uploading, isFalse);

      server.failUpload = null;
      await tester.tap(send);
      await tester.pumpAndSettle();

      expect(server.uploads.map((u) => u['name']), ['one.png', 'two.png']);
      final command = server.posts.single['command'] as Map;
      expect(command['attachmentIds'], ['attachment-1', 'attachment-2']);
      expect(controller.attachments('lead').isEmpty, isTrue);
      await close(tester, controller);
    });

    testWidgets('a chip fills as its file goes up', (tester) async {
      final server = ConversationServer();
      final release = Completer<void>();
      final controller = server.controller(
        upload:
            ({
              required tabId,
              required conversationId,
              required name,
              required mime,
              required bytes,
              required cancel,
              required onProgress,
            }) async {
              onProgress(.25);
              await release.future;
              return server.upload(
                tabId: tabId,
                conversationId: conversationId,
                name: name,
                mime: mime,
                bytes: bytes,
                cancel: cancel,
                onProgress: onProgress,
              );
            },
      );
      await controller.refresh();
      await mount(tester, controller);
      controller.attachments('lead').add([HarnessAttachment('a.png', _png)]);
      await tester.pump();
      final spinner = find.byKey(
        const ValueKey('new-harness-attachment-progress:a.png'),
      );

      await tester.tap(send);
      await tester.pump();
      await tester.pump();
      expect(spinner, findsOneWidget);
      expect(tester.widget<CircularProgressIndicator>(spinner).value, .25);

      release.complete();
      await tester.pumpAndSettle();
      expect(spinner, findsNothing);
      await close(tester, controller);
    });

    testWidgets(
      'an upload that stops moving times out and frees the composer',
      (tester) async {
        final server = ConversationServer();
        CancelToken? token;
        final controller = SuperTabController(
          tabId: 'tab',
          accountId: 'owner',
          request: server.request,
          save: server.save,
          pollInterval: Duration.zero,
          uploadTimeout: const Duration(seconds: 5),
          upload:
              ({
                required tabId,
                required conversationId,
                required name,
                required mime,
                required bytes,
                required cancel,
                required onProgress,
              }) {
                token = cancel;
                onProgress(.1);
                return Completer<Map<String, dynamic>>().future;
              },
        );
        await controller.refresh();
        await mount(tester, controller);
        controller.attachments('lead').add([HarnessAttachment('a.png', _png)]);
        await tester.pump();

        await tester.tap(send);
        await tester.pump(const Duration(seconds: 6));
        await tester.pumpAndSettle();

        expect(token?.isCancelled, isTrue);
        expect(controller.uploading, isFalse);
        expect(
          controller.composerError('lead'),
          'The upload stopped moving. Try again.',
        );
        expect(names(controller), ['a.png']);
        await close(tester, controller);
      },
    );

    testWidgets('taking a chip off cancels the upload and frees the composer', (
      tester,
    ) async {
      final server = ConversationServer();
      CancelToken? token;
      final controller = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        request: server.request,
        save: server.save,
        pollInterval: Duration.zero,
        upload:
            ({
              required tabId,
              required conversationId,
              required name,
              required mime,
              required bytes,
              required cancel,
              required onProgress,
            }) {
              token = cancel;
              return Completer<Map<String, dynamic>>().future;
            },
      );
      await controller.refresh();
      await mount(tester, controller);
      controller.attachments('lead').add([
        HarnessAttachment('a.png', _png),
        HarnessAttachment('b.png', Uint8List.fromList([..._png, 1])),
      ]);
      await tester.pump();

      await tester.tap(send);
      await tester.pump();
      expect(controller.uploading, isTrue);

      await tester.tap(find.byTooltip('Remove a.png'));
      await tester.pumpAndSettle();

      expect(token?.isCancelled, isTrue);
      expect(controller.uploading, isFalse);
      expect(controller.composerError('lead'), isNull);
      expect(names(controller), ['b.png']);
      expect(server.posts, isEmpty);
      await close(tester, controller);
    });

    test('only the files that were sent leave the composer', () async {
      final server = ConversationServer();
      final held = Completer<void>();
      final controller = SuperTabController(
        tabId: 'tab',
        accountId: 'owner',
        request: (method, path, {body}) async {
          if (method == 'POST' &&
              (body?['command'] as Map?)?['type'] == 'message.send') {
            await held.future;
          }
          return server.request(method, path, body: body);
        },
        save: server.save,
        upload: server.upload,
        pollInterval: Duration.zero,
      );
      await controller.refresh();
      final first = HarnessAttachment('one.png', _png);
      final later = HarnessAttachment('two.png', Uint8List.fromList([1, 2]));
      controller.attachments('lead').add([first]);
      controller.setDraft('lead', 'Here');

      final sending = controller.send();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      controller.attachments('lead').add([later]);
      held.complete();
      await sending;

      expect(names(controller), ['two.png']);
      controller.dispose();
    });

    test(
      'a refused message re-uploads only after an attachment refusal',
      () async {
        for (final (code, reuploads) in [
          ('INVALID_RECIPIENT', false),
          ('INVALID_ATTACHMENT', true),
        ]) {
          final server = ConversationServer();
          final controller = SuperTabController(
            tabId: 'tab',
            accountId: 'owner',
            request: (method, path, {body}) {
              if (method == 'POST' &&
                  (body?['command'] as Map?)?['type'] == 'message.send') {
                throw SuperTabFailure(code, 'Refused.', statusCode: 400);
              }
              return server.request(method, path, body: body);
            },
            save: server.save,
            upload: server.upload,
            pollInterval: Duration.zero,
          );
          await controller.refresh();
          controller.attachments('lead').add([
            HarnessAttachment('a.png', _png),
          ]);
          await controller.send();
          await controller.send();

          expect(server.uploads, hasLength(reuploads ? 2 : 1), reason: code);
          controller.dispose();
        }
      },
    );
  });

  group('download', () {
    final file = SuperTabAttachment.fromJson({
      'id': 'a1',
      'name': 'spec.md',
      'mime': 'text/markdown',
      'size': 5,
      'url': 'https://cdn.harness.autonomous.ai/a1/spec.md',
    });
    final url = Uri.parse(file.url);
    late Directory dir;
    late FileSelectorPlatform picker;
    final fetched = <Uri>[];
    late Future<Uint8List> Function(Uri, {int? maxBytes}) fetcher;

    setUp(() {
      dir = Directory.systemTemp.createTempSync('attachment-download');
      picker = FileSelectorPlatform.instance;
      fetcher = attachmentFetcher;
      fetched.clear();
      attachmentFetcher = (url, {maxBytes}) async {
        fetched.add(url);
        return Uint8List.fromList(utf8.encode('hello'));
      };
    });
    tearDown(() {
      FileSelectorPlatform.instance = picker;
      attachmentFetcher = fetcher;
      dir.deleteSync(recursive: true);
    });

    test('asks where, then saves the fetched file there', () async {
      final target = '${dir.path}/saved.md';
      final dialog = _SaveTo(target);
      FileSelectorPlatform.instance = dialog;

      expect(await downloadAttachment(file, url), isTrue);
      expect(dialog.suggested, ['spec.md']);
      expect(fetched, [url]);
      expect(File(target).readAsStringSync(), 'hello');
    });

    test('a cancelled save dialog fetches nothing', () async {
      FileSelectorPlatform.instance = _SaveTo(null);

      expect(await downloadAttachment(file, url), isFalse);
      expect(fetched, isEmpty);
    });
  });

  group('messages', () {
    testWidgets('a file shows as a chip and loads nothing until a click', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append(
          'Here',
          attachments: [
            {
              'id': 'a2',
              'name': 'report.pdf',
              'mime': 'application/pdf',
              'size': 3 * 1024 * 1024,
              'url': 'https://cdn.harness.autonomous.ai/a2/report.pdf',
            },
          ],
        );
      final controller = server.controller();
      await controller.refresh();
      await mount(tester, controller);
      final opened = <Uri>[];
      final original = browserOpener;
      browserOpener = (url) async {
        opened.add(url);
        return true;
      };
      addTearDown(() => browserOpener = original);

      expect(find.text('report.pdf'), findsOneWidget);
      expect(find.text('3.0 MB'), findsOneWidget);
      expect(opened, isEmpty);

      await tester.tap(find.byKey(const ValueKey('super-attachment:a2')));
      await tester.pumpAndSettle();
      expect(opened, [
        Uri.parse('https://cdn.harness.autonomous.ai/a2/report.pdf'),
      ]);
      await close(tester, controller);
    });

    testWidgets('a message of files alone has no empty text block', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append(
          '',
          attachments: [
            {
              'id': 'a1',
              'name': 'log.txt',
              'mime': 'text/plain',
              'size': 10,
              'url': 'https://cdn.harness.autonomous.ai/a1/log.txt',
            },
          ],
        );
      final controller = server.controller();
      await controller.refresh();
      await mount(tester, controller);

      expect(find.text('log.txt'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await close(tester, controller);
    });

    testWidgets('a link off the attachments host opens nothing and says why', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append(
          'Here',
          attachments: [
            {
              'id': 'a1',
              'name': 'evil.pdf',
              'mime': 'application/pdf',
              'size': 10,
              'url': 'https://evil.example/a1/evil.pdf',
            },
            {
              'id': 'a2',
              'name': 'plain.pdf',
              'mime': 'application/pdf',
              'size': 10,
              'url': 'http://cdn.harness.autonomous.ai/a2/plain.pdf',
            },
          ],
        );
      final controller = server.controller();
      await controller.refresh();
      await mount(tester, controller);
      final opened = <Uri>[];
      final original = browserOpener;
      browserOpener = (url) async {
        opened.add(url);
        return true;
      };
      addTearDown(() => browserOpener = original);

      const why =
          'This file isn’t on Harness’s file storage, so it wasn’t opened.';
      await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
      await tester.pump();
      expect(find.text(why), findsOneWidget);

      // An http link on the right host is refused too.
      ScaffoldMessenger.of(
        tester.element(find.byKey(const ValueKey('super-attachment:a1'))),
      ).clearSnackBars();
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-attachment:a2')));
      await tester.pump();
      expect(find.text(why), findsOneWidget);
      expect(opened, isEmpty);
      await close(tester, controller);
    });

    /// A message carrying [rows], mounted, with the browser and the file
    /// fetch recorded; a fetch answers with [served] by file name.
    Future<(SuperTabController, List<Uri>, List<Uri>)> showFiles(
      WidgetTester tester,
      List<Map<String, dynamic>> rows, {
      Map<String, List<int>> served = const {},
    }) async {
      final server = ConversationServer()..append('Here', attachments: rows);
      final controller = server.controller();
      await controller.refresh();
      await mount(tester, controller);
      final opened = <Uri>[], fetched = <Uri>[];
      final browser = browserOpener, fetcher = attachmentFetcher;
      browserOpener = (url) async {
        opened.add(url);
        return true;
      };
      attachmentFetcher = (url, {maxBytes}) async {
        fetched.add(url);
        return Uint8List.fromList(served[url.pathSegments.last]!);
      };
      addTearDown(() {
        browserOpener = browser;
        attachmentFetcher = fetcher;
      });
      return (controller, opened, fetched);
    }

    Map<String, dynamic> row(String id, String name, String mime, int size) => {
      'id': id,
      'name': name,
      'mime': mime,
      'size': size,
      'url': 'https://cdn.harness.autonomous.ai/$id/$name',
    };

    String shownText(WidgetTester tester) => tester
        .widget<FinderCodeEditor>(find.byType(FinderCodeEditor))
        .controller
        .text;

    testWidgets('a Markdown file opens rendered, its source a click away', (
      tester,
    ) async {
      final (controller, opened, fetched) = await showFiles(
        tester,
        [row('a1', 'spec.md', 'text/markdown', 40)],
        served: {'spec.md': utf8.encode('# The spec\n\nRead **this**.')},
      );

      await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
      await tester.pumpAndSettle();
      expect(fetched, [
        Uri.parse('https://cdn.harness.autonomous.ai/a1/spec.md'),
      ]);
      expect(find.byType(FinderMarkdownView), findsOneWidget);
      expect(find.text('The spec'), findsOneWidget);
      expect(find.byType(FinderCodeEditor), findsNothing);

      await tester.tap(find.byTooltip('Show source'));
      await tester.pumpAndSettle();
      expect(find.byType(FinderMarkdownView), findsNothing);
      final editor = tester.widget<FinderCodeEditor>(
        find.byType(FinderCodeEditor),
      );
      expect(editor.readOnly, isTrue);
      expect(editor.controller.text, '# The spec\n\nRead **this**.');

      await tester.tap(find.byTooltip('Show preview'));
      await tester.pumpAndSettle();
      expect(find.byType(FinderMarkdownView), findsOneWidget);
      expect(find.text('Download'), findsOneWidget);
      expect(find.text('Open in browser'), findsOneWidget);
      expect(opened, isEmpty);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await close(tester, controller);
    });

    testWidgets('a log and a JSON file open as text', (tester) async {
      final (controller, opened, _) = await showFiles(
        tester,
        [
          row('a1', 'run.log', 'text/plain', 20),
          row('a2', 'data.json', 'application/json', 20),
        ],
        served: {
          'run.log': utf8.encode('line one\nline two'),
          'data.json': utf8.encode('{"ok": true}'),
        },
      );

      await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
      await tester.pumpAndSettle();
      expect(shownText(tester), 'line one\nline two');
      expect(find.byTooltip('Show source'), findsNothing);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('super-attachment:a2')));
      await tester.pumpAndSettle();
      expect(shownText(tester), '{"ok": true}');
      expect(opened, isEmpty);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await close(tester, controller);
    });

    testWidgets('a file too large or not text opens in the browser unread', (
      tester,
    ) async {
      final (controller, opened, fetched) = await showFiles(tester, [
        row('a1', 'huge.log', 'text/plain', kAttachmentTextMaxBytes + 1),
        row('a2', 'bundle.zip', 'application/zip', 100),
      ]);

      await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-attachment:a2')));
      await tester.pumpAndSettle();
      expect(opened, [
        Uri.parse('https://cdn.harness.autonomous.ai/a1/huge.log'),
        Uri.parse('https://cdn.harness.autonomous.ai/a2/bundle.zip'),
      ]);
      expect(fetched, isEmpty);
      await close(tester, controller);
    });

    testWidgets(
      'a file that runs past the limit while read opens the browser',
      (tester) async {
        final (controller, opened, _) = await showFiles(tester, [
          row('a1', 'small-on-paper.log', 'text/plain', 10),
        ]);
        final limits = <int?>[];
        attachmentFetcher = (url, {maxBytes}) async {
          limits.add(maxBytes);
          throw const AttachmentTooLarge();
        };

        await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
        await tester.pumpAndSettle();
        expect(limits, [kAttachmentTextMaxBytes]);
        expect(opened, [
          Uri.parse('https://cdn.harness.autonomous.ai/a1/small-on-paper.log'),
        ]);
        expect(find.text('Close'), findsNothing);
        await close(tester, controller);
      },
    );

    testWidgets('a text name over binary bytes shows no preview', (
      tester,
    ) async {
      final (controller, _, _) = await showFiles(
        tester,
        [row('a1', 'notes.txt', 'text/plain', 4)],
        served: {
          'notes.txt': [0, 1, 2, 3],
        },
      );

      await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
      await tester.pumpAndSettle();
      expect(find.text('No preview'), findsOneWidget);
      expect(find.byType(FinderCodeEditor), findsNothing);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await close(tester, controller);
    });

    testWidgets('a text file off the attachments host is never fetched', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append(
          'Here',
          attachments: [
            {
              'id': 'a1',
              'name': 'notes.md',
              'mime': 'text/markdown',
              'size': 10,
              'url': 'https://evil.example/a1/notes.md',
            },
          ],
        );
      final controller = server.controller();
      await controller.refresh();
      await mount(tester, controller);
      final fetched = <Uri>[];
      final original = attachmentFetcher;
      attachmentFetcher = (url, {maxBytes}) async {
        fetched.add(url);
        return Uint8List(0);
      };
      addTearDown(() => attachmentFetcher = original);

      await tester.tap(find.byKey(const ValueKey('super-attachment:a1')));
      await tester.pump();
      expect(
        find.text(
          'This file isn’t on Harness’s file storage, so it wasn’t opened.',
        ),
        findsOneWidget,
      );
      expect(fetched, isEmpty);
      expect(find.byType(FinderMarkdownView), findsNothing);
      await close(tester, controller);
    });

    testWidgets('a malformed attachment row is left out, not the page', (
      tester,
    ) async {
      final server = ConversationServer()
        ..append(
          'Two files, one broken',
          attachments: [
            {'id': 'bad', 'name': 'no-size.txt'},
            {
              'id': 'good',
              'name': 'ok.txt',
              'mime': 'text/plain',
              'size': 10,
              'url': 'https://cdn.harness.autonomous.ai/good/ok.txt',
            },
          ],
        )
        ..append('Next message');
      final controller = server.controller();
      await controller.refresh();
      await mount(tester, controller);

      expect(find.text('ok.txt'), findsOneWidget);
      expect(find.text('no-size.txt'), findsNothing);
      expect(find.text('Next message'), findsOneWidget);
      await close(tester, controller);
    });
  });
}
