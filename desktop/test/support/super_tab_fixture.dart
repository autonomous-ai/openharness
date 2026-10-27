import 'dart:async';
import 'dart:convert';
import 'dart:math';
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

/// What the backend's Swarm reads answer (docs/design/2026-10-26-swarm-state-parts.md, section 4), worked out from
/// a test's whole-Swarm state. Each read compares every part with what it held: a part whose JSON changed gets the
/// next version and a new `changedAt`, a part that is gone gets a tombstone. Tests keep changing the state as they
/// did; the reads see exactly those changes.
class SwarmPartsBackend {
  /// The server's clock, one tick per change; a cursor is a tick.
  int clock = 1000;
  int _version = 100;

  /// The visibility epoch: a test moves it to have the next change read answer a reload.
  int epoch = 1;

  /// The ticks a change read sends again, as the 30 s overlap does.
  int overlap = 3;

  /// Every read answered, by path, in order.
  final reads = <String>[];

  /// The size of each first load and change read answered, in JSON bytes.
  final bytes = <String, List<int>>{};

  final _parts = <String, _HeldPart>{};

  /// The parts of [state], by `kind:key`. Groups marked dormant leave the active set.
  static Map<String, Map<String, dynamic>> split(Map<String, dynamic> state) {
    final parts = <String, Map<String, dynamic>>{};
    parts['head:head'] = {
      for (final entry in state.entries)
        if (!const {
          'people',
          'agents',
          'conversations',
          'machines',
          'starts',
          'mentionsWaiting',
          'decisionsWaiting',
          'otherProjectsWork',
          'githubApp',
        }.contains(entry.key))
          entry.key: entry.value,
    };
    void each(String kind, String list, String id) {
      for (final row in state[list] as List? ?? const []) {
        final data = Map<String, dynamic>.from(row as Map);
        parts['$kind:${data[id]}'] = data;
      }
    }

    each('members', 'people', 'id');
    each('agents', 'agents', 'id');
    each('groups', 'conversations', 'id');
    each('machines', 'machines', 'machineId');
    each('starts', 'starts', 'id');
    return parts;
  }

  /// Whether this backend leaves [group] out of the active set: archived by
  /// hand, or marked dormant as the backend's sweep marks finished, quiet work.
  static bool dormant(Map<String, dynamic> group) =>
      group['dormant'] == true || group['archived'] == true;

  void _sync(Map<String, dynamic> state) {
    final now = split(jsonDecode(jsonEncode(state)) as Map<String, dynamic>);
    for (final entry in now.entries) {
      final json = jsonEncode(entry.value);
      final held = _parts[entry.key];
      if (held != null && !held.deleted && held.json == json) continue;
      _parts[entry.key] = _HeldPart(
        version: ++_version,
        changedAt: ++clock,
        json: json,
        ordinal: held?.ordinal ?? _parts.length,
      );
    }
    for (final entry in _parts.entries.toList()) {
      if (entry.value.deleted || now.containsKey(entry.key)) continue;
      _parts[entry.key] = _HeldPart(
        version: ++_version,
        changedAt: ++clock,
        json: entry.value.json,
        ordinal: entry.value.ordinal,
        deleted: true,
      );
    }
  }

  Map<String, dynamic> _envelope(String id, _HeldPart part) => {
    'key': id.substring(id.indexOf(':') + 1),
    'version': part.version,
    'changedAt': part.changedAt,
    if (part.deleted)
      'deleted': true
    else if (id.startsWith('groups:') && dormant(part.data))
      'dormant': true
    else
      'data': part.data,
  };

  String _cursor(int tick) => 'c${tick}e$epoch';

  Map<String, dynamic> _derived(Map<String, dynamic> state) => {
    'agents': <String, dynamic>{},
    'machines': <String, dynamic>{},
    if (state['mentionsWaiting'] != null)
      'mentionsWaiting': state['mentionsWaiting'],
    if (state['decisionsWaiting'] != null)
      'decisionsWaiting': state['decisionsWaiting'],
    if (state['otherProjectsWork'] != null)
      'otherProjectsWork': state['otherProjectsWork'],
  };

  List<MapEntry<String, _HeldPart>> _ordered() =>
      _parts.entries.toList()
        ..sort((a, b) => a.value.ordinal.compareTo(b.value.ordinal));

  /// Whether [reader] may not read [part]: a private conversation is read only
  /// by its audience (and the project's Lead, an agent), owners included, and
  /// by each person only at the membership generation they were listed with
  /// (backend projects.ts canReadGroup), when [state] gives them one.
  static bool _hidden(
    String id,
    _HeldPart part,
    String? reader,
    Map<String, dynamic> state,
  ) {
    if (reader == null || part.deleted || !id.startsWith('groups:')) {
      return false;
    }
    final audience = part.data['audience'];
    if (audience is! Map) return false;
    final generation = (state['people'] as List?)
        ?.cast<Map>()
        .where((p) => p['id'] == reader)
        .firstOrNull?['generation'];
    return !(audience['people'] as List).any(
      (p) =>
          (p as Map)['id'] == reader &&
          (generation == null || p['generation'] == generation),
    );
  }

  /// The answer to a Swarm read of [state] at [path] by [reader], or null for a path that is not one. With no
  /// reader, every group is read.
  Map<String, dynamic>? read(
    String path,
    Map<String, dynamic> state, {
    String? reader,
  }) {
    final uri = Uri.parse(path);
    final segments = uri.pathSegments;
    if (segments.length < 4 || segments[0] != 'api') return null;
    final route = segments[3];
    // Time passes between reads, changed or not.
    clock++;
    if (segments.length == 4 && route == 'parts') {
      _sync(state);
      reads.add(path);
      final answer = <String, dynamic>{
        'format': 2,
        'tabId': state['id'],
        'cursor': _cursor(clock - overlap),
        'serverTime': clock,
        'lastChangedAt': _lastChangedAt(),
        'epoch': epoch,
        'githubApp': state['githubApp'] ?? false,
        'head': _envelope('head:head', _parts['head:head']!),
        for (final kind in _kinds) kind: <dynamic>[],
        'derived': _derived(state),
      };
      for (final entry in _ordered()) {
        final kind = entry.key.substring(0, entry.key.indexOf(':'));
        if (kind == 'head' || entry.value.deleted) continue;
        if (kind == 'groups' && dormant(entry.value.data)) continue;
        if (_hidden(entry.key, entry.value, reader, state)) continue;
        (answer[kind] as List).add(_envelope(entry.key, entry.value));
      }
      return _measured('parts', answer);
    }
    if (segments.length == 4 && route == 'changes') {
      reads.add(path);
      final cursor = RegExp(r'^c(\d+)e(\d+)$')
          .firstMatch(uri.queryParameters['cursor'] ?? '');
      if (cursor == null || int.parse(cursor.group(2)!) != epoch) {
        return _measured('changes', {'reload': true});
      }
      final since = int.parse(cursor.group(1)!);
      final start = clock;
      _sync(state);
      final answer = <String, dynamic>{
        'format': 2,
        'reload': false,
        'cursor': _cursor(start - overlap),
        'serverTime': clock,
        'lastChangedAt': _lastChangedAt(),
        'epoch': epoch,
        'head': null,
        for (final kind in _kinds) kind: <dynamic>[],
        'derived': _derived(state),
      };
      for (final entry in _ordered()) {
        if (entry.value.changedAt <= since) continue;
        if (_hidden(entry.key, entry.value, reader, state)) continue;
        final kind = entry.key.substring(0, entry.key.indexOf(':'));
        if (kind == 'head') {
          answer['head'] = _envelope(entry.key, entry.value);
        } else {
          (answer[kind] as List).add(_envelope(entry.key, entry.value));
        }
      }
      return _measured('changes', answer);
    }
    if (route == 'groups') {
      _sync(state);
      reads.add(path);
      if (segments.length == 5) {
        final held = _parts['groups:${segments[4]}'];
        if (held == null ||
            held.deleted ||
            _hidden('groups:${segments[4]}', held, reader, state)) {
          throw const SuperTabFailure(
            'NOT_FOUND',
            'Conversation not found.',
            statusCode: 404,
          );
        }
        return {'group': _dormantEnvelope('groups:${segments[4]}', held)};
      }
      final projectId = uri.queryParameters['projectId'];
      final before = uri.queryParameters['before'];
      final groups = [
        for (final entry in _ordered().reversed)
          if (entry.key.startsWith('groups:') &&
              !entry.value.deleted &&
              dormant(entry.value.data) &&
              !_hidden(entry.key, entry.value, reader, state) &&
              (projectId == null ||
                  (entry.value.data['projectId'] ?? 'lead') == projectId))
            entry,
      ];
      final from = before == null
          ? 0
          : groups.indexWhere((e) => e.key == 'groups:$before') + 1;
      final page = groups.skip(from).take(dormantPage).toList();
      return {
        'groups': [for (final e in page) _dormantEnvelope(e.key, e.value)],
        'next': from + page.length < groups.length
            ? page.last.key.substring('groups:'.length)
            : null,
      };
    }
    return null;
  }

  /// Groups per page of the dormant list.
  int dormantPage = 50;

  Map<String, dynamic> _dormantEnvelope(String id, _HeldPart part) => {
    'key': id.substring(id.indexOf(':') + 1),
    'version': part.version,
    'changedAt': part.changedAt,
    'data': {...part.data, if (dormant(part.data)) 'dormant': true},
  };

  Map<String, dynamic> _measured(String kind, Map<String, dynamic> answer) {
    final copy = jsonDecode(jsonEncode(answer)) as Map<String, dynamic>;
    (bytes[kind] ??= []).add(utf8.encode(jsonEncode(copy)).length);
    return copy;
  }

  int _lastChangedAt() => _parts.values.fold(0, (t, p) => max(t, p.changedAt));

  /// What a command reply says it wrote: the parts that changed since [tick].
  List<Map<String, dynamic>> writtenSince(
    int tick,
    Map<String, dynamic> state,
  ) {
    _sync(state);
    return [
      for (final entry in _ordered())
        if (entry.value.changedAt > tick)
          {
            'kind': switch (entry.key.substring(0, entry.key.indexOf(':'))) {
              'members' => 'member',
              'agents' => 'agent',
              'groups' => 'group',
              'machines' => 'machine',
              'starts' => 'start',
              final kind => kind,
            },
            'key': entry.key.substring(entry.key.indexOf(':') + 1),
            'version': entry.value.version,
          },
    ];
  }

  static const _kinds = [
    'members',
    'agents',
    'groups',
    'machines',
    'starts',
    'progress',
  ];
}

class _HeldPart {
  _HeldPart({
    required this.version,
    required this.changedAt,
    required this.json,
    required this.ordinal,
    this.deleted = false,
  });
  final int version, changedAt, ordinal;
  final String json;
  final bool deleted;
  Map<String, dynamic> get data => jsonDecode(json) as Map<String, dynamic>;
}

/// What the backend answers an old whole-Swarm read with (section 4.11).
const superTabUpdateRequired = SuperTabFailure(
  'UPDATE_REQUIRED',
  'Update Harness to keep using this Swarm.',
  statusCode: 426,
);

class ConversationServer {
  int revision = 0;

  /// The Swarm reads this server answers, worked out from [state].
  final parts = SwarmPartsBackend();

  /// Messages per page, as the backend pages them.
  int messagePage = 100;

  /// Told of every messages read, by path.
  void Function(String path)? onRead;
  bool loseReply = false, reject = false, failSave = false, failReads = false;
  Map<String, dynamic>? saved;
  // While set, every read waits for it: a slow server.
  Completer<void>? holdReads;
  // Makes every command answer with this refusal: {code, message}.
  Map<String, String>? refuse;
  // Added to every successful command's result, as a newer backend adds
  // fields such as `credentialNotice`.
  final commandResult = <String, dynamic>{};
  final posts = <Map<String, dynamic>>[];
  final receipts = <String, Map<String, dynamic>>{};
  final messages = <Map<String, dynamic>>[];
  // Route decisions by id, answered by GET .../route-decisions/:id.
  final routeDecisions = <String, Map<String, dynamic>>{};
  // The reader's tags, newest last, answered by GET .../mentions?state=.
  final mentions = <Map<String, dynamic>>[];
  // Decisions asked of the reader, newest last, answered by GET .../decisions?state=.
  final decisions = <Map<String, dynamic>>[];
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

  /// Answers [path] as the backend answers the account of the [controller]
  /// asking ([_reader]); with none, as it answers someone who reads every
  /// conversation.
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final reader = Zone.current[_reader] as String?;
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
      final tick = parts.clock;
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
      } else if (command['type'] == 'decision.answer') {
        decisions.firstWhere((d) => d['id'] == command['decisionId'])
          ..['choice'] = command['choice']
          ..['answeredAt'] = '2026-10-27T06:00:00Z';
        state['decisionsWaiting'] = (state['decisionsWaiting'] as int) - 1;
        revision++;
      } else if (command['type'] == 'mention.done') {
        mentions.firstWhere((m) => m['id'] == command['mentionId'])
          ..['resolvedAt'] = '2026-10-24T06:00:00Z'
          ..['resolvedBy'] = 'done';
        state['mentionsWaiting'] = (state['mentionsWaiting'] as int) - 1;
        revision++;
      } else if (command['type'] == 'conversation.create') {
        revision++;
        final id = 'group-$revision';
        final projectId = command['projectId'] ?? 'lead';
        // The project's Lead is in every new group, a private one included.
        final leadConversationId =
            (state['projects'] as List?)
                ?.cast<Map<String, dynamic>>()
                .where((p) => p['id'] == projectId)
                .firstOrNull?['leadConversationId'] ??
            'lead';
        final leadId = (state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .where((g) => g['id'] == leadConversationId)
            .firstOrNull?['leadId'];
        (state['conversations'] as List).add({
          ...conversationFixture(id, command['title'] as String),
          'projectId': projectId,
          'leadId': leadId,
          'agentIds': [?leadId],
          if (command['audience'] case {'personIds': final List people})
            'audience': {
              'people': [
                for (final person in people)
                  {
                    'id': person,
                    'generation':
                        (state['people'] as List?)
                            ?.cast<Map>()
                            .where((p) => p['id'] == person)
                            .firstOrNull?['generation'] ??
                        'fixture',
                  },
              ],
            },
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
      } else if (command['type'] == 'conversation.partner') {
        final group = (state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((g) => g['id'] == command['conversationId']);
        if (command['personId'] case final String id) {
          group['partnerId'] = id;
        } else {
          group.remove('partnerId');
        }
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
      output.addAll(commandResult);
      final result = {
        'result': output,
        'parts': parts.writtenSince(tick, state),
        'lastChangedAt': parts.clock,
      };
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
    if (uri.pathSegments.last == 'decisions') {
      final open = uri.queryParameters['state'] == 'open';
      return jsonDecode(
        jsonEncode({
          'decisions': decisions.reversed
              .where((d) => (d['answeredAt'] == null) == open)
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
      onRead?.call(path);
      final conversationId = uri.pathSegments[4];
      final query = uri.queryParameters;
      final after = int.tryParse(query['after'] ?? '');
      final before = int.tryParse(query['before'] ?? '');
      final afterId = query['afterId'], beforeId = query['beforeId'];
      final messageId = query['messageId'];
      // Pages run in (sequence, id) order (section 4.6).
      int order(Map<String, dynamic> a, Map<String, dynamic> b) {
        final bySequence = (a['sequence'] as int).compareTo(
          b['sequence'] as int,
        );
        return bySequence != 0
            ? bySequence
            : (a['id'] as String).compareTo(b['id'] as String);
      }

      bool past(Map<String, dynamic> m, int sequence, String? id, int sign) {
        final s = (m['sequence'] as int).compareTo(sequence) * sign;
        if (s != 0 || id == null) return s > 0;
        return (m['id'] as String).compareTo(id) * sign > 0;
      }

      var rows =
          messages
              .where(
                (m) =>
                    m['conversationId'] == conversationId &&
                    (messageId == null || m['id'] == messageId) &&
                    (after == null || past(m, after, afterId, 1)) &&
                    (before == null || past(m, before, beforeId, -1)),
              )
              .toList()
            ..sort(order);
      if (after == null) rows = rows.reversed.toList();
      final page = rows.take(messagePage).toList();
      final next = rows.length > messagePage
          ? {'sequence': page.last['sequence'], 'id': page.last['id']}
          : null;
      return jsonDecode(
        jsonEncode({
          'messages': after == null ? page.reversed.toList() : page,
          'next': next,
        }),
      ) as Map<String, dynamic>;
    }
    if (parts.read(path, state, reader: reader) case final answer?) {
      return answer;
    }
    if (uri.path == '/api/super-tabs/list') {
      return {
        'tabs': [
          {
            'id': state['id'],
            'name': state['name'],
            'ownerId': state['ownerId'],
            'paused': state['paused'] ?? false,
            'lastChangedAt': parts.clock,
          },
        ],
        'next': null,
      };
    }
    // The whole-Swarm reads are gone (section 4.11): nothing may still ask.
    throw superTabUpdateRequired;
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
    // The Lead's message carrying the tag moves its conversation.
    final group = (state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .where((g) => g['id'] == conversationId)
        .firstOrNull;
    group?['lastMessageSequence'] = revision;
  }

  /// The Lead asks the reader [questions] in one batch, as the backend records it.
  void ask(
    List<String> questions, {
    String conversationId = 'lead',
    String projectId = 'lead',
    int recommended = 0,
  }) {
    final batch = 'batch-${decisions.length + 1}';
    for (final question in questions) {
      decisions.add({
        'id': 'decision-${decisions.length + 1}',
        'batchId': batch,
        'projectId': projectId,
        'projectName': 'web-project',
        'conversationId': conversationId,
        'conversationTitle': 'Lead',
        'askerName': 'Wren',
        'question': question,
        'options': ['Behind a flag', 'To everyone'],
        'recommended': recommended,
        'unblocks': 'The release',
        'createdAt': '2026-10-27T05:00:00Z',
        'answeredAt': null,
        'choice': null,
        'note': null,
      });
    }
    state['decisionsWaiting'] =
        ((state['decisionsWaiting'] as int?) ?? 0) + questions.length;
    revision++;
  }

  /// Who asks, for the reads a [controller] makes: a private conversation is
  /// read by its audience alone. A zone value, so that subclasses overriding
  /// [request] keep it.
  static final _reader = Object();

  SuperTabController controller({
    Map<String, dynamic>? initial,
    String account = 'owner',
    SuperTabUpload? upload,
  }) => SuperTabController(
    tabId: 'tab',
    accountId: account,
    request: (method, path, {body}) => runZoned(
      () => request(method, path, body: body),
      zoneValues: {_reader: account},
    ),
    save: save,
    upload: upload ?? this.upload,
    initial: initial ?? const {},
    pollInterval: Duration.zero,
  );
}
