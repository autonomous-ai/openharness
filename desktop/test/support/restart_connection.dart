import 'dart:async';

import 'stop_connection.dart';

/// Controlled receipts only; never opens a connection or starts a process.
class RestartConnection extends StopConnection {
  final requests = <Map<String, dynamic>>[];
  final restartReplies = <Completer<Map<String, dynamic>>>[];
  final checks = <Map<String, dynamic>>[];
  final checkReplies = <Completer<Map<String, dynamic>>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'agent_restart' || type == 'agent_create_status') {
      final reply = Completer<Map<String, dynamic>>();
      if (type == 'agent_restart') {
        requests.add(Map.of(payload));
        restartReplies.add(reply);
      } else {
        checks.add(Map.of(payload));
        checkReplies.add(reply);
      }
      return reply.future;
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

Map<String, dynamic> restartReceipt(
  String? id, {
  String agentId = 'a0',
  String name = 'Restarted',
  String? sessionId,
  bool resumed = true,
}) => {
  'creationId': ?id,
  if (id != null) 'state': 'created',
  'resumed': resumed,
  'agent': {
    'id': agentId,
    'name': name,
    'sessionId': ?sessionId,
    'engine': 'codex',
    'terminal': {'available': true},
  },
};
