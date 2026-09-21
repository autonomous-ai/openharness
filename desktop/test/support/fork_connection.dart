import 'dart:async';

import 'rename_connection.dart';

class ForkConnection extends RenameConnection {
  final forks = <Map<String, dynamic>>[];
  final checks = <Map<String, dynamic>>[];
  final forkReplies = <Completer<Map<String, dynamic>>>[];
  final checkReplies = <Completer<Map<String, dynamic>>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'agent_fork' || type == 'agent_create_status') {
      final checking = type == 'agent_create_status';
      (checking ? checks : forks).add(Map.of(payload));
      final reply = Completer<Map<String, dynamic>>();
      (checking ? checkReplies : forkReplies).add(reply);
      return reply.future;
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

Map<String, dynamic> forkReceipt(
  String? id, {
  String agentId = 'forked',
  String level = 'native',
}) => {
  'creationId': ?id,
  if (id != null) 'state': 'created',
  'level': level,
  'agent': {
    'id': agentId,
    'name': 'Separate idea',
    'engine': 'codex',
    'terminal': {'available': true},
    'forkedFrom': {'agentId': 'a0', 'name': 'Agent 0'},
  },
};
