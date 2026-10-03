import 'dart:async';
import 'dart:convert';

import 'package:harness/companions/coding_memory_connection.dart';

Map<String, dynamic> syntheticRecall({
  String id = 'synthetic-receipt',
  String? value,
}) => {
  'receiptId': id,
  'revision': 1,
  'engine': 'codex',
  'route': 'prompt_hook',
  'delivery': 'unverified',
  'preparedAt': 1790762400000,
  'emittedAt': 1790762401000,
  'canFeedback': true,
  'canGuideRecall': true,
  'project': {
    'id': 'synthetic-project',
    'name': 'editor',
    'location': '/synthetic/work/editor',
  },
  'feedback': {
    'value': value,
    'version': value == null ? 0 : 1,
    'updatedAt': value == null ? null : 1790762402000,
  },
};

Map<String, dynamic> syntheticMemory({
  int revision = 1,
  String? claim,
  bool project = false,
}) => {
  'id': 'synthetic-memory',
  'revision': revision,
  'state': 'active',
  'scope': {
    'profileId': 'synthetic-owner',
    if (project) 'projectId': 'synthetic-project',
  },
  'kind': 'working_preference',
  'facet': 'testing',
  'assertionType': 'stated_preference',
  'claim': claim ?? 'For regression fixes, start with a small failing test.',
  'rationale': 'It makes the failure and the fix easier to review.',
  'futureAction': 'Reproduce the bug with a focused test before changing the implementation.',
  'evidenceClass': 'user_stated',
  'applicability': {'task': 'bug_fix'},
  'exceptions': [],
  'retrievalCues': ['regression', 'testing'],
  'validity': {'validFrom': null, 'validUntil': null, 'recheckWhen': []},
  'createdAt': 1790762400000,
  'updatedAt': 1790762400000,
  'evidence': [
    {
      'sourceEventId': 'source-fixture',
      'quote': 'When fixing a bug, write a small failing test first.',
      'paths': ['/claim', '/futureAction'],
    },
  ],
};

Map<String, dynamic> syntheticActivity(
  Map<String, dynamic> record, {
  Map<String, dynamic>? recall,
  String agentId = 'synthetic-agent',
  bool empty = false,
}) {
  final use = recall ?? syntheticRecall();
  return {
    'ok': true,
    'sessions': [
      {
        ...use,
        'agentId': agentId,
        'name': 'Fix the editor regression',
        'selectedCount': empty ? 0 : 1,
        'status': 'ok',
        'receiptId': empty ? null : use['receiptId'],
      },
    ],
    'selectedAgentId': agentId,
    'items': empty
        ? []
        : [
            {'record': record, 'recall': use},
          ],
    'version': {
      'generation': 1,
      'knowledge': record['revision'],
      'preferences': 'true:true',
    },
  };
}

Map<String, dynamic> syntheticNotebook(
  Map<String, dynamic> memory, {
  bool ready = true,
}) => {
  'ok': true,
  'summary': {
    'id': 'notebook:testing',
    'title': 'Testing',
    'scope': memory['scope'],
    'project': {
      'id': 'synthetic-project',
      'name': 'editor',
      'location': '/synthetic/work/editor',
    },
    'state': ready ? 'ready' : 'queued',
    'activeRecords': 1,
    'unresolvedRecords': 1,
    'supportingRecords': ready ? 1 : 0,
    'updatedAt': ready ? 1790762400000 : null,
  },
  'explanation': ready
      ? {
          'updatedAt': 1790762400000,
          'statements': [
            {
              'text': 'For regression fixes, begin with a small failing test so failures stay easy to review.',
              'supports': [
                {
                  'memoryId': memory['id'],
                  'revision': memory['revision'],
                  'paths': ['/claim', '/rationale'],
                },
              ],
              'constraints': [
                {
                  'memoryId': memory['id'],
                  'applicability': memory['applicability'],
                  'exceptions': [
                    {
                      'when': {'change': 'documentation_only'},
                      'reason': 'Prose changes need a reading check.',
                    },
                  ],
                  'validity': {
                    'validFrom': null,
                    'validUntil': null,
                    'recheckWhen': ['The test framework changes.'],
                  },
                },
              ],
            },
          ],
        }
      : null,
  'supporting': ready ? [memory] : [],
  'memories': {
    'items': [
      memory,
      {
        ...memory,
        'id': 'synthetic-uncertain',
        'state': 'needs_verification',
        'claim':
            'Investigate parallel test isolation before changing defaults.',
      },
    ],
    'nextCursor': null,
    'version': {
      'generation': 1,
      'knowledge': memory['revision'],
      'preferences': 'true:true',
    },
  },
};

class MemoryFixture extends CodingMemoryConnection {
  @override
  bool valid = true;
  @override
  int epoch = 0;
  final calls = <Map<String, dynamic>>[];
  Future<Map<String, dynamic>> Function(Map<String, dynamic>)? handle;
  Map<String, dynamic> record = syntheticMemory();
  Map<String, dynamic> runtime = {'state': 'ready'};
  bool learn = true, recall = true, present = true;
  String? cursor;
  String? refuseApply;
  Map<String, dynamic>? previewed;
  final projects = <Map<String, dynamic>>[
    {
      'id': 'synthetic-project',
      'name': 'editor',
      'location': '/synthetic/work/editor',
    },
    {
      'id': 'second-project',
      'name': 'editor',
      'location': '/synthetic/research/editor',
    },
  ];
  final scopeChanges = <Map<String, dynamic>>[];
  final recalls = <Map<String, dynamic>>[];
  final notebookPages = <Map<String, dynamic>>[];

  Map<String, dynamic>? get project => projects
      .where((p) => p['id'] == (record['scope'] as Map)['projectId'])
      .firstOrNull;

  @override
  Future<Map<String, dynamic>> request(Map<String, dynamic> payload) async {
    calls.add(
      Map<String, dynamic>.from(jsonDecode(jsonEncode(payload)) as Map),
    );
    // Match the real connection's refusal of replies from an obsolete owner or
    // connection. The production transport captures this after initial connect.
    final start = epoch;
    final result = handle != null ? await handle!(payload) : respond(payload);
    if (!valid) throw const CodingMemoryFailure('OWNER_CHANGED');
    if (start != epoch) throw const CodingMemoryFailure('CONNECTION_CHANGED');
    return result;
  }

  Map<String, dynamic> respond(Map<String, dynamic> payload) {
    switch (payload['action']) {
      case 'activity':
        return syntheticActivity(record, recall: recalls.firstOrNull);
      case 'status':
        return {
          'ok': true,
          'runtime': runtime,
          'preferences': {'learn': learn, 'recall': recall},
          'queue': {
            'jobs': {'queued': 2, 'reviewing': 1, 'budget_deferred': 1},
            'retention': {'expiredEpisodes': 1},
          },
        };
      case 'list':
        final topicId = (payload['query'] as Map?)?['topicId'];
        if (topicId != null) {
          final page = notebookPages.singleWhere(
            (p) => (p['summary'] as Map)['id'] == topicId,
          );
          return {'ok': true, ...page['memories'] as Map<String, dynamic>};
        }
        return {
          'ok': true,
          'items': present ? [record] : [],
          'nextCursor': cursor,
          'version': {
            'generation': 1,
            'knowledge': record['revision'],
            'preferences': '$learn:$recall',
          },
        };
      case 'notebooks':
        return {
          'ok': true,
          'items': notebookPages.map((p) => p['summary']).toList(),
          'nextCursor': null,
        };
      case 'notebook':
        return notebookPages
                .where((p) => (p['summary'] as Map)['id'] == payload['id'])
                .firstOrNull ??
            {'ok': false, 'error': 'NOT_FOUND'};
      case 'show':
        return present
            ? {
                'ok': true,
                'record': record,
                'support': null,
                'project': project,
                'scopeChanges': scopeChanges,
                'recalls': recalls,
                'sources': [
                  {
                    'id': 'source-fixture',
                    'engine': 'claude',
                    'sessionId': 'fixture-session',
                    'role': 'user',
                    'observedAt': 1790762400000,
                  },
                ],
              }
            : {'ok': false, 'error': 'NOT_FOUND'};
      case 'projects':
        final query = payload['query'] as Map;
        final search = (query['search'] as String).toLowerCase();
        return {
          'ok': true,
          'items': projects
              .where(
                (p) => '${p['name']} ${p['location']}'.toLowerCase().contains(
                  search,
                ),
              )
              .toList(),
          'nextBefore': null,
        };
      case 'preview':
        previewed = payload['command'] as Map<String, dynamic>;
        return {
          'ok': true,
          'capability': 'a' * 32,
          'expiresInMs': 120000,
          'preview': {
            'command': previewed,
            'version': {
              'generation': 1,
              'knowledge': 1,
              'preferences': 'fixture',
            },
            'effects': previewed!['kind'] == 'forget'
                ? {
                    'deletedIds': [record['id'], 'dependent'],
                    'deletedTopicIds': ['topic'],
                    'alreadyDeliveredContent': 'not_erased',
                  }
                : previewed!['kind'] == 'configure'
                ? {'preferences': previewed!['preferences']}
                : previewed!['kind'] == 'narrow'
                ? {
                    'record': {
                      ...record,
                      'scope': {
                        ...record['scope'] as Map,
                        'projectId': previewed!['projectId'],
                      },
                    },
                    'project': projects.singleWhere(
                      (p) => p['id'] == previewed!['projectId'],
                    ),
                  }
                : previewed!['kind'] == 'feedback'
                ? {
                    'feedback': {
                      'value': previewed!['value'],
                      'version': (previewed!['expected'] as int) + 1,
                      'updatedAt': 1790762600000,
                    },
                  }
                : {
                    'record': {...record, ...previewed!['fields'] as Map},
                  },
          },
        };
      case 'apply':
        if (refuseApply != null) return {'ok': false, 'error': refuseApply};
        if (previewed!['kind'] == 'configure') {
          final prefs = previewed!['preferences'] as Map;
          learn = prefs['learn'] as bool;
          recall = prefs['recall'] as bool;
        } else if (previewed!['kind'] == 'forget') {
          present = false;
        } else if (previewed!['kind'] == 'narrow') {
          final from = record['scope'];
          record = {
            ...record,
            'scope': {...from as Map, 'projectId': previewed!['projectId']},
            'revision': (record['revision'] as int) + 1,
          };
          scopeChanges.add({
            'revision': record['revision'],
            'from': from,
            'to': record['scope'],
            'changedAt': 1790762400000,
            'actor': 'owner',
          });
        } else if (previewed!['kind'] == 'feedback') {
          final recall = recalls.singleWhere(
            (r) => r['receiptId'] == previewed!['receiptId'],
          );
          recall['feedback'] = {
            'value': previewed!['value'],
            'version': (previewed!['expected'] as int) + 1,
            'updatedAt': 1790762600000,
          };
        } else {
          record = {
            ...record,
            ...previewed!['fields'] as Map,
            'revision': (record['revision'] as int) + 1,
          };
        }
        return {'ok': true};
      default:
        throw StateError('Unexpected fixture action');
    }
  }

  void reconnect() {
    ++epoch;
    notifyListeners();
  }

  @override
  void invalidate() {
    valid = false;
    ++epoch;
    notifyListeners();
  }
}
