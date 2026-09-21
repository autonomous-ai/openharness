import 'dart:async';

import 'package:harness/ws/ws_conn.dart';

/// Explicit receipts for UI/model tests; no socket is opened.
class RenameConnection extends WsConn {
  RenameConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final renames = <Map<String, dynamic>>[];
  final replies = <Completer<Map<String, dynamic>>>[];
  Completer<Map<String, dynamic>>? inventory;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'agent_update') {
      renames.add(Map.of(payload));
      final reply = Completer<Map<String, dynamic>>();
      replies.add(reply);
      return reply.future;
    }
    if (type == 'agents_list' && inventory != null) return inventory!.future;
    return Future.value({});
  }
}
