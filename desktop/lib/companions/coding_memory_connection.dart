import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models.dart' show ConnectionStatus;
import '../ws/local_cli_discovery.dart';
import '../ws/ws_conn.dart';

/// Owner controls use a separate, persistent TCP connection so the host can
/// verify the OS peer. Agent terminals and ordinary Unix transport are unchanged.
abstract class CodingMemoryConnection extends ChangeNotifier {
  bool get valid;
  int get epoch;
  Future<Map<String, dynamic>> request(Map<String, dynamic> payload);
  void invalidate();
}

class LocalCodingMemoryConnection extends CodingMemoryConnection {
  LocalCodingMemoryConnection({
    required LocalCliEndpoint endpoint,
    required String machineId,
    required this.isCurrent,
    required this.onClosed,
  }) {
    _socket = WsConn(
      wsBaseUrl: '',
      autonomousEnv: '',
      machineId: machineId,
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (_) => invalidate(),
      onEvent: (_) {},
      onStatus: (status) {
        if (_closed) return;
        if (status != ConnectionStatus.connected) ++_epoch;
        notifyListeners();
      },
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: endpoint.wsUri,
      localProtocolVersion: endpoint.protocolVersion,
      localToolClient: true,
    );
  }

  late final WsConn _socket;
  final bool Function() isCurrent;
  final VoidCallback onClosed;
  bool _closed = false, _started = false;
  int _epoch = 0;
  @override
  bool get valid => !_closed && isCurrent();
  @override
  int get epoch => _epoch;

  void _check() {
    if (valid) return;
    invalidate();
    throw const CodingMemoryFailure('OWNER_CHANGED');
  }

  @override
  Future<Map<String, dynamic>> request(Map<String, dynamic> payload) async {
    _check();
    if (!_started) {
      _started = true;
      unawaited(_socket.connect());
    }
    try {
      await _socket.waitUntilReady(timeout: const Duration(seconds: 5));
      _check();
      final epoch = _epoch;
      final result = await _socket.request(
        'pair',
        payload: {...payload, 'verb': 'memory'},
        timeout: const Duration(seconds: 8),
      );
      _check();
      if (epoch != _epoch) {
        throw const CodingMemoryFailure('CONNECTION_CHANGED');
      }
      if (result['ok'] != true) {
        throw CodingMemoryFailure(
          result['error'] as String? ?? 'MEMORY_UNAVAILABLE',
        );
      }
      return result;
    } on WsRequestFailure catch (error) {
      throw CodingMemoryFailure(error.code);
    } on WsRequestTimeout {
      throw const CodingMemoryFailure('TIMEOUT');
    }
  }

  @override
  void invalidate() {
    if (_closed) return;
    _closed = true;
    ++_epoch;
    unawaited(_socket.close());
    onClosed();
    notifyListeners();
  }

  @override
  void dispose() {
    invalidate();
    super.dispose();
  }
}

class CodingMemoryFailure implements Exception {
  const CodingMemoryFailure(this.code);
  final String code;
  @override
  String toString() => 'Coding memory: $code';
}

String codingMemoryError(Object error) => switch (error) {
  CodingMemoryFailure(code: 'OWNER_CHANGED') =>
    'Your account changed. Reopen Memories to continue.',
  CodingMemoryFailure(code: 'UNSUPPORTED') =>
    'Coding memory is not enabled in this local service.',
  CodingMemoryFailure(
    code: 'PERSON_ONLY' || 'UNKNOWN_CALLER' || 'UNVERIFIED_CALLER',
  ) =>
    'Open Harness directly on this computer to manage memories.',
  CodingMemoryFailure(
    code: 'PREVIEW_CHANGED' ||
        'REVISION_CONFLICT' ||
        'PAGE_CHANGED' ||
        'PREFERENCES_CHANGED',
  ) =>
    'Memories changed while you were reviewing. Refresh and review the current version. Your edit is still here.',
  CodingMemoryFailure(code: 'PREVIEW_REQUIRED' || 'CONNECTION_CHANGED') => 'This preview expired or the connection changed. Review it again before applying.',
  CodingMemoryFailure(code: 'NOT_FOUND') =>
    'This memory was removed or is no longer available.',
  CodingMemoryFailure(code: 'FEEDBACK_CHANGED') => 'Your feedback changed elsewhere. Refresh recent recall before changing it again.',
  CodingMemoryFailure(code: 'RECALL_UNAVAILABLE') => 'That recall is no longer available. Refresh recent recall to see the current history.',
  CodingMemoryFailure(code: 'PROJECT_UNAVAILABLE') =>
    'That project is no longer available for memory. Choose another project.',
  CodingMemoryFailure(code: 'SCOPE_NARROWING_ONLY' || 'MEMORY_NOT_ACTIVE') => 'This memory can no longer be limited this way. Go back and refresh its details.',
  CodingMemoryFailure(code: 'TIMEOUT') => 'The local service did not reply. If you were saving, refresh to check whether it finished before trying again.',
  _ => 'Memories are unavailable right now. Try again when the local service is ready.',
};
