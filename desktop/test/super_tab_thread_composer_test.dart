import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
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

/// The thread pane takes what the main chat takes: text that can be selected
/// and copied, Enter / Shift+Enter / Alt+Enter as in the chat box, and files
/// attached by the paperclip, a drop or a paste, uploaded with the reply.
void main() {
  final desktops = TargetPlatformVariant({
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  });
  final composer = find.byKey(const ValueKey('super-thread-composer'));
  final surface = find.byKey(const ValueKey('super-thread-composer-surface'));
  final send = find.byKey(const ValueKey('super-thread-send'));
  final panel = find.byKey(const ValueKey('super-thread-panel'));
  final line = find.byKey(const ValueKey('super-thread-line-message-1'));

  late SuperTabController shown;

  /// A widget test that takes the view down and settles the controller's
  /// draft save before it ends, as the chat's own tests do.
  void testThread(
    String description,
    Future<void> Function(WidgetTester tester) body, {
    TestVariant<Object?> variant = const DefaultTestVariant(),
  }) => testWidgets(description, (tester) async {
    await body(tester);
    await tester.pumpWidget(const SizedBox());
    await shown.flush();
  }, variant: variant);

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    String account = 'owner',
  }) async {
    // One logical pixel per device pixel, so the platform's drop position
    // needs no scaling on any host.
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = shown = server.controller(account: account);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
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
    addTearDown(c.dispose);
    return c;
  }

  /// A root and two replies in the lead's thread.
  ConversationServer threaded() {
    final server = ConversationServer()..threads = true;
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    server.append('Agreed.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-2';
    return server;
  }

  Future<SuperTabController> openThread(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = await show(tester, server);
    await tester.tap(line);
    await tester.pumpAndSettle();
    expect(panel, findsOneWidget);
    return c;
  }

  HarnessAttachments files(SuperTabController c) =>
      c.threadAttachments('lead', 'message-1');
  List<String> names(SuperTabController c) => [
    for (final file in files(c).files) file.name,
  ];
  TextEditingController field(WidgetTester tester) =>
      tester.widget<TextField>(composer).controller!;

  Future<void> platform(String method, Object arguments) =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
            'desktop_drop',
            const StandardMethodCodec().encodeMethodCall(
              MethodCall(method, arguments),
            ),
            (_) {},
          );

  group('selecting and copying', () {
    testThread('thread messages can be selected and copied', (tester) async {
      String? copied;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      await openThread(tester, threaded());

      final region = tester.state<SelectableRegionState>(
        find.descendant(of: panel, matching: find.byType(SelectableRegion)),
      );
      region.selectAll(SelectionChangedCause.keyboard);
      await tester.pump();
      Actions.invoke(
        tester.element(
          find.descendant(of: panel, matching: find.text('Yes, like Slack.')),
        ),
        CopySelectionTextIntent.copy,
      );
      await tester.pump();
      expect(copied, contains('Should we do thread replies?'));
      expect(copied, contains('Agreed.'));
      expect(copied, contains('Yes, like Slack.'));
    });
  });

  group('the new line', () {
    testThread('Enter sends the reply to the root', (tester) async {
      final server = threaded();
      final c = await openThread(tester, server);
      await tester.tap(composer);
      await tester.enterText(composer, 'On it');
      await tester.pump();

      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      final command = server.posts.single['command'] as Map;
      expect(command['text'], 'On it');
      expect(command['replyTo'], 'message-1');
      expect(field(tester).text, isEmpty);
      expect(c.threadDraft('message-1'), isEmpty);
    }, variant: desktops);

    for (final (name, modifier) in [
      ('Shift', LogicalKeyboardKey.shiftLeft),
      ('Alt/Option', LogicalKeyboardKey.altLeft),
    ]) {
      testThread('$name+Enter adds a line at the cursor and does not send', (
        tester,
      ) async {
        final server = threaded();
        final c = await openThread(tester, server);
        await tester.tap(composer);
        await tester.enterText(composer, 'firstsecond');
        field(tester).selection = const TextSelection.collapsed(offset: 5);

        await tester.sendKeyDownEvent(modifier);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(modifier);
        await tester.pump();

        expect(field(tester).text, 'first\nsecond');
        // The draft follows the box, so closing the thread keeps the line.
        expect(c.threadDraft('message-1'), 'first\nsecond');
        expect(
          field(tester).selection,
          const TextSelection.collapsed(offset: 6),
        );
        expect(server.posts, isEmpty);
        expect(
          tester.widget<TextField>(composer).focusNode!.hasPrimaryFocus,
          isTrue,
        );
      }, variant: desktops);
    }

    testThread('Ctrl+Enter is left to the field and does not send', (
      tester,
    ) async {
      final server = threaded();
      await openThread(tester, server);
      await tester.tap(composer);
      await tester.enterText(composer, 'draft');

      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(server.posts, isEmpty);
    });
  });

  group('attaching', () {
    testThread('the paperclip picks files into chips', (tester) async {
      final original = FileSelectorPlatform.instance;
      FileSelectorPlatform.instance = _Picker([
        _Picked('trace.zip', Uint8List.fromList([1, 2, 3])),
      ]);
      addTearDown(() => FileSelectorPlatform.instance = original);
      final c = await openThread(tester, threaded());

      await tester.tap(
        find.descendant(
          of: panel,
          matching: find.byKey(const ValueKey('new-harness-attach')),
        ),
      );
      await tester.pumpAndSettle();

      expect(names(c), ['trace.zip']);
      expect(
        find.descendant(
          of: panel,
          matching: find.byKey(
            const ValueKey('new-harness-attachment:trace.zip'),
          ),
        ),
        findsOneWidget,
      );
      // The chat's own box is not given the thread's file.
      expect(c.attachments('lead').isEmpty, isTrue);
    });

    testThread('a dropped file becomes a chip', (tester) async {
      final c = await openThread(tester, threaded());
      final file = File('${Directory.systemTemp.path}/swarm-thread-drop.log');
      await tester.runAsync(() => file.writeAsString('boom'));
      addTearDown(() => file.deleteSync());
      final inside = tester.getCenter(surface);

      await platform('entered', [inside.dx, inside.dy]);
      await tester.pump();
      expect(find.text('Drop files to attach'), findsOneWidget);
      await tester.runAsync(() async {
        await platform('performOperation', [file.path]);
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();

      expect(names(c), ['swarm-thread-drop.log']);
      expect(c.attachments('lead').isEmpty, isTrue);
    });

    testThread('a pasted picture becomes a chip', (tester) async {
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
      final c = await openThread(tester, threaded());

      await tester.tap(composer);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();

      expect(names(c), [kPastedImageName]);
      expect(c.attachments('lead').isEmpty, isTrue);
      debugDefaultTargetPlatformOverride = null;
    });

    testThread('the files upload to the thread\'s chat, then go with the '
        'reply to the root', (tester) async {
      final server = threaded();
      final c = await openThread(tester, server);
      files(c).add([
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
      final command = server.posts.single['command'] as Map;
      expect(command['text'], 'See these');
      expect(command['replyTo'], 'message-1');
      expect(command['attachmentIds'], ['attachment-1', 'attachment-2']);
      expect(files(c).isEmpty, isTrue);
      expect(field(tester).text, isEmpty);
    });

    testThread('a file alone can be sent, and Also send keeps it', (
      tester,
    ) async {
      final server = threaded();
      final c = await openThread(tester, server);
      files(c).add([HarnessAttachment('a.png', _png)]);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('super-thread-also-send')));
      await tester.pump();

      await tester.tap(send);
      await tester.pumpAndSettle();

      final command = server.posts.single['command'] as Map;
      expect(command['text'], '');
      expect(command['alsoSend'], isTrue);
      expect(command['replyTo'], 'message-1');
      expect(command['attachmentIds'], ['attachment-1']);
    });

    testThread('the chat\'s own files do not go with a thread reply', (
      tester,
    ) async {
      final server = threaded();
      final c = await openThread(tester, server);
      c.attachments('lead').add([HarnessAttachment('chat.png', _png)]);
      files(c).add([HarnessAttachment('thread.png', _png)]);
      await tester.enterText(composer, 'Reply');
      await tester.pump();

      await tester.tap(send);
      await tester.pumpAndSettle();

      expect(server.uploads.map((u) => u['name']), ['thread.png']);
      expect(c.attachments('lead').files.map((f) => f.name), ['chat.png']);
    });

    testThread('a refused upload says so, keeps the reply and its files, and '
        'is not stuck uploading', (tester) async {
      final server = threaded()..failUpload = 'big.bin';
      final c = await openThread(tester, server);
      files(c).add([
        HarnessAttachment('big.bin', Uint8List.fromList([1])),
      ]);
      await tester.enterText(composer, 'Reply');
      await tester.pump();

      await tester.tap(send);
      await tester.pumpAndSettle();

      expect(server.posts, isEmpty);
      expect(c.uploading, isFalse);
      expect(names(c), ['big.bin']);
      expect(field(tester).text, 'Reply');
      expect(
        find.descendant(
          of: panel,
          matching: find.text('The file is too large.'),
        ),
        findsOneWidget,
      );
      // Taking the file off answers the refusal; the reply then goes alone.
      server.failUpload = null;
      files(c).remove(files(c).files.single);
      await tester.pump();
      expect(find.text('The file is too large.'), findsNothing);
      await tester.tap(send);
      await tester.pumpAndSettle();
      expect(
        (server.posts.single['command'] as Map).containsKey('attachmentIds'),
        isFalse,
      );
    });
  });

  group('privacy and lifecycle', () {
    test('each conversation\'s thread keeps its own files, even for the same '
        'root id', () {
      final c = ConversationServer().controller();
      addTearDown(c.dispose);
      final here = c.threadAttachments('lead', 'message-1');
      final there = c.threadAttachments('offline', 'message-1');
      expect(identical(here, there), isFalse);
      expect(identical(here, c.threadAttachments('lead', 'message-1')), isTrue);
      expect(identical(here, c.attachments('lead')), isFalse);
      here.add([
        HarnessAttachment('a.txt', Uint8List.fromList([1])),
      ]);
      expect(there.isEmpty, isTrue);
    });

    testThread('access revoked while a file is on its way: the files are '
        'forgotten and the answer sends nothing', (tester) async {
      final server = threaded();
      final reached = Completer<void>();
      final release = Completer<void>();
      final c = shown = server.controller(
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
              reached.complete();
              await release.future;
              // A transport stops when its upload is given up.
              if (cancel.isCancelled) throw StateError('given up');
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
      await c.refresh();
      addTearDown(c.dispose);
      await tester.binding.setSurfaceSize(const Size(1400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
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
      await tester.tap(line);
      await tester.pumpAndSettle();
      final held = files(c)..add([HarnessAttachment('a.png', _png)]);
      await tester.enterText(composer, 'Reply');
      await tester.pump();

      await tester.tap(send);
      await tester.pump();
      await reached.future;
      c.revokeAccess('No longer in this team');
      await tester.pump();
      release.complete();
      await tester.pumpAndSettle();

      expect(panel, findsNothing);
      expect(c.openedThread, isNull);
      expect(server.posts, isEmpty);
      // What was held for the thread went with the access.
      expect(
        identical(held, c.threadAttachments('lead', 'message-1')),
        isFalse,
      );
      expect(c.threadAttachments('lead', 'message-1').isEmpty, isTrue);
    });
  });
}
