import 'dart:async';
import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/remote_media_download.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_link_opener.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'terminal_panel_fixture.dart';

/// The terminal the phone's Focus page hosts, driven the ways a phone drives
/// it: a keyframe swapping the screen under it, a long press and Copy, a
/// keyboard handing over a picture, a thumb on a link, reading back through
/// the history while the agent keeps writing.
///
/// Everything the pane puts on the wire is recorded; nothing leaves the test.
/// Output above what a test aims at, so it sits at the foot of the screen —
/// the part a view at its end shows.
final _blank = '\r\n' * 30;

class _Wire {
  final frames = <({String type, Map<String, dynamic> payload})>[];
  final binaries = <TerminalBinaryFrame>[];

  List<String> get types => [for (final frame in frames) frame.type];

  /// What was typed or pasted as input, as text.
  String get input => utf8.decode([
    for (final frame in binaries)
      if (frame.kind == TerminalBinaryKind.input) ...frame.bytes,
  ], allowMalformed: true);

  List<TerminalBinaryFrame> ofKind(TerminalBinaryKind kind) => [
    for (final frame in binaries)
      if (frame.kind == kind) frame,
  ];
}

/// The machine the pane's agent runs on, as the phone knows it.
MachineState _machine(
  AppNotifier notifier, {
  bool pasteRaw = false,
  bool imagePaste = false,
}) {
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Studio',
  );
  return notifier.machineStates['m'] = MachineState(machine)
    ..terminalPasteRawAvailable = pasteRaw
    ..terminalImagePasteAvailable = imagePaste;
}

/// Everything the platform channel was asked, and a clipboard to paste from.
class _Platform {
  _Platform(WidgetTester tester) {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        calls.add(call);
        switch (call.method) {
          case 'Clipboard.setData':
            copied = (call.arguments as Map)['text'] as String?;
          case 'Clipboard.getData':
            return clipboard == null ? null : {'text': clipboard};
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
  }

  final calls = <MethodCall>[];
  String? clipboard;
  String? copied;
}

/// A download that finishes when the test says so.
class _Downloader extends RemoteMediaDownloader {
  final result = Completer<String>();
  void Function(RemoteMediaProgress)? progress;
  MediaDownloadCancellation? cancellation;
  Object? readError;

  @override
  Future<String> download({
    required ReadRemoteMediaChunk readChunk,
    required MediaDownloadCancellation cancellation,
    required void Function(RemoteMediaProgress) onProgress,
  }) {
    progress = onProgress;
    // The real downloader reads the far machine chunk by chunk through the
    // notifier; asking once proves the pane hands it the right reader.
    readChunk(offset: 0).then<void>(
      (_) {},
      onError: (Object error) {
        readError = error;
      },
    );
    this.cancellation = cancellation;
    return result.future;
  }
}

void main() {
  late AppNotifier notifier;
  late _Wire wire;

  /// ⚠️ Built inside each test, never in `setUp`: the session's send queue is
  /// a Future, and one made outside the test's fake clock never drains in it.
  TerminalSession session() {
    final made = controllingSession(
      send: (type, payload) async {
        wire.frames.add((type: type, payload: payload));
        return true;
      },
      sendBinary: (frame) async {
        wire.binaries.add(frame);
        return true;
      },
    );
    addTearDown(made.dispose);
    return made;
  }

  setUp(() {
    notifier = panelNotifier();
    wire = _Wire();
  });

  tearDown(() => notifier.dispose());

  Future<void> pumpPanel(
    WidgetTester tester,
    TerminalSession session, {
    bool focused = false,
    bool visible = true,
    ValueNotifier<({int above, int total})?>? scrollback,
    bool Function(String line)? onLineTap,
    VoidCallback? onInputTap,
    TerminalLinkOpener? linkOpener,
    RemoteMediaDownloader? mediaDownloader,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 400,
              height: 320,
              child: TerminalPanel(
                key: const ValueKey('pane'),
                notifier: notifier,
                session: session,
                focused: focused,
                visible: visible,
                scrollback: scrollback,
                onLineTap: onLineTap,
                onInputTap: onInputTap,
                linkOpener: linkOpener,
                mediaDownloader: mediaDownloader,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  TerminalView view(WidgetTester tester) =>
      tester.widget<TerminalView>(find.byType(TerminalView));

  /// The rendered row height — `RenderTerminal` itself is not exported.
  double lineHeight(WidgetTester tester) => tester
      .state<TerminalViewState>(find.byType(TerminalView))
      .renderTerminal
      .lineHeight;

  ScrollPosition scroll(WidgetTester tester) => tester
      .state<ScrollableState>(
        find.descendant(
          of: find.byType(TerminalView),
          matching: find.byType(Scrollable),
        ),
      )
      .position;

  /// The centre of the cell [offset] characters into the last line showing
  /// [text], in global coordinates — where a thumb on it lands.
  Offset cellOf(
    WidgetTester tester,
    TerminalSession session,
    String text, {
    int offset = 0,
  }) {
    final buffer = session.terminal.buffer;
    var row = buffer.lines.length - 1;
    while (row >= 0 && !buffer.lines[row].getText().contains(text)) {
      row--;
    }
    expect(row, greaterThanOrEqualTo(0), reason: '"$text" is on screen');
    final column = buffer.lines[row].getText().indexOf(text) + offset;
    final terminal = tester
        .state<TerminalViewState>(find.byType(TerminalView))
        .renderTerminal;
    final size = terminal.cellSize;
    // Rows are counted from the top of the buffer, which a view at its end has
    // scrolled past.
    return terminal.localToGlobal(
      Offset(
        (column + 0.5) * size.width,
        (row + 0.5) * terminal.lineHeight - scroll(tester).pixels,
      ),
    );
  }

  /// The machine's screen, whole — what a keyframe carries — and the ack the
  /// session owes for it, so no timer is left running.
  Future<void> keyframe(
    WidgetTester tester,
    TerminalSession session,
    int seq,
    String text,
  ) async {
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: 's',
        seq: seq,
        bytes: Uint8List.fromList(utf8.encode(text)),
        compressed: false,
        cols: 40,
        rows: 12,
      ),
    );
    // One frame to take the new screen in, then long enough for the ack and
    // the resize that frame asks for to go out.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
  }

  String lines(int count, {int from = 0}) =>
      [for (var i = from; i < from + count; i++) 'history line $i']
          .join('\r\n');

  group('a keyframe swapping the screen', () {
    testWidgets('reaches the view though nothing above the pane rebuilds', (
      tester,
    ) async {
      final pane = session();
      await pumpPanel(tester, pane);
      await keyframe(tester, pane, 0, 'the first screen');
      await tester.pump();
      expect(identical(view(tester).terminal, pane.terminal), isTrue);

      // What the daemon sends after every resize — so after every keyboard
      // the phone raises or lowers. Status, first frame and agent are all as
      // they were, so the host has nothing of its own to rebuild for.
      await keyframe(tester, pane, 1, 'the screen after the resize');
      await tester.pump();
      await tester.pump();

      expect(identical(view(tester).terminal, pane.terminal), isTrue);
      expect(
        view(tester).terminal.buffer.lines[0].getText(),
        startsWith('the screen after the resize'),
      );
    });

    testWidgets('keeps a reader at the end at the end', (tester) async {
      final pane = session();
      await pumpPanel(tester, pane);
      await keyframe(tester, pane, 0, lines(100));
      await tester.pump();
      await tester.pump();

      await keyframe(tester, pane, 1, lines(120));
      await tester.pump();
      await tester.pump();

      final position = scroll(tester);
      expect(position.pixels, position.maxScrollExtent);
    });

    testWidgets('keeps a reader in the history on the line they were reading', (
      tester,
    ) async {
      final pane = session();
      await pumpPanel(tester, pane);
      await keyframe(tester, pane, 0, lines(100));
      await tester.pump();
      await tester.pump();
      await tester.drag(find.byType(TerminalView), const Offset(0, 300));
      await tester.pump();
      final rowHeight = lineHeight(tester);
      int topRow() => (scroll(tester).pixels / rowHeight).floor();
      final reading = view(tester).terminal.buffer.lines[topRow()].getText();
      expect(reading, startsWith('history line'));

      // The same history and twenty more lines under it.
      await keyframe(tester, pane, 1, lines(120));
      await tester.pump();
      await tester.pump();

      expect(
        view(tester).terminal.buffer.lines[topRow()].getText(),
        reading,
        reason: 'the screen moved under the reader, not the reader',
      );
      expect(scroll(tester).pixels, lessThan(scroll(tester).maxScrollExtent));
    });

    testWidgets('keeps a selection whose text is still there', (tester) async {
      final pane = session();
      await pumpPanel(tester, pane);
      await keyframe(tester, pane, 0, lines(8));
      await tester.pump();
      final before = view(tester).terminal.buffer;
      view(tester).controller!
          .setSelection(before.createAnchor(0, 2), before.createAnchor(14, 2));
      await tester.pump();
      expect(find.text('Copy'), findsOneWidget);

      await keyframe(tester, pane, 1, lines(8));
      await tester.pump();
      await tester.pump();

      final selection = view(tester).controller!.selection;
      expect(selection, isNotNull);
      expect(view(tester).terminal.buffer.getText(selection), 'history line 2');
    });

    testWidgets('lets a selection go when its text is not', (tester) async {
      final pane = session();
      await pumpPanel(tester, pane);
      await keyframe(tester, pane, 0, lines(8));
      await tester.pump();
      final before = view(tester).terminal.buffer;
      view(tester).controller!
          .setSelection(before.createAnchor(0, 2), before.createAnchor(14, 2));
      await tester.pump();

      await keyframe(tester, pane, 1, lines(8, from: 50));
      await tester.pump();
      await tester.pump();

      expect(view(tester).controller!.selection, isNull);
      expect(find.text('Copy'), findsNothing);
    });
  });

  group('a long press, then Copy', () {
    testWidgets('copies what is selected and lets it go', (tester) async {
      final platform = _Platform(tester);
      final pane = session();
      pane.terminal.write('npm test\r\nall 42 passed');
      await pumpPanel(tester, pane);
      final buffer = pane.terminal.buffer;
      view(tester).controller!
          .setSelection(buffer.createAnchor(0, 1), buffer.createAnchor(13, 1));
      await tester.pump();

      await tester.tap(find.text('Copy'));
      await tester.pump();

      expect(platform.copied, 'all 42 passed');
      expect(view(tester).controller!.selection, isNull);
      expect(find.text('Copy'), findsNothing);
      expect(
        platform.calls.map((c) => c.method),
        contains('HapticFeedback.vibrate'),
      );
    });

    testWidgets('× lets it go without copying', (tester) async {
      final platform = _Platform(tester);
      final pane = session();
      pane.terminal.write('npm test');
      await pumpPanel(tester, pane);
      final buffer = pane.terminal.buffer;
      view(tester).controller!
          .setSelection(buffer.createAnchor(0, 0), buffer.createAnchor(3, 0));
      await tester.pump();

      await tester.tap(find.bySemanticsLabel('Clear selection'));
      await tester.pump();

      expect(platform.copied, isNull);
      expect(view(tester).controller!.selection, isNull);
    });
  });

  group('a hardware keyboard\'s ⌘V', () {
    Future<void> commandV(WidgetTester tester, {bool shift = false}) async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      // Past the session's input coalescing, so every key is on the wire.
      await tester.pump(const Duration(milliseconds: 50));
    }

    testWidgets(
      'pastes the clipboard as one paste where the machine takes one',
      (tester) async {
        final platform = _Platform(tester)..clipboard = 'git status';
        _machine(notifier, pasteRaw: true);
        final pane = session();
        await pumpPanel(tester, pane, focused: true);
        await tester.pump();

        await commandV(tester);

        final pasted = wire.ofKind(TerminalBinaryKind.paste);
        expect(pasted, hasLength(1));
        expect(utf8.decode(pasted.single.bytes), 'git status');
        expect(
          platform.calls.map((c) => c.method),
          contains('Clipboard.getData'),
        );
      },
      variant: TargetPlatformVariant.only(TargetPlatform.iOS),
    );

    testWidgets('types it where the machine is older', (tester) async {
      _Platform(tester).clipboard = 'git status';
      _machine(notifier);
      final pane = session();
      await pumpPanel(tester, pane, focused: true);
      await tester.pump();

      await commandV(tester);

      expect(wire.ofKind(TerminalBinaryKind.paste), isEmpty);
      expect(wire.input, contains('git status'));
    }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

    testWidgets(
      'an empty clipboard hands the agent its own ⌃V, to read a picture itself',
      (tester) async {
        _Platform(tester);
        // What the image reader answers on a phone: nothing, at once. The
        // test host is a Mac, where it would ask a channel nobody answers.
        const images = MethodChannel('harness/clipboard_image');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          images,
          (_) async => null,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            images,
            null,
          ),
        );
        _machine(notifier, imagePaste: true);
        final pane = session();
        await pumpPanel(tester, pane, focused: true);
        await tester.pump();

        await commandV(tester);

        expect(wire.input, '\x16');
      },
      variant: TargetPlatformVariant.only(TargetPlatform.iOS),
    );

    testWidgets(
      '⇧⌘V is a different verb, and a pane that cannot type pastes nothing',
      (tester) async {
        _Platform(tester).clipboard = 'git status';
        _machine(notifier, pasteRaw: true);
        final pane = session();
        await pumpPanel(tester, pane, focused: true);
        await tester.pump();

        await commandV(tester, shift: true);
        expect(wire.ofKind(TerminalBinaryKind.paste), isEmpty);

        pane.status = TerminalSessionStatus.takenOver;
        await commandV(tester);
        expect(wire.ofKind(TerminalBinaryKind.paste), isEmpty);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.iOS),
    );
  });

  group('a picture from the keyboard', () {
    /// What Gboard does with a picture from its own clipboard: hands the bytes
    /// straight to the field that is typing.
    Future<void> insertImage(WidgetTester tester, List<int> bytes) async {
      final client = tester.testTextInput.log
          .lastWhere((call) => call.method == 'TextInput.setClient')
          .arguments[0];
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        SystemChannels.textInput.name,
        SystemChannels.textInput.codec.encodeMethodCall(
          MethodCall('TextInputClient.performAction', [
            client,
            'TextInputAction.commitContent',
            {
              'mimeType': 'image/png',
              'uri': 'content://gboard/1',
              'data': bytes,
            },
          ]),
        ),
        (_) {},
      );
      await tester.pump();
    }

    testWidgets('goes up as an upload, with a bar that can cancel it', (
      tester,
    ) async {
      _machine(notifier, imagePaste: true);
      final pane = session();
      await pumpPanel(tester, pane, focused: true);
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);

      await insertImage(tester, [0x89, 0x50, 0x4e, 0x47]);

      expect(wire.types, contains('terminal_chunked_upload_begin'));
      expect(find.text('Uploading image · 0%'), findsOneWidget);

      await tester.tap(find.text('CANCEL'));
      await tester.pump();
      expect(wire.types, contains('terminal_chunked_upload_cancel'));
      expect(find.textContaining('Uploading'), findsNothing);
      // The upload's own wait for the machine to accept it runs out.
      await tester.pump(const Duration(seconds: 11));
    }, variant: TargetPlatformVariant.only(TargetPlatform.android));

    testWidgets(
      'goes nowhere a machine cannot take it, or when there is nothing in it',
      (tester) async {
        final machine = _machine(notifier);
        final pane = session();
        await pumpPanel(tester, pane, focused: true);
        await tester.pump();

        await insertImage(tester, [0x89, 0x50, 0x4e, 0x47]);
        machine.terminalImagePasteAvailable = true;
        await insertImage(tester, const []);
        pane.status = TerminalSessionStatus.takenOver;
        await insertImage(tester, [0x89, 0x50, 0x4e, 0x47]);

        expect(wire.types, isNot(contains('terminal_chunked_upload_begin')));
        expect(pane.uploadProgress, isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.android),
    );
  });

  group('reading back through the history', () {
    testWidgets('says where the reader is, and follows new output under them', (
      tester,
    ) async {
      final position = ValueNotifier<({int above, int total})?>(null);
      addTearDown(position.dispose);
      final pane = session();
      pane.terminal.write(lines(200));
      await pumpPanel(tester, pane, scrollback: position);
      await tester.pump();
      expect(position.value, isNull, reason: 'at the end there is no position');

      await tester.drag(find.byType(TerminalView), const Offset(0, 200));
      await tester.pump();
      final read = position.value!;
      expect(read.above, greaterThan(0));
      expect(
        read.total,
        pane.terminal.buffer.lines.length - pane.terminal.viewHeight,
      );

      // Five more lines land below the reader: the view holds still, and the
      // count of lines beneath it grows by five.
      pane.outputTicks.value++;
      pane.terminal.write('\r\n${lines(5, from: 200)}');
      await tester.pump();
      await tester.pump();
      expect(position.value!.above, read.above + 5);
      expect(position.value!.total, read.total + 5);

      await tester.drag(find.byType(TerminalView), const Offset(0, -5000));
      await tester.pump();
      expect(position.value, isNull);
    });

    testWidgets('a new agent in the same pane starts at its end', (
      tester,
    ) async {
      final position = ValueNotifier<({int above, int total})?>(null);
      addTearDown(position.dispose);
      final first = session();
      first.terminal.write(lines(200));
      await pumpPanel(tester, first, scrollback: position);
      await tester.drag(find.byType(TerminalView), const Offset(0, 200));
      await tester.pump();
      expect(position.value, isNotNull);
      view(tester).controller!.setSelection(
        first.terminal.buffer.createAnchor(0, 1),
        first.terminal.buffer.createAnchor(4, 1),
      );

      final second = session()..terminal.write('another agent');
      await pumpPanel(tester, second, scrollback: position);
      await tester.pump();

      expect(identical(view(tester).terminal, second.terminal), isTrue);
      expect(position.value, isNull);
      expect(view(tester).controller!.selection, isNull);
      expect(scroll(tester).pixels, scroll(tester).maxScrollExtent);
    });
  });

  group('a thumb on the output', () {
    testWidgets('a row the host takes is not a prompt tap', (tester) async {
      final tapped = <String>[];
      var inputTaps = 0;
      final pane = session();
      pane.terminal.write('$_blank❯ 1. Yes\r\n  2. No');
      await pumpPanel(
        tester,
        pane,
        onLineTap: (line) {
          tapped.add(line.trimRight());
          return line.contains('Yes');
        },
        onInputTap: () => inputTaps++,
      );

      await tester.tapAt(cellOf(tester, pane, '1. Yes'));
      await tester.pump(kDoubleTapTimeout);

      expect(tapped, ['❯ 1. Yes']);
      expect(inputTaps, 0);
    });

    testWidgets('a link opens on a tap alone — a phone has no ⌘ to hold', (
      tester,
    ) async {
      final launched = <Uri>[];
      final pane = session();
      pane.terminal.write('${_blank}docs at https://example.com/guide today');
      await pumpPanel(
        tester,
        pane,
        linkOpener: TerminalLinkOpener(
          launch: (uri) async {
            launched.add(uri);
            return false;
          },
        ),
      );

      await tester.tapAt(cellOf(tester, pane, 'https://', offset: 4));
      await tester.pump(kDoubleTapTimeout);
      await tester.pump();

      expect(launched, [Uri.parse('https://example.com/guide')]);
      // The OS said no: the person is told, not left tapping.
      expect(
        find.textContaining('Could not open this preview'),
        findsOneWidget,
      );
    }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

    testWidgets(
      'a picture on the far machine is fetched with a bar, then opened',
      (tester) async {
        final launched = <Uri>[];
        final downloader = _Downloader();
        final pane = session();
        pane.terminal.write('${_blank}saved /work/shot.png');
        await pumpPanel(
          tester,
          pane,
          mediaDownloader: downloader,
          linkOpener: TerminalLinkOpener(
            launch: (uri) async {
              launched.add(uri);
              return true;
            },
            fileExists: (_) async => true,
          ),
        );

        await tester.tapAt(cellOf(tester, pane, '/work/shot.png', offset: 3));
        await tester.pump(kDoubleTapTimeout);
        await tester.pump();
        expect(find.text('Preparing preview…'), findsOneWidget);

        // This phone knows no such machine, so the notifier refuses the read
        // with a sentence rather than a crash.
        expect(downloader.readError, isA<RemoteMediaException>());
        downloader.progress!(const RemoteMediaProgress('shot.png', 50, 100));
        await tester.pump();
        expect(find.text('Downloading shot.png · 50%'), findsOneWidget);

        downloader.result.complete('/tmp/preview/shot.png');
        await tester.pump();
        await tester.pump();

        expect(launched, [Uri.file('/tmp/preview/shot.png')]);
        expect(find.textContaining('Downloading'), findsNothing);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.iOS),
    );

    testWidgets('a fetch cancelled from its bar opens nothing', (tester) async {
      final launched = <Uri>[];
      final downloader = _Downloader();
      final pane = session();
      pane.terminal.write('${_blank}saved /work/shot.png');
      await pumpPanel(
        tester,
        pane,
        mediaDownloader: downloader,
        linkOpener: TerminalLinkOpener(
          launch: (uri) async {
            launched.add(uri);
            return true;
          },
          fileExists: (_) async => true,
        ),
      );
      await tester.tapAt(cellOf(tester, pane, '/work/shot.png', offset: 3));
      await tester.pump(kDoubleTapTimeout);
      await tester.pump();

      await tester.tap(find.text('CANCEL'));
      expect(downloader.cancellation!.isCancelled, isTrue);
      downloader.result.complete('/tmp/preview/shot.png');
      await tester.pump();
      await tester.pump();

      expect(launched, isEmpty);
      expect(find.textContaining('preview'), findsNothing);
    }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));
  });

  group('a pane nobody is looking at yet', () {
    testWidgets('measures itself for the open, and nothing more', (
      tester,
    ) async {
      // The pager attaches the agents either side of the one on screen ahead
      // of a swipe: their stream is not open, and the open waits on a size.
      final pane = TerminalSession(
        machineId: 'm',
        agentId: 'a',
        agentName: 'Agent',
        engineId: 'claude',
        send: (type, payload) async {
          wire.frames.add((type: type, payload: payload));
          return true;
        },
        sendBinary: (_) async => true,
      );
      await pumpPanel(tester, pane, visible: false);
      await tester.pump();

      unawaited(pane.open(waitForViewportSize: true));
      await tester.pump();

      final open = wire.frames.singleWhere((f) => f.type == 'terminal_open');
      // The measured grid — clamped to the far shell's floor — not the
      // 80×24 an open that waited two seconds for nothing would fall back to.
      expect(open.payload['cols'], TerminalSession.minCols);
      expect(open.payload['rows'], isNot(24));
      expect(wire.types, isNot(contains('terminal_resize')));

      await tester.pumpWidget(const SizedBox());
      pane.dispose();
    });
  });

  group('settings and focus', () {
    testWidgets('a new terminal font reaches the view and re-measures it', (
      tester,
    ) async {
      final original = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = original);
      // Small enough that both grids clear the far shell's 40-column floor.
      terminalFontStore.value = original.copyWith(fontSize: 6);
      final pane = session();
      await pumpPanel(tester, pane);
      await tester.pump(const Duration(milliseconds: 100));
      int askedCols() =>
          wire.frames
                  .lastWhere((f) => f.type == 'terminal_resize')
                  .payload['cols']
              as int;
      final cols = askedCols();

      terminalFontStore.value = original.copyWith(fontSize: 8);
      await tester.pump();
      await tester.pump();

      expect(view(tester).textStyle.fontSize, 8);
      // Bigger type, fewer columns: the far shell is asked for the new grid.
      await tester.pump(const Duration(milliseconds: 100));
      expect(askedCols(), lessThan(cols));
    });

    testWidgets('a new colour scheme repaints the view', (tester) async {
      final original = terminalThemeStore.value;
      addTearDown(() => terminalThemeStore.value = original);
      final pane = session();
      await pumpPanel(tester, pane);
      final before = view(tester).theme;

      terminalThemeStore.value = TerminalThemeChoice.values.firstWhere(
        (choice) => choice != original,
      );
      await tester.pump();

      expect(view(tester).theme, isNot(same(before)));
    });

    testWidgets('the page on screen holds the keyboard; a parked one lets go', (
      tester,
    ) async {
      final pane = session();
      await pumpPanel(tester, pane, focused: true);
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);

      await pumpPanel(tester, pane, focused: false, visible: false);
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isFalse);

      await pumpPanel(tester, pane, focused: true);
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);
    });

    testWidgets('the cursor blinks only while the keyboard is on it', (
      tester,
    ) async {
      final pane = session();
      await pumpPanel(tester, pane, focused: true);
      await tester.pump();
      expect(pane.terminal.cursorVisibleMode, isTrue);

      await tester.pump(const Duration(milliseconds: 500));
      expect(pane.terminal.cursorVisibleMode, isFalse);
      await tester.pump(const Duration(milliseconds: 500));
      expect(pane.terminal.cursorVisibleMode, isTrue);
      await tester.pump(const Duration(milliseconds: 500));
      expect(pane.terminal.cursorVisibleMode, isFalse);

      // Into a pocket: the clock stops, and the cursor is left showing.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(pane.terminal.cursorVisibleMode, isTrue);
      await tester.pump(const Duration(seconds: 2));
      expect(pane.terminal.cursorVisibleMode, isTrue);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      await pumpPanel(tester, pane, focused: false, visible: false);
      await tester.pump(const Duration(seconds: 2));
      expect(pane.terminal.cursorVisibleMode, isTrue);
    });
  });
}
