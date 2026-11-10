import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import '../logging/app_log.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_session.dart'
    show TerminalBinarySender, TerminalFrameSender;

/// The most a page message carries to the machine in one kind-8 frame. The spike measured 32 KiB messages as free on
/// the UI thread where 8 KiB ones caused slow frames; the page's own bytes (keys, pointer) are far smaller.
const browserChunkBytes = 32 * 1024;

/// What noVNC must have read before the next `agent_browser_ack`. The machine pauses at 256 KiB unacked and resumes
/// below 128 KiB (cli core/browserStreams.ts `BROWSER_WINDOW`), so what is held back here never keeps it paused.
const browserAckStepBytes = 64 * 1024;

/// Why a [BrowserStream] did not open: the machine's refusal (`NOT_OWNER`, `NO_BROWSER`, `NOT_READY`, `VIEWER_LIMIT`),
/// [route] when the open could not be sent or was never answered, or [page] when the page that shows it never loaded.
class BrowserStreamError implements Exception {
  const BrowserStreamError(this.code);
  static const route = 'ROUTE';
  static const page = 'PAGE';
  final String code;
  @override
  String toString() => 'BrowserStreamError($code)';
}

/// One open view of an agent's browser: the VNC bytes of `podman exec … socat` on the agent's machine, carried by the
/// terminal's transport as `agent_browser_*` frames and binary kind 8. The machine sends at most its credit window
/// ahead of the acks, and the page acks only what noVNC has read ([consumed]).
class BrowserStream {
  BrowserStream({
    required this.machineId,
    required this.agentId,
    required TerminalFrameSender send,
    required TerminalBinarySender sendBinary,
  }) : _send = send,
       _sendBinary = sendBinary;

  /// How long an open waits for the machine's answer.
  static const openTimeout = Duration(seconds: 20);

  final String machineId, agentId;
  final TerminalFrameSender _send;
  final TerminalBinarySender _sendBinary;

  String? streamId;
  String? _requestId;
  Completer<void>? _opening;
  int _seq = 0;

  /// Read by noVNC and not acked yet.
  int _consumed = 0;

  // Buffered until the bridge listens: the server's banner comes right after the open.
  final _bytes = StreamController<Uint8List>();
  final _closed = Completer<String?>();

  Stream<Uint8List> get bytes => _bytes.stream;

  /// The close reason: `closed` (this end closed it), `agent`, `rate`, `backlog` or `route`.
  Future<String?> get closed => _closed.future;
  bool get isClosed => _closed.isCompleted;

  Future<void> open() async {
    final opening = _opening = Completer<void>();
    final requestId = _requestId =
        'brw_${DateTime.now().microsecondsSinceEpoch}_${Random.secure().nextInt(1 << 31)}';
    final sent = await _send('agent_browser_open', {
      'requestId': requestId,
      'agentId': agentId,
    });
    if (!sent) _failOpen(BrowserStreamError.route);
    return opening.future.timeout(
      openTimeout,
      onTimeout: () {
        appLog.warn('browser', 'open on $machineId was not answered');
        _requestId = null;
        throw const BrowserStreamError(BrowserStreamError.route);
      },
    );
  }

  void _failOpen(String code) {
    final opening = _opening;
    if (opening != null && !opening.isCompleted) {
      opening.completeError(BrowserStreamError(code));
    }
  }

  void handleFrame(String type, Map<String, dynamic> payload) {
    switch (type) {
      case 'agent_browser_open_result':
        if (_requestId == null || payload['requestId'] != _requestId) return;
        _requestId = null;
        final error = payload['error'], id = payload['streamId'];
        if (error is String) return _failOpen(error);
        if (id is! String) return _failOpen(BrowserStreamError.route);
        streamId = id;
        if (isClosed) {
          // Closed while it opened: the machine's exec ends with it.
          unawaited(_send('agent_browser_close', {'streamId': id}));
          return;
        }
        _opening?.complete();
      case 'agent_browser_close':
        if (streamId == null || payload['streamId'] != streamId) return;
        final reason = payload['reason'];
        _finish(reason is String ? reason : 'closed');
    }
  }

  void handleBinary(TerminalBinaryFrame frame) {
    if (frame.streamId != streamId || isClosed) return;
    _bytes.add(frame.bytes);
  }

  /// Bytes from the page (keys, pointer, clipboard) to the agent's browser.
  void write(Uint8List bytes) {
    final id = streamId;
    if (id == null || isClosed) return;
    for (var at = 0; at < bytes.length; at += browserChunkBytes) {
      unawaited(
        _sendBinary(
          TerminalBinaryFrame(
            kind: TerminalBinaryKind.browser,
            streamId: id,
            seq: _seq++,
            bytes: Uint8List.sublistView(
              bytes,
              at,
              min(at + browserChunkBytes, bytes.length),
            ),
            compressed: false,
          ),
        ),
      );
    }
  }

  /// noVNC read [bytes] more of what came. Each [browserAckStepBytes] of it is acked with what was read since the
  /// last ack, and the machine may send that much again.
  void consumed(int bytes) {
    final id = streamId;
    if (id == null || isClosed || bytes <= 0) return;
    _consumed += bytes;
    if (_consumed < browserAckStepBytes) return;
    unawaited(_send('agent_browser_ack', {'streamId': id, 'bytes': _consumed}));
    _consumed = 0;
  }

  /// The relay refused a browser frame of this machine's: the stream is broken, so it ends here and on the machine.
  void transportError() {
    final id = streamId;
    if (id == null || isClosed) return;
    unawaited(_send('agent_browser_close', {'streamId': id}));
    _finish('rate');
  }

  /// The connection to the machine dropped: the machine ends the exec on its side.
  void connectionLost() {
    _requestId = null;
    _finish('route');
  }

  Future<void> close() async {
    if (isClosed) return;
    final id = streamId;
    _finish('closed');
    if (id != null) await _send('agent_browser_close', {'streamId': id});
  }

  void _finish(String reason) {
    if (isClosed) return;
    _closed.complete(reason);
    // An open still waiting ends with it; a late answer still closes what it opened.
    _failOpen(BrowserStreamError.route);
    unawaited(_bytes.close());
    if (reason != 'closed') {
      appLog.warn('browser', 'stream on $machineId closed: $reason');
    }
  }
}
