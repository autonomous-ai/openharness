import 'dart:async';

import 'rename_connection.dart';

class StopConnection extends RenameConnection {
  final stops = <String>[];
  final stopReplies = <Completer<Map<String, dynamic>>>[];
  int restarts = 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'agent_delete') {
      stops.add(payload['agentId'] as String);
      final reply = Completer<Map<String, dynamic>>();
      stopReplies.add(reply);
      return reply.future;
    }
    if (type == 'agent_restart') restarts++;
    return super.request(type, payload: payload, timeout: timeout);
  }
}
