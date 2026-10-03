import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/wire_counter.dart';
import 'package:harness/e2ee/primitives.dart';
import 'package:harness/e2ee/terminal_cipher.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';

void main() {
  const stream = '00112233-4455-6677-8899-aabbccddeeff';

  test('wire counters retain exact bytes across 32-bit boundaries', () {
    const vectors = {
      0: [0, 0, 0, 0, 0, 0, 0, 0],
      4294967295: [0, 0, 0, 0, 255, 255, 255, 255],
      4294967296: [0, 0, 0, 1, 0, 0, 0, 0],
      4294967297: [0, 0, 0, 1, 0, 0, 0, 1],
      maxSafeInteger: [0, 31, 255, 255, 255, 255, 255, 255],
    };
    for (final entry in vectors.entries) {
      final data = ByteData(8);
      writeWireCounter(data, 0, entry.key);
      expect(data.buffer.asUint8List(), entry.value);
      expect(readWireCounter(data, 0), entry.key);
      expect(counterNonce(entry.key), [...entry.value, 0, 0, 0, 0]);
    }
    final unsafe = ByteData(8)..setUint32(0, 0x200000);
    expect(readWireCounter(unsafe, 0), isNull);
    expect(() => counterNonce(maxSafeInteger + 1), throwsRangeError);
    expect(() => counterNonce(-1), throwsRangeError);
  });

  test('encrypted terminal bytes preserve large sequence and nonce values', () {
    final key = List<int>.generate(32, (i) => i);
    final frame = TerminalBinaryFrame(
      kind: TerminalBinaryKind.output,
      streamId: stream,
      seq: 4294967297,
      bytes: Uint8List.fromList(utf8.encode('shared terminal')),
      compressed: false,
    );
    final wire = sealTerminalBinary(key, maxSafeInteger, frame)!;
    final opened = openTerminalBinary(key, wire)!;
    expect(opened.counter, maxSafeInteger);
    expect(opened.frame.seq, frame.seq);
    expect(opened.frame.bytes, frame.bytes);
    wire[wire.length - 1] ^= 1;
    expect(openTerminalBinary(key, wire), isNull);
  });

  test('compressed keyframes reach the shared terminal renderer', () async {
    final sent = <Map<String, dynamic>>[];
    final session = TerminalSession(
      machineId: 'fixture',
      agentId: 'agent',
      engineId: 'codex',
      agentName: 'Fixture',
      send: (type, payload) async {
        sent.add({'type': type, ...payload});
        return true;
      },
      sendBinary: (_) async => true,
    );
    addTearDown(session.dispose);
    await session.open();
    await session.handleFrame('terminal_ready', {
      'requestId': sent.first['requestId'],
      'protocolVersion': 3,
      'streamId': stream,
      'agentId': 'agent',
    });
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: stream,
        seq: 0,
        bytes: Uint8List.fromList(
          const ZLibEncoder().encode(utf8.encode('Browser terminal ready')),
        ),
        compressed: true,
        cols: 100,
        rows: 24,
      ),
    );
    expect(
      session.terminal.buffer.getText(),
      contains('Browser terminal ready'),
    );
    expect(session.acceptsInput, isTrue);
  });
}
