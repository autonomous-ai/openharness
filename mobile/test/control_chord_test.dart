import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/control_chord.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

void main() {
  test('a letter takes its place in the control block, in either case', () {
    expect(controlChordFor('c'), '\x03');
    expect(controlChordFor('C'), '\x03');
    expect(controlChordFor('a'), '\x01');
    expect(controlChordFor('z'), '\x1a');
  });

  test('so does the punctuation the block actually covers', () {
    expect(controlChordFor('['), '\x1b'); // Ctrl+[ IS Escape
    expect(controlChordFor('@'), '\x00');
    expect(controlChordFor(' '), '\x00'); // set-mark, in readline and emacs
    expect(controlChordFor('?'), '\x7f');
  });

  test('anything no chord names is refused rather than mangled', () {
    expect(controlChordFor(''), isNull);
    expect(controlChordFor('hi'), isNull); // an IME commit, not a keystroke
    expect(controlChordFor('é'), isNull);
    expect(controlChordFor('😀'), isNull);
  });

  group('an armed session', () {
    const streamId = '00112233-4455-6677-8899-aabbccddeeff';
    late List<({String type, Map<String, dynamic> payload})> sent;
    late List<TerminalBinaryFrame> binarySent;
    late TerminalSession session;

    setUp(() {
      sent = [];
      binarySent = [];
      session = TerminalSession(
        machineId: 'machine-1',
        agentId: 'agent-1',
        agentName: 'backend-api',
        engineId: 'claude',
        send: (type, payload) async {
          sent.add((type: type, payload: Map<String, dynamic>.from(payload)));
          return true;
        },
        sendBinary: (frame) async {
          binarySent.add(frame);
          return true;
        },
      );
    });

    tearDown(() => session.dispose());

    /// Input opens on the first KEYFRAME, not on the ready frame: until a
    /// screen has arrived there is nothing to type into.
    Future<void> ready() async {
      await session.open(initialCols: 100, initialRows: 30);
      await session.handleFrame('terminal_ready', {
        'requestId': sent.single.payload['requestId'],
        'protocolVersion': 3,
        'streamId': streamId,
        'agentId': 'agent-1',
      });
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: streamId,
          seq: 0,
          bytes: Uint8List.fromList(utf8.encode('prompt> ')),
          compressed: false,
          cols: 100,
          rows: 30,
        ),
      );
      expect(session.acceptsInput, isTrue);
    }

    /// Typing is batched behind a short window; this waits it out.
    Future<String> typed(String text) async {
      binarySent.clear();
      session.terminal.textInput(text);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      return binarySent.map((frame) => utf8.decode(frame.bytes)).join();
    }

    test('sends the next character as a chord, then disarms', () async {
      await ready();

      session.armControl(true);
      expect(await typed('c'), '\x03');
      expect(session.controlArmed, isFalse);

      // The one after it is ordinary text again — a phone `ctrl` is a key
      // pressed once, not a modifier anyone can keep held down.
      expect(await typed('c'), 'c');
    });

    test('spends the modifier even on a keystroke it cannot translate', () async {
      await ready();

      session.armControl(true);
      // An IME commit, not a keystroke. Left alone, and the modifier goes with
      // it rather than lying in wait for a later character.
      expect(await typed('hôm'), 'hôm');
      expect(session.controlArmed, isFalse);
    });
  });
}
