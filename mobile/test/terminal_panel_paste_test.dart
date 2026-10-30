// NativeClipboard asks its channel only where a runner answers it, which a Windows host is not.
@TestOn('!windows')
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/terminal_paste.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'terminal_panel_fixture.dart';

/// A hardware keyboard's ⌘V (Ctrl+V on Android) and a right- or middle-click on the terminal, with
/// the pane's paste hooked up the way the phone's page hooks it: to `pasteClipboard`, the path the
/// on-screen Paste takes. They must do exactly what that Paste does — and never hand the far
/// machine a ⌃V, which pasted THAT machine's clipboard rather than this phone's.
///
/// Every other key stays the terminal's, as it was.
void main() {
  final phones = TargetPlatformVariant({
    TargetPlatform.iOS,
    TargetPlatform.android,
  });

  late AppNotifier notifier;
  late _Wire wire;
  late List<String> reports;
  late int hostPastes;

  setUp(() {
    notifier = panelNotifier();
    wire = _Wire();
    reports = [];
    hostPastes = 0;
  });

  tearDown(() => notifier.dispose());

  /// ⚠️ Built inside each test, never in `setUp`: the session's send queue is a Future, and one
  /// made outside the test's fake clock never drains in it.
  TerminalSession session({String engineId = 'claude'}) {
    final made = controllingSession(
      engineId: engineId,
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

  /// The machine the pane's agent runs on, as the phone knows it.
  void machine({bool pasteRaw = false, bool imagePaste = false}) {
    notifier.machineStates['m'] =
        MachineState(
            const Machine(
              machineId: 'm',
              authMode: MachineAuthMode.remote,
              name: 'Studio',
            ),
          )
          ..terminalPasteRawAvailable = pasteRaw
          ..terminalImagePasteAvailable = imagePaste;
  }

  /// A focused pane. [hosted] gives it the paste `TerminalPage._paste` gives it: the phone's own
  /// path, told whether the page still shows this terminal and where to say what happened.
  Future<void> pumpPanel(
    WidgetTester tester,
    TerminalSession pane, {
    bool hosted = true,
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
                notifier: notifier,
                session: pane,
                focused: true,
                onPaste: hosted
                    ? () {
                        hostPastes++;
                        unawaited(
                          pasteClipboard(
                            session: pane,
                            machine: notifier.stateOf(pane.machineId),
                            stillShowing: () => true,
                            report: reports.add,
                          ),
                        );
                      }
                    : null,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  /// [key] pressed with [modifiers] held, from a hardware keyboard on the phone the test runs as.
  Future<void> chord(
    WidgetTester tester,
    LogicalKeyboardKey key, [
    List<LogicalKeyboardKey> modifiers = const [],
  ]) async {
    final platform = defaultTargetPlatform == TargetPlatform.iOS
        ? 'ios'
        : 'android';
    for (final modifier in modifiers) {
      await tester.sendKeyDownEvent(modifier, platform: platform);
    }
    await tester.sendKeyEvent(key, platform: platform);
    for (final modifier in modifiers.reversed) {
      await tester.sendKeyUpEvent(modifier, platform: platform);
    }
    // Past the session's input coalescing, so every key is on the wire.
    await tester.pump(const Duration(milliseconds: 50));
  }

  /// The paste chord of the phone the test runs as: ⌘V on iOS, Ctrl+V on Android.
  Future<void> pasteChord(WidgetTester tester) =>
      chord(tester, LogicalKeyboardKey.keyV, [
        defaultTargetPlatform == TargetPlatform.iOS
            ? LogicalKeyboardKey.metaLeft
            : LogicalKeyboardKey.controlLeft,
      ]);

  /// A mouse or trackpad click on the terminal with [buttons], away from anything drawn over it.
  Future<void> click(WidgetTester tester, int buttons) async {
    final view = tester.getRect(find.byType(TerminalView));
    await tester.tapAt(
      view.topLeft + const Offset(40, 20),
      buttons: buttons,
      kind: PointerDeviceKind.mouse,
    );
    await tester.pump(const Duration(milliseconds: 50));
  }

  /// Lets the platform's image codec run until [done] holds. Decoding is real work on the engine's
  /// own threads, which the test's fake clock never waits for, so each turn steps out to the real
  /// clock and then pumps what came back.
  Future<void> decodeUntil(WidgetTester tester, bool Function() done) async {
    for (var turn = 0; turn < 200 && !done(); turn++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
    }
    expect(done(), isTrue, reason: 'the clipboard image was decoded');
  }

  group('⌘V (Ctrl+V on Android) pastes as the on-screen Paste does', () {
    testWidgets(
      'the text goes out as one paste, asked about before it is read',
      (tester) async {
        final clipboard = _Clipboard(tester)..text = 'git status';
        machine(pasteRaw: true);
        await pumpPanel(tester, session());

        await pasteChord(tester);

        expect(hostPastes, 1);
        expect(wire.pasted, ['git status']);
        expect(wire.input, isNot(contains('\x16')));
        expect(reports, isEmpty);
        // iOS answers `hasStrings` without its "Allow Paste" prompt, so the person is asked once,
        // for the one thing actually read.
        expect(clipboard.methods, [
          'Clipboard.hasStrings',
          'Clipboard.getData',
        ]);
      },
      variant: phones,
    );

    testWidgets('an image over the upload\'s ceiling is scaled down and sent', (
      tester,
    ) async {
      // What iOS hands over for a photo from the library: the image at its own size, past what
      // one upload takes. A real picture, padded past the ceiling with bytes a decoder skips.
      final clipboard = _Clipboard(tester)
        ..image = Uint8List.fromList([
          ..._onePixelPng,
          ...Uint8List(terminalLocalImagePasteMaxPayloadBytes + 1),
        ]);
      machine(imagePaste: true);
      await pumpPanel(tester, session());

      await pasteChord(tester);
      // Until the upload is asked for, or a key went out in its place.
      await decodeUntil(
        tester,
        () => wire.uploadBegin != null || wire.input.isNotEmpty,
      );

      expect(wire.input, isNot(contains('\x16')));
      expect(hostPastes, 1);
      expect(clipboard.imageReads, 1);
      expect(
        wire.uploadBegin!['totalBytes'],
        allOf(greaterThan(0), lessThan(clipboard.image!.length)),
      );
      expect(reports, isEmpty);
      // The upload's own wait for the machine to accept it runs out.
      await tester.pump(const Duration(seconds: 11));
    }, variant: phones);

    testWidgets(
      'an empty clipboard is said, and no ⌃V goes to the far machine',
      (tester) async {
        final clipboard = _Clipboard(tester);
        machine(imagePaste: true);
        await pumpPanel(tester, session());

        await pasteChord(tester);

        expect(wire.input, isNot(contains('\x16')));
        expect(wire.binaries, isEmpty, reason: 'no ⌃V, no paste');
        expect(hostPastes, 1);
        expect(reports, ['There is nothing on the clipboard to paste.']);
        expect(wire.uploadBegin, isNull);
        // No text, so the text was never read — and iOS never asked about it.
        expect(clipboard.methods, isNot(contains('Clipboard.getData')));
      },
      variant: phones,
    );

    testWidgets(
      'an image the phone cannot read is said, and no ⌃V goes instead',
      (tester) async {
        // What the native side answers for an image it found but could not re-encode.
        _Clipboard(tester).image = Uint8List(0);
        machine(imagePaste: true);
        await pumpPanel(tester, session());

        await pasteChord(tester);

        expect(wire.input, isNot(contains('\x16')));
        expect(wire.binaries, isEmpty);
        expect(reports, [
          "The clipboard's image isn't one this phone can read.",
        ]);
        expect(wire.uploadBegin, isNull);
      },
      variant: phones,
    );

    testWidgets(
      'bytes that are not a picture are said to be unreadable, not sent as '
      'they came',
      (tester) async {
        _Clipboard(tester).image = Uint8List.fromList([1, 2, 3, 4]);
        machine(imagePaste: true);
        await pumpPanel(tester, session());

        await pasteChord(tester);
        await decodeUntil(tester, () => reports.isNotEmpty);

        expect(reports, [
          "The clipboard's image isn't one this phone can read.",
        ]);
        expect(wire.uploadBegin, isNull);
        expect(wire.binaries, isEmpty);
      },
      variant: phones,
    );

    testWidgets('a plain shell is not offered the image, and no ⌃V either', (
      tester,
    ) async {
      final clipboard = _Clipboard(tester)..image = _onePixelPng;
      machine(imagePaste: true);
      await pumpPanel(tester, session(engineId: 'terminal'));

      await pasteChord(tester);

      // The CLI delivers an image by replaying ⌃V, which a shell reads as quoted-insert.
      expect(clipboard.imageReads, 0);
      expect(reports, ['There is no text on the clipboard.']);
      expect(wire.binaries, isEmpty);
      expect(wire.uploadBegin, isNull);
    }, variant: phones);

    testWidgets(
      'a terminal that reconnected during the read is not pasted into',
      (tester) async {
        final pane = session();
        _Clipboard(tester)
          ..text = 'git status'
          // The read waits on iOS's prompt, and the stream came back as another one meanwhile.
          ..onRead = () => pane.streamId = 's2';
        machine(pasteRaw: true);
        await pumpPanel(tester, pane);

        await pasteChord(tester);

        expect(wire.pasted, isEmpty);
        expect(reports, [pasteChangedMessage]);
      },
      variant: phones,
    );

    testWidgets(
      'a pane that cannot take input reads nothing and sends nothing',
      (tester) async {
        final clipboard = _Clipboard(tester)..text = 'git status';
        machine(pasteRaw: true);
        final pane = session();
        await pumpPanel(tester, pane);
        pane.status = TerminalSessionStatus.takenOver;

        await pasteChord(tester);

        // Not even read: asked, iOS would raise its "Allow Paste" prompt for a paste that could only
        // be refused. And the key is still taken, so xterm's own paste does not read it either.
        expect(hostPastes, 0);
        expect(clipboard.methods, isEmpty);
        expect(wire.binaries, isEmpty);
        expect(reports, isEmpty);
      },
      variant: phones,
    );
  });

  group('a right- or middle-click', () {
    testWidgets('with nothing selected pastes as ⌘V does', (tester) async {
      _Clipboard(tester).text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      await click(tester, kSecondaryMouseButton);

      expect(hostPastes, 1);
      expect(wire.pasted, ['git status']);
      expect(reports, isEmpty);
    }, variant: phones);

    testWidgets('with an empty clipboard says so, and sends no ⌃V', (
      tester,
    ) async {
      _Clipboard(tester);
      machine(imagePaste: true);
      await pumpPanel(tester, session());

      await click(tester, kSecondaryMouseButton);

      expect(wire.input, isNot(contains('\x16')));
      expect(wire.binaries, isEmpty);
      expect(hostPastes, 1);
      expect(reports, ['There is nothing on the clipboard to paste.']);
    }, variant: phones);

    testWidgets('a middle-click pastes the same way', (tester) async {
      _Clipboard(tester).text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      await click(tester, kMiddleMouseButton);

      expect(hostPastes, 1);
      expect(wire.pasted, ['git status']);
    }, variant: phones);

    testWidgets('with a selection copies it, and pastes nothing', (
      tester,
    ) async {
      final clipboard = _Clipboard(tester)..text = 'git status';
      machine(pasteRaw: true);
      final pane = session();
      pane.terminal.write('${'\r\n' * 30}npm test\r\nall 42 passed');
      await pumpPanel(tester, pane);
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      final buffer = pane.terminal.buffer;
      final row = buffer.lines.length - 1;
      view.controller!.setSelection(
        buffer.createAnchor(0, row),
        buffer.createAnchor(13, row),
      );
      await tester.pump();

      await click(tester, kSecondaryMouseButton);

      expect(clipboard.copied, 'all 42 passed');
      expect(view.controller!.selection, isNull);
      expect(hostPastes, 0);
      expect(wire.binaries, isEmpty);
    }, variant: phones);

    testWidgets(
      'on a pane with no paste of its host\'s, pastes only text, and never a ⌃V',
      (tester) async {
        final clipboard = _Clipboard(tester)..image = _onePixelPng;
        machine(pasteRaw: true, imagePaste: true);
        await pumpPanel(tester, session(), hosted: false);

        await click(tester, kSecondaryMouseButton);

        // No text: nothing at all — the image is the host's to send, and a ⌃V would read the far
        // machine's clipboard.
        expect(clipboard.imageReads, 0);
        expect(clipboard.methods, isNot(contains('Clipboard.getData')));
        expect(wire.binaries, isEmpty);
        expect(wire.uploadBegin, isNull);

        clipboard.text = 'git status';
        await click(tester, kSecondaryMouseButton);

        expect(wire.pasted, ['git status']);
      },
      variant: phones,
    );
  });

  group('every other key is the terminal\'s, as it was', () {
    testWidgets('Ctrl+C interrupts', (tester) async {
      final clipboard = _Clipboard(tester)..text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      await chord(tester, LogicalKeyboardKey.keyC, [
        LogicalKeyboardKey.controlLeft,
      ]);

      expect(wire.input, '\x03');
      expect(hostPastes, 0);
      expect(clipboard.methods, isEmpty);
    }, variant: phones);

    testWidgets('an arrow moves through the history', (tester) async {
      _Clipboard(tester).text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      await chord(tester, LogicalKeyboardKey.arrowUp);

      expect(wire.input, '\x1b[A');
      expect(hostPastes, 0);
    }, variant: phones);

    testWidgets('a bare V is a letter, typed through the keyboard', (
      tester,
    ) async {
      final clipboard = _Clipboard(tester)..text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      // A hardware letter is the keyboard's to type: the key goes by, and the text arrives through
      // the input connection.
      await chord(tester, LogicalKeyboardKey.keyV);
      final typed = '${tester.testTextInput.editingState!['text']}v';
      tester.testTextInput.updateEditingValue(
        TextEditingValue(
          text: typed,
          selection: TextSelection.collapsed(offset: typed.length),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      expect(wire.input, 'v');
      expect(wire.pasted, isEmpty);
      expect(hostPastes, 0);
      expect(clipboard.methods, isEmpty);
    }, variant: phones);

    testWidgets('⌘C (Ctrl+Shift+C on Android) copies the selection', (
      tester,
    ) async {
      final clipboard = _Clipboard(tester);
      machine(pasteRaw: true);
      final pane = session();
      pane.terminal.write('npm test');
      await pumpPanel(tester, pane);
      final buffer = pane.terminal.buffer;
      tester
          .widget<TerminalView>(find.byType(TerminalView))
          .controller!
          .setSelection(buffer.createAnchor(0, 0), buffer.createAnchor(8, 0));
      await tester.pump();

      await chord(
        tester,
        LogicalKeyboardKey.keyC,
        defaultTargetPlatform == TargetPlatform.iOS
            ? [LogicalKeyboardKey.metaLeft]
            : [LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.shiftLeft],
      );

      expect(clipboard.copied, 'npm test');
      expect(wire.binaries, isEmpty);
      expect(hostPastes, 0);
    }, variant: phones);

    testWidgets('⇧ with the paste chord is not this paste', (tester) async {
      _Clipboard(tester).text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      await chord(tester, LogicalKeyboardKey.keyV, [
        defaultTargetPlatform == TargetPlatform.iOS
            ? LogicalKeyboardKey.metaLeft
            : LogicalKeyboardKey.controlLeft,
        LogicalKeyboardKey.shiftLeft,
      ]);

      expect(hostPastes, 0);
      expect(wire.pasted, isEmpty);
    }, variant: phones);

    testWidgets("iOS's ⌃V is a keystroke for the far program, not a paste", (
      tester,
    ) async {
      final clipboard = _Clipboard(tester)..text = 'git status';
      machine(pasteRaw: true);
      await pumpPanel(tester, session());

      await chord(tester, LogicalKeyboardKey.keyV, [
        LogicalKeyboardKey.controlLeft,
      ]);

      // Typed on purpose — Claude Code reads it as its own image paste — so it goes as typed.
      expect(wire.input, '\x16');
      expect(hostPastes, 0);
      expect(clipboard.methods, isEmpty);
    }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));
  });
}

/// A 1x1 PNG, for an image the transcode can actually read.
final _onePixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// Everything the pane put on the wire.
class _Wire {
  final frames = <({String type, Map<String, dynamic> payload})>[];
  final binaries = <TerminalBinaryFrame>[];

  /// What was typed as input, as text.
  String get input => utf8.decode([
    for (final frame in binaries)
      if (frame.kind == TerminalBinaryKind.input) ...frame.bytes,
  ], allowMalformed: true);

  /// Each paste sent as one paste frame, as text.
  List<String> get pasted => [
    for (final frame in binaries)
      if (frame.kind == TerminalBinaryKind.paste) utf8.decode(frame.bytes),
  ];

  /// The announcement of an image upload, or null when none was asked for.
  Map<String, dynamic>? get uploadBegin {
    for (final frame in frames) {
      if (frame.type == 'terminal_chunked_upload_begin') return frame.payload;
    }
    return null;
  }
}

/// The phone's clipboard, both halves: the text Flutter's [Clipboard] reads, and the image the
/// native side reads (`harness/clipboard_image`). Records every clipboard call the pane makes.
class _Clipboard {
  _Clipboard(WidgetTester tester) {
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method.startsWith('Clipboard.')) methods.add(call.method);
      switch (call.method) {
        case 'Clipboard.setData':
          copied = (call.arguments as Map)['text'] as String?;
        // ⚠️ Typed `<String, dynamic>`: Flutter casts the reply to that, and a `Map<String, bool>`
        // fails the cast inside an unawaited paste — no paste, no message, no failure.
        case 'Clipboard.hasStrings':
          return <String, dynamic>{'value': text != null && text!.isNotEmpty};
        case 'Clipboard.getData':
          onRead?.call();
          return text == null ? null : {'text': text};
      }
      return null;
    });
    messenger.setMockMethodCallHandler(_imageChannel, (call) async {
      if (call.method != 'readImagePng') return null;
      imageReads++;
      return image;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(_imageChannel, null);
    });
  }

  static const _imageChannel = MethodChannel('harness/clipboard_image');

  /// Null for a clipboard with no text.
  String? text;

  /// The image as the native side answers it: null for none, empty for one it could not read.
  Uint8List? image;

  /// Runs while the text is being read — the window in which iOS can be showing its prompt.
  void Function()? onRead;

  /// What was copied onto the clipboard, if anything.
  String? copied;

  final methods = <String>[];
  int imageReads = 0;
}
