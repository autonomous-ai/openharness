import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shortcuts/app_shortcuts.dart' show kTerminalOwnedKeys;
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show key;
import 'swarm_state_test.dart' show createApp;

TerminalSession liveSession(
  String id,
  List<TerminalBinaryFrame> frames, {
  String engine = 'terminal',
  List<String>? controls,
}) =>
    TerminalSession(
        machineId: 'm',
        agentId: id,
        agentName: id,
        engineId: engine,
        send: (type, _) async {
          controls?.add(type);
          return true;
        },
        sendBinary: (frame) async {
          frames.add(frame);
          return true;
        },
      )
      ..status = TerminalSessionStatus.controlling
      ..streamId = 'stream-$id';

String input(List<TerminalBinaryFrame> frames) => utf8.decode([
  for (final frame in frames)
    if (frame.kind == TerminalBinaryKind.input) ...frame.bytes,
]);

Future<void> mount(
  WidgetTester tester,
  AppNotifier app,
  TerminalSession session, {
  bool readOnly = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: TerminalPanel(
          notifier: app,
          session: session,
          focused: true,
          readOnly: readOnly,
        ),
      ),
    ),
  );
  await tester.pump();
}

void onPlatform(
  TargetPlatform platform,
  String description,
  Future<void> Function(WidgetTester) body,
) {
  testWidgets(description, body, variant: TargetPlatformVariant.only(platform));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  String? clipboard;
  Future<Object?> Function()? readClipboard;
  var reads = 0;
  const imageChannel = MethodChannel('harness/clipboard_image');
  setUp(() {
    clipboard = 'clipboard text';
    reads = 0;
    readClipboard = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          switch (call.method) {
            case 'Clipboard.getData':
              reads++;
              return readClipboard == null
                  ? (clipboard == null ? null : {'text': clipboard})
                  : readClipboard!();
            case 'Clipboard.setData':
              clipboard = (call.arguments as Map)['text'] as String?;
          }
          return null;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(imageChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    onPlatform(
      platform,
      '$platform preserves shell control keys and pastes only on the clipboard chord',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.terminalPasteRawAvailable = true;
        final frames = <TerminalBinaryFrame>[];
        final session = liveSession('a0', frames);
        await mount(tester, app, session);
        for (final letter in [
          LogicalKeyboardKey.keyA,
          LogicalKeyboardKey.keyB,
          LogicalKeyboardKey.keyC,
          LogicalKeyboardKey.keyD,
          LogicalKeyboardKey.keyR,
          LogicalKeyboardKey.keyV,
          LogicalKeyboardKey.keyZ,
        ]) {
          await key(tester, letter, ctrl: true);
        }
        await tester.pump(const Duration(milliseconds: 20));
        expect(input(frames).codeUnits, [1, 2, 3, 4, 18, 22, 26]);
        expect(
          reads,
          0,
          reason: 'Readline, Vim, and tmux keep their control chords',
        );
        frames.clear();
        clipboard = 'first line\nsecond line\tλ';
        await key(
          tester,
          LogicalKeyboardKey.keyV,
          cmd: platform == TargetPlatform.macOS,
          ctrl: platform == TargetPlatform.linux,
          shift: platform == TargetPlatform.linux,
        );
        await tester.pump(const Duration(milliseconds: 20));
        expect(reads, 1);
        expect(
          frames.where((f) => f.kind == TerminalBinaryKind.paste),
          hasLength(1),
        );
        expect(utf8.decode(frames.single.bytes), clipboard);
        expect(frames.single.streamId, session.streamId);
        expect(input(frames), isEmpty);
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  onPlatform(
    TargetPlatform.macOS,
    'a delayed clipboard read cannot paste into a replacement agent',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.terminalPasteRawAvailable = true;
      final originalFrames = <TerminalBinaryFrame>[];
      final nextFrames = <TerminalBinaryFrame>[];
      final original = liveSession('a0', originalFrames);
      final next = liveSession('a1', nextFrames);
      final read = Completer<Object?>();
      readClipboard = () => read.future;
      await mount(tester, app, original);
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      expect(reads, 1);
      await mount(tester, app, next);
      read.complete({'text': 'original agent only'});
      await tester.pump(const Duration(milliseconds: 20));
      expect(originalFrames, isEmpty);
      expect(nextFrames, isEmpty);
      await tester.pumpWidget(const SizedBox());
      original.dispose();
      next.dispose();
      app.dispose();
    },
  );

  onPlatform(
    TargetPlatform.macOS,
    'empty clipboard does not send quoted-insert into a shell',
    (tester) async {
      final app = createApp();
      final frames = <TerminalBinaryFrame>[];
      final session = liveSession('a0', frames);
      clipboard = '';
      await mount(tester, app, session);
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(reads, 1);
      expect(frames, isEmpty);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );
  for (final change in ['read only', 'reconnected', 'closed pane']) {
    onPlatform(
      TargetPlatform.macOS,
      'pending paste is cancelled after $change',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.terminalPasteRawAvailable = true;
        final frames = <TerminalBinaryFrame>[];
        final session = liveSession('a0', frames);
        final read = Completer<Object?>();
        readClipboard = () => read.future;
        await mount(tester, app, session);
        await key(tester, LogicalKeyboardKey.keyV, cmd: true);
        if (change == 'read only') {
          await mount(tester, app, session, readOnly: true);
        } else if (change == 'reconnected') {
          session.streamId = 'replacement-stream';
        } else {
          await tester.pumpWidget(const SizedBox());
        }
        read.complete({'text': 'old request'});
        await tester.pump(const Duration(milliseconds: 20));
        expect(frames, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    onPlatform(
      platform,
      '$platform copies selected output even in a read-only pane',
      (tester) async {
        final app = createApp();
        final frames = <TerminalBinaryFrame>[];
        final session = liveSession('a0', frames);
        await session.handleBinary(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.keyframe,
            streamId: session.streamId!,
            seq: 0,
            compressed: false,
            cols: 80,
            rows: 24,
            bytes: utf8.encode('hello world'),
          ),
        );
        await mount(tester, app, session, readOnly: true);
        final controller = tester
            .widget<TerminalView>(find.byType(TerminalView))
            .controller!;
        controller.setSelection(
          session.terminal.buffer.createAnchor(0, 0),
          session.terminal.buffer.createAnchor(5, 0),
        );
        final apple = platform == TargetPlatform.macOS;
        await key(
          tester,
          LogicalKeyboardKey.keyC,
          cmd: apple,
          ctrl: !apple,
          shift: !apple,
        );
        expect(clipboard, 'hello');
        await key(
          tester,
          LogicalKeyboardKey.keyV,
          cmd: apple,
          ctrl: !apple,
          shift: !apple,
        );
        await tester.pump(const Duration(milliseconds: 20));
        expect(reads, 0, reason: 'A read-only pane cannot initiate paste');
        expect(frames, isEmpty);
        expect(
          kTerminalOwnedKeys.firstWhere((item) => item.label == 'Paste').chord,
          apple ? ['⌘', 'V'] : ['⌃', '⇧', 'V'],
        );
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  onPlatform(
    TargetPlatform.macOS,
    'older daemons retain bracketed paste and clear the old selection',
    (tester) async {
      final app = createApp();
      final frames = <TerminalBinaryFrame>[];
      final session = liveSession('a0', frames);
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: session.streamId!,
          seq: 0,
          compressed: false,
          cols: 80,
          rows: 24,
          bytes: utf8.encode('hello world\x1b[?2004h'),
        ),
      );
      await mount(tester, app, session);
      final controller = tester
          .widget<TerminalView>(find.byType(TerminalView))
          .controller!;
      controller.setSelection(
        session.terminal.buffer.createAnchor(0, 0),
        session.terminal.buffer.createAnchor(5, 0),
      );
      clipboard = 'α = 2';
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(frames), '\x1b[200~α = 2\x1b[201~');
      expect(controller.selection, isNull);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );

  onPlatform(
    TargetPlatform.macOS,
    'clipboard failure stays local and allows another paste',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.terminalPasteRawAvailable = true;
      final frames = <TerminalBinaryFrame>[];
      final session = liveSession('a0', frames);
      readClipboard = () async =>
          throw PlatformException(code: 'fixture-read-failed');
      await mount(tester, app, session);
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump();
      expect(
        find.text('Could not read the clipboard. Try Paste again.'),
        findsOneWidget,
      );
      expect(frames, isEmpty);
      expect(session.acceptsInput, isTrue);
      readClipboard = null;
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(utf8.decode(frames.single.bytes), clipboard);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );
  onPlatform(
    TargetPlatform.linux,
    'Linux Alt chords preserve case and punctuation while AltGr composes',
    (tester) async {
      final app = createApp();
      final frames = <TerminalBinaryFrame>[];
      final session = liveSession('a0', frames);
      await mount(tester, app, session);
      for (final stroke in [
        (LogicalKeyboardKey.keyB, 'b', false),
        (LogicalKeyboardKey.keyF, 'f', false),
        (LogicalKeyboardKey.keyB, 'B', true),
        (LogicalKeyboardKey.period, '.', false),
        (LogicalKeyboardKey.digit2, '2', false),
      ]) {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        if (stroke.$3) {
          await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        }
        await tester.sendKeyEvent(stroke.$1, character: stroke.$2);
        if (stroke.$3) {
          await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        }
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
      }
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(frames), '\x1bb\x1bf\x1bB\x1b.\x1b2');
      frames.clear();
      // Events without a printable character use the session's input handler.
      session.terminal.keyInput(TerminalKey.keyF, alt: true);
      session.terminal.keyInput(TerminalKey.keyF, alt: true, shift: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(frames), '\x1bf\x1bF');
      frames.clear();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.altRight);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyQ, character: '@');
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altRight);
      tester.testTextInput.enterText('@');
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(frames), '@');
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );
  onPlatform(
    TargetPlatform.macOS,
    'delayed image reads cannot upload into a replacement agent',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.terminalImagePasteAvailable = true;
      final oldFrames = <TerminalBinaryFrame>[];
      final nextFrames = <TerminalBinaryFrame>[];
      final controls = <String>[];
      final original = liveSession(
        'a0',
        oldFrames,
        engine: 'claude',
        controls: controls,
      );
      final next = liveSession(
        'a1',
        nextFrames,
        engine: 'claude',
        controls: controls,
      );
      final imageRead = Completer<Uint8List?>();
      var imageReads = 0;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(imageChannel, (call) async {
            imageReads++;
            return imageRead.future;
          });
      clipboard = null;
      await mount(tester, app, original);
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      expect(imageReads, 1);
      await mount(tester, app, next);
      imageRead.complete(Uint8List.fromList([137, 80, 78, 71]));
      await tester.pump(const Duration(milliseconds: 20));
      expect(
        controls.where((type) => type == 'terminal_chunked_upload_begin'),
        isEmpty,
      );
      expect(oldFrames, isEmpty);
      expect(nextFrames, isEmpty);
      await tester.pumpWidget(const SizedBox());
      original.dispose();
      next.dispose();
      app.dispose();
    },
  );

  onPlatform(
    TargetPlatform.linux,
    'Linux clipboard chord preserves remote image upload',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.terminalImagePasteAvailable = true;
      final frames = <TerminalBinaryFrame>[];
      final controls = <String>[];
      final session = liveSession(
        'a0',
        frames,
        engine: 'claude',
        controls: controls,
      );
      final png = Uint8List.fromList([137, 80, 78, 71]);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(imageChannel, (_) async => png);
      clipboard = null;
      await mount(tester, app, session);
      await key(tester, LogicalKeyboardKey.keyV, ctrl: true, shift: true);
      expect(controls, contains('terminal_chunked_upload_begin'));
      await session.handleFrame('terminal_chunked_upload_begin_result', {
        'streamId': session.streamId,
        'accepted': true,
      });
      await tester.pump();
      expect(frames, hasLength(1));
      expect(frames.single.kind, TerminalBinaryKind.imagePaste);
      expect(frames.single.bytes, png);
      await session.handleFrame('terminal_paste_image_result', {
        'streamId': session.streamId,
        'outcome': 'clipboard',
      });
      await tester.pump();
      expect(session.uploadProgress, isNull);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );
}
