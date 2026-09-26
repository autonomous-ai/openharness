// NativeClipboard asks its channel only where a runner answers it, which a Windows host is not.
@TestOn('!windows')
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/terminal_paste.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'terminal_panel_fixture.dart';

/// The terminal actions sheet's Paste, without the page around it: what it reads off the
/// clipboard, which way it sends it, and when it refuses to send at all.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  late List<TerminalBinaryFrame> frames;
  late List<String> reports;
  late TerminalSession session;
  late MachineState machine;
  late List<String> sentTypes;

  const imageChannel = MethodChannel('harness/clipboard_image');

  /// A 1x1 PNG, for an image the transcode can actually read.
  final onePixelPng = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  );

  /// The image on the clipboard as the native side answers it: null for none, empty for one it
  /// could not read. [onRead] runs during the read.
  void clipboardImage(Uint8List? bytes, {void Function()? onRead}) {
    messenger.setMockMethodCallHandler(imageChannel, (call) async {
      if (call.method != 'readImagePng') return null;
      onRead?.call();
      return bytes;
    });
  }

  /// The clipboard as Flutter's [Clipboard] sees it. [onRead] runs while the text is being read,
  /// the window in which iOS can be showing its paste prompt.
  void clipboardHolds(String? text, {void Function()? onRead}) {
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      switch (call.method) {
        case 'Clipboard.hasStrings':
          return {'value': text != null && text.isNotEmpty};
        case 'Clipboard.getData':
          onRead?.call();
          return text == null ? null : {'text': text};
      }
      return null;
    });
  }

  Future<void> paste({bool Function()? stillShowing}) => pasteClipboard(
    session: session,
    machine: machine,
    stillShowing: stillShowing ?? () => true,
    report: reports.add,
  );

  setUp(() {
    frames = [];
    reports = [];
    sentTypes = [];
    session = controllingSession(
      send: (type, _) async {
        sentTypes.add(type);
        return true;
      },
      sendBinary: (frame) async {
        frames.add(frame);
        return true;
      },
    );
    machine = MachineState(
      const Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'Test host',
      ),
    );
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(SystemChannels.platform, null);
    messenger.setMockMethodCallHandler(imageChannel, null);
  });

  test('text goes out as one paste frame where the CLI knows it', () async {
    machine.terminalPasteRawAvailable = true;
    clipboardHolds('hello');

    await paste();

    expect(reports, isEmpty);
    expect(frames.map((f) => f.kind), [TerminalBinaryKind.paste]);
    expect(String.fromCharCodes(frames.single.bytes), 'hello');
  });

  test("text goes through xterm's own paste on an older CLI", () async {
    clipboardHolds('hello');

    await paste();
    // Typed input rides the session's send tail, a microtask or two behind.
    await pumpEventQueue();

    expect(reports, isEmpty);
    expect(frames, isNotEmpty);
    expect(frames.map((f) => f.kind), everyElement(TerminalBinaryKind.input));
  });

  test('an empty clipboard is said, not sent', () async {
    machine.terminalPasteRawAvailable = true;
    clipboardHolds(null);
    clipboardImage(null);

    await paste();

    expect(frames, isEmpty);
    expect(reports, ['There is nothing on the clipboard to paste.']);
  });

  test('a plain shell is never offered the image', () async {
    session =
        TerminalSession(
            machineId: 'm',
            agentId: 'a',
            agentName: 'Shell',
            engineId: 'terminal',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 's';
    clipboardHolds(null);
    var asked = false;
    clipboardImage(onePixelPng, onRead: () => asked = true);

    await paste();

    expect(asked, isFalse);
    expect(reports, ['There is no text on the clipboard.']);
  });

  test('an image the phone could not read is said to be unreadable', () async {
    machine.terminalImagePasteAvailable = true;
    clipboardHolds(null);
    clipboardImage(Uint8List(0));

    await paste();

    expect(sentTypes, isEmpty);
    expect(reports, ["The clipboard's image isn't one this phone can read."]);
  });

  test('bytes that are not a picture are unreadable too', () async {
    machine.terminalImagePasteAvailable = true;
    clipboardHolds(null);
    clipboardImage(Uint8List.fromList([1, 2, 3, 4]));

    await paste();

    expect(sentTypes, isEmpty);
    expect(reports, ["The clipboard's image isn't one this phone can read."]);
  });

  test('an older CLI is told it cannot take the image', () async {
    clipboardHolds(null);
    clipboardImage(onePixelPng);

    await paste();

    expect(sentTypes, isEmpty);
    expect(reports, ["This machine's harness is too old to receive images."]);
  });

  test('an image goes out as an upload', () async {
    machine.terminalImagePasteAvailable = true;
    clipboardHolds(null);
    clipboardImage(onePixelPng);

    // Nothing answers the upload's begin here, so only that it was asked for is checked.
    unawaited(paste());
    await pumpEventQueue();

    expect(sentTypes, contains('terminal_chunked_upload_begin'));
    expect(reports, isEmpty);
  });

  test('a stream that changed during the image read gets no upload', () async {
    machine.terminalImagePasteAvailable = true;
    clipboardHolds(null);
    clipboardImage(onePixelPng, onRead: () => session.streamId = 's2');

    await paste();

    expect(sentTypes, isEmpty);
    expect(reports, [pasteChangedMessage]);
  });

  test('a stream that changed during the read is not pasted into', () async {
    machine.terminalPasteRawAvailable = true;
    // Reconnected while the prompt was up: same session, a different stream.
    clipboardHolds('hello', onRead: () => session.streamId = 's2');

    await paste();

    expect(frames, isEmpty);
    expect(reports, [pasteChangedMessage]);
  });

  test('a page no longer showing this session is not pasted into', () async {
    machine.terminalPasteRawAvailable = true;
    var showing = true;
    clipboardHolds('hello', onRead: () => showing = false);

    await paste(stillShowing: () => showing);

    expect(frames, isEmpty);
    expect(reports, [pasteChangedMessage]);
  });

  test('a stream taken over during the read is not pasted into', () async {
    machine.terminalPasteRawAvailable = true;
    clipboardHolds(
      'hello',
      onRead: () => session.status = TerminalSessionStatus.takenOver,
    );

    await paste();

    expect(frames, isEmpty);
    expect(reports, [pasteChangedMessage]);
  });
}
