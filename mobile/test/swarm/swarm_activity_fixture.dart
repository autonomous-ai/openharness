import 'swarm_fixture.dart';

/// Activity's backend as a test scripts it (swarm_activity_test.dart,
/// swarm_activity_page_test.dart), built by hand so it reads like the wire.

const activityChatPath =
    '/api/super-tabs/$tab/conversations/$leadChat/messages';

Map<String, dynamic> activityMessage(
  String id,
  int sequence, {
  String text = '',
  bool mine = false,
  String? thread,
  List<Map<String, dynamic>> reactions = const [],
}) => {
  'id': id,
  'conversationId': leadChat,
  'text': text.isEmpty ? 'Row $id' : text,
  'sequence': sequence,
  'thread': thread ?? id,
  'author': mine
      ? {'kind': 'person', 'id': me, 'name': 'tony@example.com'}
      : {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
  'reactions': reactions,
  'createdAt': DateTime.utc(2026, 10, 29, 8, sequence).toIso8601String(),
};

Map<String, dynamic> activityThread(
  String root, {
  required int last,
  List<String> people = const [me],
  bool lastByMe = false,
}) => {
  'id': root,
  'replies': 2,
  'lastSequence': last,
  'lastAt': DateTime.utc(2026, 10, 29, 9, last).toIso8601String(),
  'authors': [
    lastByMe
        ? {'kind': 'person', 'id': me, 'name': 'tony@example.com'}
        : {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
  ],
  'people': people,
};

/// One Swarm, project Mobile: decision d1 (recommending "Merge"), River's
/// tag m1, work g1 waiting on the person, and a project chat whose newest
/// page [page] answers. The server's read mark of that chat is [readMark],
/// and its thread marks by root [threadMarks] (none from an older server).
FakeSwarm activityBackend({
  Map<String, dynamic> Function()? page,
  int readMark = 10,
  Map<String, int>? threadMarks,
  int chatSequence = 12,
  bool decision = true,
  List<Map<String, dynamic>> groups = const [],
}) {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me, 'lastChangedAt': 1},
    ],
    'next': null,
  };
  final derived = {
    'decisionsWaiting': decision ? 1 : 0,
    'mentionsWaiting': 1,
    'readMarks': {leadChat: readMark},
    'threadMarks': ?(threadMarks == null ? null : {leadChat: threadMarks}),
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) {
    final load = firstLoad(
      derived: derived,
      lastChangedAt: 1,
      groups: [
        groupData(
          'g1',
          title: 'Fix login',
          number: 4,
          status: 'needs_human',
          workerId: 'agent-builder',
        ),
        ...groups,
      ],
    );
    // The project chat holds [chatSequence] rows.
    final lead = (load['groups'] as List).first as Map<String, dynamic>;
    (lead['data'] as Map<String, dynamic>)['lastMessageSequence'] =
        chatSequence;
    return load;
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
      changes(cursor: 'c2', derived: derived, lastChangedAt: 1);
  fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
    'decisions': [
      if (decision)
        {
          'id': 'd1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'askerName': 'River',
          'question': 'Approve merge: PR #2154?',
          'options': ['Wait', 'Merge'],
          'recommended': 1,
        },
    ],
  };
  fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
    'mentions': [
      {
        'id': 'm1',
        'projectName': 'Mobile',
        'conversationId': leadChat,
        'conversationTitle': 'Mobile',
        'messageId': 'msg-tag',
        'leadName': 'River',
        'text': 'Can you check the copy?',
      },
    ],
  };
  fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
    'result': <String, dynamic>{},
  };
  fake.routes[activityChatPath] = (_) =>
      page?.call() ?? {'messages': <Object>[], 'next': null};
  return fake;
}

/// The project chat's newest page: the person's root-1 (a thread with a reply
/// since they read the chat), their mine-2 with River's ✅ and their own, own-only
/// with only their own 👀, root-old (a thread read already) and root-others (a
/// thread they are not in).
Map<String, dynamic> activityPage() => {
  'messages': [
    activityMessage('root-1', 3, text: 'Ship the build tonight?', mine: true),
    activityMessage(
      'mine-2',
      5,
      text: 'Copy is fixed.',
      mine: true,
      reactions: [
        {
          'emoji': 'check',
          'by': [
            {'kind': 'agent', 'id': 'agent-lead'},
            {'kind': 'person', 'id': me},
          ],
        },
      ],
    ),
    activityMessage(
      'own-only',
      6,
      mine: true,
      reactions: [
        {
          'emoji': 'eyes',
          'by': [
            {'kind': 'person', 'id': me},
          ],
        },
      ],
    ),
    activityMessage('root-old', 7),
    activityMessage('root-others', 8),
  ],
  'threads': [
    activityThread('root-1', last: 12),
    activityThread('root-old', last: 9),
    activityThread('root-others', last: 12, people: ['person-other']),
  ],
  'next': null,
};

/// Adds a second Swarm, [swarmId], to [fake]'s list, after the first: the
/// same project, chat and agent ids, its Lead Cleo and its builder Pip, and
/// a project chat whose newest page [page] answers.
void activitySecondSwarm(
  FakeSwarm fake, {
  String swarmId = 'tab-2',
  Map<String, dynamic> Function()? page,
}) {
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me, 'lastChangedAt': 2},
      {'id': swarmId, 'name': 'Other Swarm', 'ownerId': me, 'lastChangedAt': 1},
    ],
    'next': null,
  };
  final derived = {
    'readMarks': {leadChat: 10},
  };
  fake.routes['/api/super-tabs/$swarmId/parts'] = (_) {
    final load = firstLoad(
      tabId: swarmId,
      head: headData(id: swarmId, name: 'Other Swarm'),
      derived: derived,
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'Cleo'),
        agent('agent-builder', displayName: 'Pip'),
      ],
    );
    final lead = (load['groups'] as List).first as Map<String, dynamic>;
    (lead['data'] as Map<String, dynamic>)['lastMessageSequence'] = 12;
    return load;
  };
  fake.routes['/api/super-tabs/$swarmId/changes'] = (_) =>
      changes(cursor: 'c2', derived: derived);
  fake.routes['/api/super-tabs/$swarmId/decisions?state=open'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$swarmId/mentions?state=waiting'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes['/api/super-tabs/$swarmId/conversations/$leadChat/messages'] = (
    _,
  ) => page?.call() ?? {'messages': <Object>[], 'next': null};
}
