import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart' show CancelToken;
import 'package:harness/super_tabs/attachment_upload.dart';
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
  // While set, every read waits for it: a slow server.
  Completer<void>? holdReads;
  // Makes every command answer with this refusal: {code, message}.
  Map<String, String>? refuse;
  final posts = <Map<String, dynamic>>[];
  final receipts = <String, Map<String, dynamic>>{};
  final messages = <Map<String, dynamic>>[];
  // Route decisions by id, answered by GET .../route-decisions/:id.
  final routeDecisions = <String, Map<String, dynamic>>{};
  // The reader's tags, newest last, answered by GET .../mentions?state=.
  final mentions = <Map<String, dynamic>>[];
  // How many times the mentions list was read.
  int mentionReads = 0;
  // A backend from before tags: it has no list route.
  bool mentionsMissing = false;
  // While set, every read of the mentions list waits for it.
  Completer<void>? holdMentions;
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
  // The files fully uploaded, in order, bytes included.
  final uploads = <Map<String, dynamic>>[];
  // Makes the upload of the file with this name fail with failUploadCode.
  String? failUpload;
  String failUploadCode = 'ATTACHMENT_TOO_LARGE';
  Future<void> save(Map<String, dynamic> value) async {
    if (failSave) throw StateError('Disk full');
    saved = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
  }

  void append(
    String text, {
    String conversationId = 'lead',
    List<Map<String, dynamic>> attachments = const [],
  }) {
    revision++;
    messages.add({
      'id': 'message-$revision',
      'conversationId': conversationId,
      'sequence': revision,
      'text': text,
      'attachments': attachments,
      'createdAt': '2026-10-18T00:00:00Z',
      'author': {'kind': 'person', 'id': 'owner', 'name': 'owner@example.com'},
      'deliveries': <dynamic>[],
    });
    (state['conversations'] as List).cast<Map<String, dynamic>>().firstWhere(
      (g) => g['id'] == conversationId,
    )['lastMessageSequence'] = revision;
  }

  /// What the backend does with a file sent to its upload route.
  Future<Map<String, dynamic>> upload({
    required String tabId,
    required String conversationId,
    required String name,
    required String mime,
    required Uint8List bytes,
    required CancelToken cancel,
    required void Function(double sent) onProgress,
  }) async {
    if (name == failUpload) {
      throw SuperTabFailure(
        failUploadCode,
        'The file is too large.',
        statusCode: 413,
      );
    }
    onProgress(.5);
    final id = 'attachment-${uploads.length + 1}';
    uploads.add({
      'conversationId': conversationId,
      'name': name,
      'mime': mime,
      'file': bytes,
      'id': id,
    });
    onProgress(1);
    return {'attachment': _attachment(id)};
  }

  Map<String, dynamic> _attachment(String id) {
    final upload = uploads.firstWhere((u) => u['id'] == id);
    return {
      'id': id,
      'name': upload['name'],
      'mime': upload['mime'],
      'size': (upload['file'] as List).length,
      'url': 'https://cdn.harness.autonomous.ai/$id/${upload['name']}',
    };
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
          attachments: [
            for (final id in command['attachmentIds'] as List? ?? const [])
              _attachment(id as String),
          ],
        );
        messages.last['replyTo'] = command['replyTo'];
        output['messageId'] = 'message-$revision';
      } else if (command['type'] == 'mention.done') {
        mentions.firstWhere((m) => m['id'] == command['mentionId'])
          ..['resolvedAt'] = '2026-10-24T06:00:00Z'
          ..['resolvedBy'] = 'done';
        state['mentionsWaiting'] = (state['mentionsWaiting'] as int) - 1;
        revision++;
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
        (projects as List).add({
          ...projectFixture(
            id,
            command['name'] as String,
            leadId,
            visibility: command['visibility'] as String,
          ),
          'skillMode': 'default',
        });
        (state['conversations'] as List).add({
          ...conversationFixture(leadId, 'Lead'),
          'projectId': id,
          'brief': command['brief'] ?? '',
        });
        output.addAll({'projectId': id, 'conversationId': leadId});
      } else if (command['type'] == 'conversation.archive') {
        (state['conversations'] as List)
                .cast<Map<String, dynamic>>()
                .firstWhere(
                  (g) => g['id'] == command['conversationId'],
                )['archived'] =
            command['archived'];
        revision++;
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
    if (holdReads case final hold?) await hold.future;
    if (failReads) throw StateError('Offline');
    final uri = Uri.parse(path);
    if (uri.pathSegments.last == 'mentions') {
      mentionReads++;
      if (mentionsMissing) {
        throw const SuperTabFailure('NOT_FOUND', 'Not found.', statusCode: 404);
      }
      if (holdMentions case final hold?) await hold.future;
      final waiting = uri.queryParameters['state'] == 'waiting';
      return jsonDecode(
        jsonEncode({
          'mentions': mentions.reversed
              .where((m) => (m['resolvedAt'] == null) == waiting)
              .toList(),
        }),
      ) as Map<String, dynamic>;
    }
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
      final messageId = uri.queryParameters['messageId'];
      var rows = messages
          .where(
            (m) =>
                m['conversationId'] == conversationId &&
                (messageId == null || m['id'] == messageId) &&
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

  /// The Lead tags the reader in [conversationId], as the backend records it.
  void tag(
    String messageId, {
    String conversationId = 'lead',
    String text = 'Please confirm the release.',
    String createdAt = '2026-10-24T05:00:00Z',
  }) {
    mentions.add({
      'id': 'mention-${mentions.length + 1}',
      'projectId': 'lead',
      'projectName': 'web-project',
      'conversationId': conversationId,
      'conversationTitle': 'Lead',
      'messageId': messageId,
      'leadName': 'Wren',
      'text': text,
      'createdAt': createdAt,
      'resolvedAt': null,
      'resolvedBy': null,
    });
    state['mentionsWaiting'] = ((state['mentionsWaiting'] as int?) ?? 0) + 1;
    revision++;
  }

  SuperTabController controller({
    Map<String, dynamic>? initial,
    String account = 'owner',
    SuperTabUpload? upload,
  }) => SuperTabController(
    tabId: 'tab',
    accountId: account,
    request: request,
    save: save,
    upload: upload ?? this.upload,
    initial: initial ?? const {},
    pollInterval: Duration.zero,
  );
}
