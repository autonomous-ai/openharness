import 'package:harness_mobile/swarm/swarm_reader.dart';

import 'swarm_fixture.dart';

/// The person's one Buddy chat with thread sessions on, as the server sends it
/// (backend read/contract.ts `swarmBuddy`, `threadSessions`, `sessionsFromChat`),
/// over the projects Mobile and Web.
const sessionChat = 'buddy-one';
const webProject = 'project-web';
const sessionCommands = '/api/super-tabs/$tab/commands';
const sessionMessages =
    '/api/super-tabs/$tab/conversations/$sessionChat/messages';

Map<String, dynamic> sessionMessage(
  String id,
  int sequence, {
  String? root,
  bool session = false,
  Map<String, dynamic>? source,
  String author = 'agent-wren',
}) => {
  'id': id,
  'conversationId': sessionChat,
  'text': 'text of $id',
  'sequence': sequence,
  'author': author == me
      ? {'kind': 'person', 'id': me, 'name': 'tony'}
      : {'kind': 'agent', 'id': author, 'name': 'Wren'},
  'attachments': <Object>[],
  'reactions': <Object>[],
  'createdAt': DateTime.utc(2026, 11, 2, 1, sequence).toIso8601String(),
  'thread': root ?? id,
  if (session) 'buddySession': true,
  'source': ?source,
};

/// A machine reporting now, able to run thread sessions unless [capabilities]
/// says otherwise.
Map<String, dynamic> sessionMachine({
  String id = 'mac-1',
  String name = 'Tonys-MacBook-Pro.local',
  List<String>? capabilities = const ['buddySessions'],
}) => {
  'machineId': id,
  'name': name,
  'contributorId': me,
  'engines': ['claude', 'codex'],
  'observation': {
    'receivedAt': DateTime.now().millisecondsSinceEpoch,
    'capabilities': ?capabilities,
  },
};

/// One Swarm where the person's one Buddy chat has [page], its Buddy running
/// unless [buddy] is false, and [sessions] live in it.
FakeSwarm sessionBackend({
  List<Map<String, dynamic>> page = const [],
  List<Map<String, dynamic>> sessions = const [],
  List<Map<String, dynamic>> extraAgents = const [],
  bool buddy = true,
  String engine = 'claude',
  String? downSince,
  bool paused = false,
  bool threadSessions = true,
  bool sessionsFromChat = true,
  bool swarmBuddy = true,
  bool swarmChat = true,
  String role = 'owner',
  Map<String, dynamic>? machine,
}) {
  final derived = {
    'swarmBuddy': swarmBuddy,
    'threadSessions': threadSessions,
    'sessionsFromChat': sessionsFromChat,
  };
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
    ...firstLoad(
      head: {
        ...headData(
          projects: [
            ...(headData()['projects'] as List).cast<Map<String, dynamic>>(),
            {
              'id': webProject,
              'name': 'Web',
              'ownerId': me,
              'leadConversationId': 'lead-web',
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        'paused': paused,
      },
      groups: [
        {
          ...groupData(
            sessionChat,
            title: "$me's Buddy",
            agentIds: [if (buddy) 'agent-wren'],
            lastMessageSequence: page.length,
          ),
          'kind': swarmChat ? 'swarm-buddy' : 'buddy',
          'buddyOwnerId': me,
          'buddySessions': sessions,
          if (swarmChat) 'projectId': null,
        }..removeWhere((k, v) => k == 'projectId' && v == null),
        {...groupData('lead-web', title: 'Web'), 'projectId': webProject},
      ],
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        if (buddy)
          {
            ...buddyData('agent-wren', displayName: 'Wren', engine: engine),
            if (swarmChat) 'buddyScope': 'swarm',
            'downSince': ?downSince,
            if (swarmChat) 'projectId': null,
          }..removeWhere((k, v) => k == 'projectId' && v == null),
        ...extraAgents,
      ],
      machines: [machine ?? sessionMachine()],
      derived: derived,
    ),
    'members': [part(me, 1, person(me, role: role))],
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
      changes(cursor: 'c2', derived: derived);
  fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes[sessionMessages] = (_) => {
    'messages': page.reversed.toList(),
    'next': null,
  };
  fake.routes[sessionCommands] = (_) => {'result': <String, dynamic>{}};
  return fake;
}

/// A reader of [fake]'s Swarm, read once.
Future<SwarmReader> sessionReader(FakeSwarm fake) async {
  final reader = SwarmReader(tabId: tab, accountId: me, request: fake.request);
  await reader.refresh();
  return reader;
}
