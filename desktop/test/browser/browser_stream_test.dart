import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/terminal/terminal_binary.dart';

const _stream = '0f8fad5b-d9cb-469f-a165-70867728950e';

/// What a [BrowserStream] sent to its machine, as `terminal_session_test.dart` records a terminal's.
class _Sent {
  final frames = <(String, Map<String, dynamic>)>[];
  final binary = <TerminalBinaryFrame>[];
  bool deliver = true;

  late final stream = BrowserStream(
    machineId: 'm',
    agentId: 'a1',
    send: (type, payload) async {
      frames.add((type, Map.of(payload)));
      return deliver;
    },
    sendBinary: (frame) async {
      binary.add(frame);
      return deliver;
    },
  );

  String get requestId =>
      frames.firstWhere((f) => f.$1 == 'agent_browser_open').$2['requestId']
          as String;

  /// Opens [stream] and answers it as the machine does.
  Future<void> open() async {
    final opened = stream.open();
    await Future<void>.delayed(Duration.zero);
    stream.handleFrame('agent_browser_open_result', {
      'requestId': requestId,
      'streamId': _stream,
    });
    await opened;
  }
}

TerminalBinaryFrame _bytes(List<int> bytes, {String streamId = _stream}) =>
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.browser,
      streamId: streamId,
      seq: 0,
      bytes: Uint8List.fromList(bytes),
      compressed: false,
    );

void main() {
  test('open sends agent_browser_open and resolves on open_result', () async {
    final sent = _Sent();
    await sent.open();
    expect(sent.frames.single.$1, 'agent_browser_open');
    expect(sent.frames.single.$2, {
      'requestId': sent.requestId,
      'agentId': 'a1',
    });
    expect(sent.stream.streamId, _stream);
  });

  test('open error codes map to BrowserStreamError', () async {
    for (final code in ['NOT_OWNER', 'NO_BROWSER', 'NOT_READY', 'VIEWER_LIMIT']) {
      final sent = _Sent();
      final opened = sent.stream.open();
      await Future<void>.delayed(Duration.zero);
      // Another open's answer is not this one's.
      sent.stream.handleFrame('agent_browser_open_result', {
        'requestId': 'other',
        'streamId': _stream,
      });
      sent.stream.handleFrame('agent_browser_open_result', {
        'requestId': sent.requestId,
        'error': code,
      });
      await expectLater(
        opened,
        throwsA(isA<BrowserStreamError>().having((e) => e.code, 'code', code)),
      );
    }
  });

  test('an open the machine never answers, or that cannot be sent, fails as '
      'route', () {
    fakeAsync((async) {
      final sent = _Sent();
      Object? failure;
      sent.stream.open().catchError((Object e) => failure = e);
      async.elapse(BrowserStream.openTimeout);
      expect(failure, isA<BrowserStreamError>());
      expect((failure as BrowserStreamError).code, BrowserStreamError.route);
    });
    fakeAsync((async) {
      final sent = _Sent()..deliver = false;
      Object? failure;
      sent.stream.open().catchError((Object e) => failure = e);
      async.flushMicrotasks();
      expect((failure as BrowserStreamError).code, BrowserStreamError.route);
    });
  });

  test('bytes arrive in order, with an ack at each ack step', () async {
    final sent = _Sent();
    await sent.open();
    final got = <int>[];
    sent.stream.bytes.listen(got.addAll);
    sent.stream.handleBinary(_bytes([1, 2]));
    // Another stream's bytes are not this one's.
    sent.stream.handleBinary(
      _bytes([9], streamId: '1f8fad5b-d9cb-469f-a165-70867728950e'),
    );
    sent.stream.handleBinary(_bytes([3]));
    await Future<void>.delayed(Duration.zero);
    expect(got, [1, 2, 3]);
    // The page says what noVNC took; each ack carries what was taken since the last one, once it reaches the step.
    List<Object?> acks() => [
      for (final f in sent.frames)
        if (f.$1 == 'agent_browser_ack') f.$2,
    ];
    sent.stream.consumed(2);
    sent.stream.consumed(browserAckStepBytes - 3);
    expect(acks(), isEmpty);
    sent.stream.consumed(5);
    expect(acks(), [
      {'streamId': _stream, 'bytes': browserAckStepBytes + 4},
    ]);
    sent.stream.consumed(browserAckStepBytes);
    expect(acks().last, {'streamId': _stream, 'bytes': browserAckStepBytes});
  });

  test('write sends kind 8 chunks of at most the chunk size', () async {
    final sent = _Sent();
    await sent.open();
    final bytes = Uint8List.fromList(
      List.generate(browserChunkBytes * 2 + 5, (i) => i % 251),
    );
    sent.stream.write(bytes);
    await Future<void>.delayed(Duration.zero);
    expect(sent.binary.map((f) => f.bytes.length), [
      browserChunkBytes,
      browserChunkBytes,
      5,
    ]);
    expect(sent.binary.map((f) => f.kind).toSet(), {TerminalBinaryKind.browser});
    expect(sent.binary.map((f) => f.streamId).toSet(), {_stream});
    expect(sent.binary.map((f) => f.compressed).toSet(), {false});
    expect([for (final f in sent.binary) ...f.bytes], bytes);
  });

  test('agent_browser_close from the machine ends bytes and completes closed '
      'with its reason', () async {
    for (final reason in ['rate', 'backlog', 'route', 'agent']) {
      final sent = _Sent();
      await sent.open();
      final done = Completer<void>();
      sent.stream.bytes.listen(null, onDone: done.complete);
      sent.stream.handleFrame('agent_browser_close', {
        'streamId': 'another',
        'reason': 'agent',
      });
      sent.stream.handleFrame('agent_browser_close', {
        'streamId': _stream,
        'reason': reason,
      });
      expect(await sent.stream.closed, reason);
      await done.future;
      // The machine closed it: nothing is sent back.
      expect(sent.frames.map((f) => f.$1), ['agent_browser_open']);
    }
  });

  test('transportError completes closed with rate and sends '
      'agent_browser_close', () async {
    final sent = _Sent();
    await sent.open();
    sent.stream.transportError();
    expect(await sent.stream.closed, 'rate');
    expect(sent.frames.last.$1, 'agent_browser_close');
    expect(sent.frames.last.$2, {'streamId': _stream});
  });

  test('close tells the machine once and completes closed with closed', () async {
    final sent = _Sent();
    await sent.open();
    await sent.stream.close();
    await sent.stream.close();
    expect(await sent.stream.closed, 'closed');
    expect(
      sent.frames.where((f) => f.$1 == 'agent_browser_close').map((f) => f.$2),
      [
        {'streamId': _stream},
      ],
    );
  });

  test('a stream closed while it opens closes what the machine opens', () async {
    final sent = _Sent();
    final opened = expectLater(
      sent.stream.open(),
      throwsA(isA<BrowserStreamError>()),
    );
    await Future<void>.delayed(Duration.zero);
    await sent.stream.close();
    sent.stream.handleFrame('agent_browser_open_result', {
      'requestId': sent.requestId,
      'streamId': _stream,
    });
    await opened;
    expect(sent.frames.last.$1, 'agent_browser_close');
    expect(sent.frames.last.$2, {'streamId': _stream});
  });
}
