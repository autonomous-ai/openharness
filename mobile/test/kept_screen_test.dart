import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

/// Back to an agent read a moment ago: its last screen shows at once, and the
/// live stream's first keyframe replaces it.
void main() {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';

  TerminalSession newSession(List<Map<String, dynamic>> sent) =>
      TerminalSession(
        machineId: 'machine-1',
        agentId: 'agent-1',
        agentName: 'backend-api',
        engineId: 'claude',
        send: (type, payload) async {
          sent.add(Map<String, dynamic>.from(payload));
          return true;
        },
        sendBinary: (_) async => true,
      );

  String screenText(Terminal terminal) =>
      terminal.buffer.lines.toList().map((line) => line.toString()).join('\n');

  test('a kept screen stands in until the keyframe replaces it', () async {
    final sent = <Map<String, dynamic>>[];
    final session = newSession(sent);
    addTearDown(session.dispose);
    final kept = Terminal(maxLines: 100)
      ..write('what the agent said last time');

    expect(session.hasScreen, isFalse);
    session.seedScreen(kept);
    expect(session.hasScreen, isTrue);
    expect(session.showingKeptScreen, isTrue);
    expect(session.hasRenderedFrame, isFalse);
    expect(identical(session.terminal, kept), isTrue);

    await session.open(initialCols: 100, initialRows: 30);
    await session.handleFrame('terminal_ready', {
      'requestId': sent.single['requestId'],
      'protocolVersion': 3,
      'streamId': streamId,
      'agentId': 'agent-1',
    });
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 0,
        bytes: Uint8List.fromList(utf8.encode('live now')),
        compressed: false,
        cols: 100,
        rows: 30,
      ),
    );

    expect(session.showingKeptScreen, isFalse);
    expect(session.hasRenderedFrame, isTrue);
    expect(identical(session.terminal, kept), isFalse);
    expect(screenText(session.terminal), contains('live now'));
  });

  test('a session already showing its stream keeps it', () async {
    final sent = <Map<String, dynamic>>[];
    final session = newSession(sent);
    addTearDown(session.dispose);
    await session.open(initialCols: 100, initialRows: 30);
    await session.handleFrame('terminal_ready', {
      'requestId': sent.single['requestId'],
      'protocolVersion': 3,
      'streamId': streamId,
      'agentId': 'agent-1',
    });
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 0,
        bytes: Uint8List.fromList(utf8.encode('live')),
        compressed: false,
        cols: 100,
        rows: 30,
      ),
    );
    final live = session.terminal;
    session.seedScreen(Terminal(maxLines: 100)..write('stale'));
    expect(identical(session.terminal, live), isTrue);
    expect(session.showingKeptScreen, isFalse);
  });
}
