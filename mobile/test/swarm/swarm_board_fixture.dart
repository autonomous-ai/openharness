import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// One Swarm whose project Mobile has work in every column: Nova on 2156,
/// Juno's 2160 waiting on the viewer, 2170 nobody took, 2171 done and still
/// to merge, 2172 merged and releasing, and 2173 shipped yesterday (closed,
/// so only the closed-work read has it); and one open proposal.
FakeSwarm boardBackend({bool proposalsFail = false, bool closedFail = false}) {
  final dormant = '/api/super-tabs/$tab/groups?dormant=1&projectId=$project';
  final proposals = '/api/super-tabs/$tab/proposals?projectId=$project';
  const pr = 'https://github.com/autonomous-ai/openharness/pull/12';
  final yesterday = DateTime.now().subtract(const Duration(days: 1));

  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  Map<String, dynamic> task(
    String id,
    int number,
    String title, {
    String? status,
    String? worker,
    bool merged = false,
    bool linked = false,
    List<String>? releasing,
    String? priority,
  }) => {
    ...groupData(
      id,
      title: title,
      number: number,
      agentIds: ['agent-lead', ?worker],
      status: status,
      workerId: worker,
      lastMessageSequence: number,
    ),
    'priority': ?priority,
    if (linked || merged) 'pullRequestUrls': [pr],
    if (linked || merged)
      'cards': {
        'pullRequests': [
          {'url': pr, 'messageId': 'm-$id', if (merged) 'mergedAt': 1},
        ],
      },
    'releasing': ?releasing,
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
    agents: [
      agent('agent-lead', name: 'Lead', displayName: 'River'),
      agent('agent-builder', displayName: 'Nova'),
      agent('agent-juno', displayName: 'Juno'),
    ],
    groups: [
      task(
        'g1',
        2156,
        'Buddy chat header',
        status: 'working',
        worker: 'agent-builder',
        priority: 'P1',
      ),
      task(
        'g2',
        2160,
        'Saved views cache',
        status: 'needs_human',
        worker: 'agent-juno',
      ),
      task('g3', 2170, 'Dark theme for the board'),
      task('g4', 2171, 'Phone Board', status: 'done', linked: true),
      task(
        'g5',
        2172,
        'Release notes',
        status: 'done',
        merged: true,
        releasing: ['desktop'],
      ),
    ],
  );
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
  fake.routes[dormant] = (_) => closedFail
      ? throw SuperTabFailure('INTERNAL', 'Oops', statusCode: 500)
      : {
          'groups': [
            {
              'key': 'g6',
              'version': 5,
              'changedAt': DateTime.now().millisecondsSinceEpoch,
              'data': {
                ...task(
                  'g6',
                  2173,
                  'Shipped last night',
                  status: 'done',
                  merged: true,
                ),
                'dormant': true,
                'shippedAt': yesterday.millisecondsSinceEpoch,
                'released': {
                  'at': 1,
                  'tags': ['v1.3.84_desktop'],
                },
              },
            },
          ],
          'next': null,
        };
  fake.routes[proposals] = (_) => proposalsFail
      ? throw SuperTabFailure('INTERNAL', 'Oops', statusCode: 500)
      : {
          'proposals': [
            {
              'messageId': 'prop-1',
              'title': 'Show the Board on the phone',
              'personId': me,
              'priority': 'P1',
              'at': 5,
            },
          ],
        };
  return fake;
}
