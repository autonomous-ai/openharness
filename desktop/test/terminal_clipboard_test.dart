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
  bool composerVisible = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: TerminalPanel(
          notifier: app,
          session: session,
          focused: true,
          readOnly: readOnly,
          composerVisible: composerVisible,
          onToggleComposer: composerVisible ? () {} : null,
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
            case 'Clipboard.hasStrings':
              return {'value': clipboard?.isNotEmpty ?? false};
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

  for (final letter in [LogicalKeyboardKey.keyC, LogicalKeyboardKey.keyV]) {
    onPlatform(
      TargetPlatform.windows,
      'held $letter owns repeats and release',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.terminalPasteRawAvailable = true;
        final frames = <TerminalBinaryFrame>[];
        final session = liveSession('a0', frames);
        session.terminal.write('hello');
        await mount(tester, app, session);
        final view = tester.widget<TerminalView>(find.byType(TerminalView));
        if (letter == LogicalKeyboardKey.keyC) {
          view.controller!.setSelection(
            session.terminal.buffer.createAnchor(0, 0),
            session.terminal.buffer.createAnchor(5, 0),
          );
        }
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyDownEvent(letter);
        await tester.pump();
        await tester.sendKeyRepeatEvent(letter);
        // Ownership lasts even if the modifier is released before the letter.
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyRepeatEvent(letter);
        await tester.sendKeyUpEvent(letter);
        await tester.pump(const Duration(milliseconds: 20));
        expect(input(frames), isEmpty);
        expect(reads, letter == LogicalKeyboardKey.keyV ? 1 : 0);
        expect(
          frames.where((f) => f.kind == TerminalBinaryKind.paste),
          hasLength(letter == LogicalKeyboardKey.keyV ? 1 : 0),
        );
        frames.clear();
        await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
        await tester.pump(const Duration(milliseconds: 20));
        expect(input(frames), '\x03');
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  onPlatform(
    TargetPlatform.windows,
    'held copy cannot interrupt a replacement session',
    (tester) async {
      final app = createApp();
      final originalFrames = <TerminalBinaryFrame>[];
      final nextFrames = <TerminalBinaryFrame>[];
      final original = liveSession('a0', originalFrames);
      final next = liveSession('a1', nextFrames);
      original.terminal.write('hello');
      await mount(tester, app, original);
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      view.controller!.setSelection(
        original.terminal.buffer.createAnchor(0, 0),
        original.terminal.buffer.createAnchor(5, 0),
      );
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.keyC);
      await tester.pump();
      await mount(tester, app, next);
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.keyC);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.keyC);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(originalFrames), isEmpty);
      expect(input(nextFrames), isEmpty);
      await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(nextFrames), '\x03');
      await tester.pumpWidget(const SizedBox());
      original.dispose();
      next.dispose();
      app.dispose();
    },
  );

  for (final releaseAway in [false, true]) {
    onPlatform(
      TargetPlatform.windows,
      'copy gesture focus return releaseAway=$releaseAway',
      (tester) async {
        final app = createApp();
        final frames = <TerminalBinaryFrame>[];
        final session = liveSession('a0', frames);
        session.terminal.write('hello');
        await mount(tester, app, session, composerVisible: true);
        final view = tester.widget<TerminalView>(find.byType(TerminalView));
        view.focusNode!.requestFocus();
        await tester.pump();
        view.controller!.setSelection(
          session.terminal.buffer.createAnchor(0, 0),
          session.terminal.buffer.createAnchor(5, 0),
        );
        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.keyC);
        await tester.pump();
        tester
            .widget<TextField>(find.byType(TextField))
            .focusNode!
            .requestFocus();
        await tester.pump();
        if (releaseAway) await tester.sendKeyUpEvent(LogicalKeyboardKey.keyC);
        view.focusNode!.requestFocus();
        await tester.pump();
        if (releaseAway) {
          await tester.sendKeyDownEvent(LogicalKeyboardKey.keyC);
        } else {
          await tester.sendKeyRepeatEvent(LogicalKeyboardKey.keyC);
        }
        await tester.sendKeyUpEvent(LogicalKeyboardKey.keyC);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await tester.pump(const Duration(milliseconds: 20));
        expect(input(frames), releaseAway ? '\x03' : isEmpty);
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  onPlatform(
    TargetPlatform.windows,
    'held composer Ctrl+V uploads one image without changing the draft',
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
      await mount(tester, app, session, composerVisible: true);
      await tester.enterText(find.byType(TextField), 'draft with an image');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.keyV);
      await tester.pump();
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(
        controls.where((c) => c == 'terminal_chunked_upload_begin'),
        hasLength(1),
      );
      await session.handleFrame('terminal_chunked_upload_begin_result', {
        'streamId': session.streamId,
        'accepted': true,
      });
      await tester.pump();
      expect(frames, hasLength(1));
      expect(frames.single.kind, TerminalBinaryKind.imagePaste);
      expect(frames.single.bytes, png);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'draft with an image',
      );
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

  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.linux,
    TargetPlatform.windows,
  ]) {
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
          if (platform != TargetPlatform.windows) LogicalKeyboardKey.keyV,
          LogicalKeyboardKey.keyZ,
        ]) {
          await key(tester, letter, ctrl: true);
        }
        await tester.pump(const Duration(milliseconds: 20));
        expect(input(frames).codeUnits, [
          1,
          2,
          3,
          4,
          18,
          if (platform != TargetPlatform.windows) 22,
          26,
        ]);
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
          ctrl: platform != TargetPlatform.macOS,
          shift: platform != TargetPlatform.macOS,
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

  for (final selection in [
    (
      name: 'a selection',
      output: 'hello world',
      endX: 5,
      endY: 0,
      text: 'hello',
    ),
    (
      name: 'only spaces selected',
      output: '   ',
      endX: 3,
      endY: 0,
      text: '   ',
    ),
    (
      name: 'a selection ending on an empty line',
      output: 'hello\r\n',
      endX: 0,
      endY: 1,
      text: 'hello\n',
    ),
  ]) {
    onPlatform(
      TargetPlatform.windows,
      'Ctrl+C with ${selection.name} copies and sends nothing',
      (tester) async {
        final app = createApp();
        final frames = <TerminalBinaryFrame>[];
        final session = liveSession('a0', frames);
        session.terminal.write(selection.output);
        await mount(tester, app, session);
        final controller = tester
            .widget<TerminalView>(find.byType(TerminalView))
            .controller!;
        controller.setSelection(
          session.terminal.buffer.createAnchor(0, 0),
          session.terminal.buffer.createAnchor(selection.endX, selection.endY),
        );
        await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
        await tester.pump(const Duration(milliseconds: 20));
        expect(clipboard, selection.text);
        expect(controller.selection, isNull);
        expect(frames, isEmpty);
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  onPlatform(TargetPlatform.windows, 'Ctrl+C without a selection sends ^C', (
    tester,
  ) async {
    final app = createApp();
    final frames = <TerminalBinaryFrame>[];
    final session = liveSession('a0', frames);
    await mount(tester, app, session);
    await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
    await tester.pump(const Duration(milliseconds: 20));
    expect(input(frames), '\x03');
    expect(clipboard, 'clipboard text');
    expect(reads, 0);
    await tester.pumpWidget(const SizedBox());
    session.dispose();
    app.dispose();
  });

  onPlatform(
    TargetPlatform.windows,
    'Ctrl+V pastes text as Ctrl+Shift+V does',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.terminalPasteRawAvailable = true;
      final frames = <TerminalBinaryFrame>[];
      final session = liveSession('a0', frames);
      await mount(tester, app, session);
      for (final shift in [false, true]) {
        frames.clear();
        clipboard = 'first line\nsecond line\tλ';
        await key(tester, LogicalKeyboardKey.keyV, ctrl: true, shift: shift);
        await tester.pump(const Duration(milliseconds: 20));
        expect(frames, hasLength(1));
        expect(frames.single.kind, TerminalBinaryKind.paste);
        expect(utf8.decode(frames.single.bytes), 'first line\nsecond line\tλ');
        expect(frames.single.streamId, session.streamId);
        expect(input(frames), isEmpty);
      }
      expect(reads, 2);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );

  onPlatform(
    TargetPlatform.windows,
    'a pane this window does not control: Ctrl+C copies a selection, Ctrl+V behaves as Ctrl+Shift+V does',
    (tester) async {
      final app = createApp();
      final frames = <TerminalBinaryFrame>[];
      final controls = <String>[];
      final session = liveSession('a0', frames, controls: controls);
      session.terminal.write('hello world');
      session.status = TerminalSessionStatus.takenOver;
      await mount(tester, app, session);
      expect(find.widgetWithText(FilledButton, 'Take control'), findsOneWidget);
      final controller = tester
          .widget<TerminalView>(find.byType(TerminalView))
          .controller!;
      controller.setSelection(
        session.terminal.buffer.createAnchor(0, 0),
        session.terminal.buffer.createAnchor(5, 0),
      );
      await key(tester, LogicalKeyboardKey.keyC, ctrl: true);
      expect(clipboard, 'hello');
      expect(controller.selection, isNull);
      for (final shift in [false, true]) {
        await key(tester, LogicalKeyboardKey.keyV, ctrl: true, shift: shift);
      }
      await tester.pump(const Duration(milliseconds: 20));
      expect(
        reads,
        0,
        reason: 'A pane controlled elsewhere cannot initiate paste',
      );
      expect(frames, isEmpty);
      expect(controls, isNot(contains('terminal_open')));
      expect(session.status, TerminalSessionStatus.takenOver);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );

  onPlatform(
    TargetPlatform.macOS,
    'macOS keeps Command copy and paste and sends Ctrl+V to the program',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.terminalPasteRawAvailable = true;
      final frames = <TerminalBinaryFrame>[];
      final session = liveSession('a0', frames);
      session.terminal.write('hello world');
      await mount(tester, app, session);
      final controller = tester
          .widget<TerminalView>(find.byType(TerminalView))
          .controller!;
      controller.setSelection(
        session.terminal.buffer.createAnchor(0, 0),
        session.terminal.buffer.createAnchor(5, 0),
      );
      await key(tester, LogicalKeyboardKey.keyC, cmd: true);
      expect(clipboard, 'hello');
      expect(frames, isEmpty);
      clipboard = 'Mac paste';
      await key(tester, LogicalKeyboardKey.keyV, cmd: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(frames.single.kind, TerminalBinaryKind.paste);
      expect(utf8.decode(frames.single.bytes), 'Mac paste');
      frames.clear();
      await key(tester, LogicalKeyboardKey.keyV, ctrl: true);
      await tester.pump(const Duration(milliseconds: 20));
      expect(input(frames), '\x16');
      expect(reads, 1);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      app.dispose();
    },
  );

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
      read.complete({'text': 'original harness only'});
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

  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.linux,
    TargetPlatform.windows,
  ]) {
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
          apple ? ['⌘', 'V'] : ['Ctrl', 'Shift', 'V'],
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

  for (final engine in ['claude', 'codex']) {
    for (final shift in [false, true]) {
      onPlatform(
        TargetPlatform.windows,
        'local Windows $engine image paste (Shift=$shift) delivers image bytes instead of Ctrl+V',
        (tester) async {
          final app = createApp();
          app.stateOf('m')!
            ..localOnly = true
            ..terminalImagePasteAvailable = true;
          final frames = <TerminalBinaryFrame>[];
          final controls = <String>[];
          final session = liveSession(
            'a0',
            frames,
            engine: engine,
            controls: controls,
          );
          final png = Uint8List.fromList([137, 80, 78, 71]);
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .setMockMethodCallHandler(imageChannel, (_) async => png);
          clipboard = null;
          await mount(tester, app, session);
          await key(tester, LogicalKeyboardKey.keyV, ctrl: true, shift: shift);
          expect(input(frames), isEmpty);
          expect(
            controls.where((c) => c == 'terminal_chunked_upload_begin'),
            hasLength(1),
          );
          await session.handleFrame('terminal_chunked_upload_begin_result', {
            'streamId': session.streamId,
            'accepted': true,
          });
          await tester.pump();
          expect(frames.single.kind, TerminalBinaryKind.imagePaste);
          expect(frames.single.bytes, png);
          await session.handleFrame('terminal_paste_image_result', {
            'streamId': session.streamId,
            'outcome': 'fallback_path',
          });
          await tester.pump();
          expect(session.uploadProgress, isNull);
          await tester.pumpWidget(const SizedBox());
          session.dispose();
          app.dispose();
        },
      );
    }
  }

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    onPlatform(
      platform,
      '$platform local image paste keeps the engine clipboard shortcut',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!
          ..localOnly = true
          ..terminalImagePasteAvailable = true;
        final frames = <TerminalBinaryFrame>[];
        final controls = <String>[];
        final session = liveSession(
          'a0',
          frames,
          engine: 'claude',
          controls: controls,
        );
        clipboard = null;
        await mount(tester, app, session);
        await key(
          tester,
          LogicalKeyboardKey.keyV,
          cmd: platform == TargetPlatform.macOS,
          ctrl: platform == TargetPlatform.linux,
          shift: platform == TargetPlatform.linux,
        );
        await tester.pump(const Duration(milliseconds: 20));
        expect(input(frames), '\x16');
        expect(controls, isNot(contains('terminal_chunked_upload_begin')));
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }

  for (final (platform, shift) in [
    (TargetPlatform.linux, true),
    (TargetPlatform.windows, false),
    (TargetPlatform.windows, true),
  ]) {
    onPlatform(
      platform,
      '$platform clipboard chord (Shift=$shift) preserves remote image upload',
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
        if (platform == TargetPlatform.windows) {
          await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
          if (shift) {
            await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
          }
          await tester.sendKeyDownEvent(LogicalKeyboardKey.keyV);
          await tester.pump();
          await tester.sendKeyRepeatEvent(LogicalKeyboardKey.keyV);
          await tester.sendKeyUpEvent(LogicalKeyboardKey.keyV);
          if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
          await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
          await tester.pump();
        } else {
          await key(tester, LogicalKeyboardKey.keyV, ctrl: true, shift: shift);
        }
        expect(
          controls.where((c) => c == 'terminal_chunked_upload_begin'),
          hasLength(1),
        );
        expect(input(frames), isEmpty);
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
}
