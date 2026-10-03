import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';

void main() {
  const stream = '00112233-4455-6677-8899-aabbccddeeff';
  late TerminalSession session;
  late List<TerminalBinaryFrame> frames;
  late List<({String type, Map<String, dynamic> payload})> messages;

  setUp(() {
    frames = [];
    messages = [];
    session = TerminalSession(
      machineId: 'machine',
      agentId: 'shared-session',
      agentName: 'Codex',
      engineId: 'codex',
      now: () => DateTime(2026, 9, 28),
      send: (type, payload) async {
        messages.add((type: type, payload: payload));
        return true;
      },
      sendBinary: (frame) async {
        frames.add(frame);
        return true;
      },
    );
  });
  tearDown(() => session.dispose());

  Future<void> ready({bool scoped = true}) async {
    await session.open(initialCols: 100, initialRows: 30);
    await session.handleFrame('terminal_ready', {
      'requestId': messages.single.payload['requestId'],
      'protocolVersion': 3,
      'streamId': stream,
      'agentId': 'shared-session',
      'swarmInput': scoped,
    });
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: stream,
        seq: 0,
        bytes: Uint8List(0),
        compressed: false,
        cols: 100,
        rows: 30,
      ),
    );
  }

  test('a shared session captures each view’s origin before coalescing and async sends', () async {
    await ready();
    session.inputTabId = 'swarm-a';
    session.terminal.textInput('first');
    session.terminal.textInput(' second');
    session.inputTabId = 'swarm-b';
    session.terminal.textInput(' third');
    session.inputTabId =
        'swarm-c'; // Looking elsewhere never retargets pending bytes.
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final input = frames
        .where((frame) => frame.kind == TerminalBinaryKind.input)
        .toList();
    expect(input.map((frame) => frame.tabId), [
      'swarm-a',
      'swarm-a',
      'swarm-b',
    ]);
    expect(
      input.map((frame) => utf8.decode(frame.bytes)).join(),
      'first second third',
    );
    expect(input.map((frame) => frame.seq), [0, 1, 2]);
  });

  test('composer and delayed clipboard submissions carry their explicit source pane', () async {
    await ready();
    session.inputTabId = 'swarm-b';
    await session.sendComposerText('task from A', tabId: 'swarm-a');
    expect(messages.last.payload, containsPair('tabId', 'swarm-a'));
    await session.pasteText('clipboard from A', tabId: 'swarm-a');
    expect(frames.last.tabId, 'swarm-a');
    expect(session.inputTabId, 'swarm-b');
  });

  test('older daemons receive the original binary format', () async {
    await ready(scoped: false);
    session.inputTabId = 'swarm-a';
    session.terminal.textInput('hello');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(
      frames.where((f) => f.kind == TerminalBinaryKind.input).single.tabId,
      isNull,
    );
  });

  test('scoped local input matches the CLI wire fixture and rejects truncated metadata', () {
    final encoded = encodeTerminalLocal(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.input,
        streamId: stream,
        seq: 3,
        bytes: Uint8List.fromList(utf8.encode('xin chào\r')),
        compressed: false,
        tabId: 'swarm-a',
      ),
    )!;
    expect(
      encoded.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
      '4854524c010102000000002a00112233445566778899aabbccddeeff000000000000000307737761726d2d6178696e206368c3a06f0d',
    );
    expect(decodeTerminalLocal(encoded)?.tabId, 'swarm-a');
    encoded[36] = 129;
    expect(decodeTerminalLocal(encoded), isNull);
  });
}
