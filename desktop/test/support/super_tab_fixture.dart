import 'dart:convert';

import 'package:harness/super_tabs/controller.dart';

Map<String, dynamic> conversationFixture(String id, String title) => {
  'id': id,
  'title': title,
  'leadId': null,
  'agentIds': <String>[],
  'archived': false,
  'brief': '',
  'checks': <dynamic>[],
  'assignment': null,
  'lastMessageSequence': 0,
};

class ConversationServer {
  int revision = 0;
  bool loseReply = false, reject = false, failSave = false, failReads = false;
  Map<String, dynamic>? saved;
  // Makes every command answer with this refusal: {code, message}.
  Map<String, String>? refuse;
  final posts = <Map<String, dynamic>>[];
  final receipts = <String, Map<String, dynamic>>{};
  final messages = <Map<String, dynamic>>[];
  // Route decisions by id, answered by GET .../route-decisions/:id.
  final routeDecisions = <String, Map<String, dynamic>>{};
  // The effective routing policy answered by GET .../routing-policy.
  Map<String, dynamic>? routingPolicy;
  final state = <String, dynamic>{
    'version': 1,
    'id': 'tab',
    'name': 'Pilot',
    'ownerId': 'owner',
    'paused': false,
    'people': <dynamic>[
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    ],
    'agents': <dynamic>[],
    'invitations': <dynamic>[],
    'conversations': [
      conversationFixture('lead', 'Lead'),
      conversationFixture('offline', 'Offline editing'),
    ],
  };
  Future<void> save(Map<String, dynamic> value) async {
    if (failSave) throw StateError('Disk full');
    saved = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
  }

  void append(String text, {String conversationId = 'lead'}) {
    revision++;
    messages.add({
      'id': 'message-$revision',
      'conversationId': conversationId,
      'sequence': revision,
      'text': text,
      'createdAt': '2026-10-18T00:00:00Z',
      'author': {'kind': 'person', 'id': 'owner', 'name': 'owner@example.com'},
      'deliveries': <dynamic>[],
    });
    (state['conversations'] as List).cast<Map<String, dynamic>>().firstWhere(
      (g) => g['id'] == conversationId,
    )['lastMessageSequence'] = revision;
  }

  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'POST') {
      posts.add(Map<String, dynamic>.from(body!));
      if (reject) {
        throw const SuperTabFailure(
          'INVALID_RECIPIENT',
          'Choose an agent in this conversation.',
          statusCode: 400,
        );
      }
      if (refuse case final refusal?) {
        throw SuperTabFailure(
          refusal['code']!,
          refusal['message']!,
          statusCode: 409,
        );
      }
      final operationId = body['operationId'] as String;
      if (receipts[operationId] case final receipt?) return receipt;
      final command = body['command'] as Map;
      final output = <String, dynamic>{};
      if (command['type'] == 'message.send') {
        append(
          command['text'] as String,
          conversationId: command['conversationId'] as String,
        );
        messages.last['replyTo'] = command['replyTo'];
        output['messageId'] = 'message-$revision';
      } else if (command['type'] == 'conversation.create') {
        revision++;
        final id = 'group-$revision';
        (state['conversations'] as List).add(
          conversationFixture(id, command['title'] as String),
        );
        output['conversationId'] = id;
      }
      final result = {'revision': revision, 'result': output};
      receipts[operationId] = result;
      if (loseReply) {
        loseReply = false;
        throw StateError('Connection lost after commit');
      }
      return result;
    }
    if (failReads) throw StateError('Offline');
    final uri = Uri.parse(path);
    if (uri.pathSegments.last == 'routing-policy') {
      final policy = routingPolicy;
      if (policy == null) {
        throw const SuperTabFailure('NOT_FOUND', 'No routing policy.');
      }
      return jsonDecode(jsonEncode(policy)) as Map<String, dynamic>;
    }
    if (uri.pathSegments.length > 2 &&
        uri.pathSegments[uri.pathSegments.length - 2] == 'route-decisions') {
      final decision = routeDecisions[uri.pathSegments.last];
      if (decision == null) {
        throw const SuperTabFailure('NOT_FOUND', 'No such decision.');
      }
      return jsonDecode(jsonEncode(decision)) as Map<String, dynamic>;
    }
    if (uri.pathSegments.last == 'messages') {
      final conversationId = uri.pathSegments[4];
      final after = int.tryParse(uri.queryParameters['after'] ?? '');
      final before = int.tryParse(uri.queryParameters['before'] ?? '');
      var rows = messages
          .where(
            (m) =>
                m['conversationId'] == conversationId &&
                (after == null || (m['sequence'] as int) > after) &&
                (before == null || (m['sequence'] as int) < before),
          )
          .toList();
      if (after == null) rows = rows.reversed.toList();
      final page = rows.take(100).toList();
      final next = rows.length > 100 ? page.last['sequence'] : null;
      return {
        'messages': after == null ? page.reversed.toList() : page,
        'next': next,
        'revision': revision,
      };
    }
    return jsonDecode(jsonEncode({'revision': revision, 'state': state}))
        as Map<String, dynamic>;
  }

  SuperTabController controller({
    Map<String, dynamic>? initial,
    String account = 'owner',
  }) => SuperTabController(
    tabId: 'tab',
    accountId: account,
    request: request,
    save: save,
    initial: initial ?? const {},
    pollInterval: Duration.zero,
  );
}
