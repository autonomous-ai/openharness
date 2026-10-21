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

Map<String, dynamic> projectFixture(
  String id,
  String name,
  String leadConversationId, {
  String visibility = 'public',
}) => {
  'id': id,
  'name': name,
  'ownerId': 'owner',
  'leadConversationId': leadConversationId,
  'visibility': visibility,
  'members': <dynamic>[],
  'updateMinutes': 5,
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
  // Uploaded images by id: their metadata and base64 parts in order.
  final attachments = <String, Map<String, dynamic>>{};
  final attachmentParts = <String, List<String?>>{};
  // Every attachment upload body, apart from [posts].
  final uploads = <Map<String, dynamic>>[];
  // Unsent uploads the client deleted.
  final deletedAttachments = <String>[];
  bool failUploads = false;
  // Fails the upload request with this 1-based number, once.
  int? failUploadAt;
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
    final segments = Uri.parse(path).pathSegments;
    if (segments.length > 3 && segments[3] == 'attachments') {
      return _attachment(method, segments, body);
    }
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
        final images = (command['attachmentIds'] as List? ?? const []).length;
        // As the backend stores a message of images alone.
        append(
          (command['text'] as String).isEmpty && images > 0
              ? (images == 1 ? '[image]' : '[$images images]')
              : command['text'] as String,
          conversationId: command['conversationId'] as String,
        );
        messages.last['replyTo'] = command['replyTo'];
        messages.last['attachments'] = [
          for (final id in command['attachmentIds'] as List? ?? const [])
            attachments[id],
        ];
        output['messageId'] = 'message-$revision';
      } else if (command['type'] == 'conversation.create') {
        revision++;
        final id = 'group-$revision';
        (state['conversations'] as List).add({
          ...conversationFixture(id, command['title'] as String),
          'projectId': command['projectId'] ?? 'lead',
        });
        output['conversationId'] = id;
      } else if (command['type'] == 'project.create') {
        revision++;
        final projects = state['projects'] ??= <dynamic>[
          projectFixture('lead', state['name'] as String, 'lead'),
        ];
        final id = 'project-$revision', leadId = 'lead-$revision';
        (projects as List).add(
          projectFixture(
            id,
            command['name'] as String,
            leadId,
            visibility: command['visibility'] as String,
          ),
        );
        (state['conversations'] as List).add({
          ...conversationFixture(leadId, 'Lead'),
          'projectId': id,
          'brief': command['brief'] ?? '',
        });
        output.addAll({'projectId': id, 'conversationId': leadId});
      } else if (command['type'] == 'project.delete') {
        final projectId = command['projectId'];
        final projects =
            state['projects'] ??
            [projectFixture('lead', state['name'] as String, 'lead')];
        state['projects'] = (projects as List)
            .where((p) => p['id'] != projectId)
            .toList();
        final groups = state['conversations'] as List;
        final removed = groups
            .where((g) => (g['projectId'] ?? 'lead') == projectId)
            .map((g) => g['id'])
            .toSet();
        groups.removeWhere((g) => removed.contains(g['id']));
        messages.removeWhere((m) => removed.contains(m['conversationId']));
        revision++;
      } else if ([
        'project.rename',
        'project.cadence',
        'project.sharing',
      ].contains(command['type'])) {
        final project = (state['projects'] as List?)
            ?.cast<Map<String, dynamic>>()
            .where((p) => p['id'] == command['projectId'])
            .firstOrNull;
        if (project != null) {
          if (command['type'] == 'project.rename') {
            project['name'] = command['name'];
          } else if (command['type'] == 'project.cadence') {
            project['updateMinutes'] = command['minutes'];
          } else {
            project['visibility'] = command['visibility'];
            project['members'] = [
              for (final id in command['memberIds'] as List)
                {'id': id, 'generation': 'fixture'},
            ];
          }
          revision++;
        }
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

  Map<String, dynamic> _attachment(
    String method,
    List<String> segments,
    Map<String, dynamic>? body,
  ) {
    final parts = segments.length > 4 ? attachmentParts[segments[4]] : null;
    if (segments.length > 4 && parts == null) {
      throw const SuperTabFailure('NOT_FOUND', 'This image is unavailable.');
    }
    if (method == 'DELETE') {
      attachments.remove(segments[4]);
      attachmentParts.remove(segments[4]);
      deletedAttachments.add(segments[4]);
      return {'id': segments[4], 'deleted': true};
    }
    if (method == 'GET' && segments.length == 5) {
      final missing = [
        for (var i = 0; i < parts!.length; i++)
          if (parts[i] == null) i,
      ];
      return {
        ...attachments[segments[4]]!,
        'complete': missing.isEmpty,
        if (missing.isNotEmpty) 'missing': missing,
      };
    }
    if (method == 'GET') return {'data': parts![int.parse(segments[6])]};
    uploads.add(Map<String, dynamic>.from(body!));
    if (failUploads || failUploadAt == uploads.length) {
      failUploadAt = null;
      throw StateError('Connection lost');
    }
    if (segments.length == 4) {
      final id = 'image-${uploads.where((u) => u.containsKey('name')).length}';
      final size = body['size'] as int;
      attachments[id] = {
        'id': id,
        'name': body['name'],
        'mime': 'image/png',
        'size': size,
        'width': null,
        'height': null,
        'parts': (size / (256 * 1024)).ceil(),
      };
      attachmentParts[id] = [
        body['data'] as String,
        for (var i = 1; i < (attachments[id]!['parts'] as int); i++) null,
      ];
      return {...attachments[id]!, 'complete': size <= 256 * 1024};
    }
    parts![int.parse(segments[6])] = body['data'] as String;
    return {'id': segments[4], 'complete': !parts.contains(null)};
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
