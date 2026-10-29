import 'swarm_fixture.dart';

/// Buddies' backend as a test scripts it (swarm_buddy_list_test.dart,
/// swarm_buddies_page_test.dart), built by hand so it reads like the wire.

const buddiesWeb = 'project-2';
const buddiesDocs = 'project-3';

/// The person's Buddy chats: Mobile's, where Wren runs, and Web's, where
/// Kite is offline. Docs has none.
const buddiesMobileChat = 'buddy-mobile';
const buddiesWebChat = 'buddy-web';

/// Someone else's Buddy chat in Mobile: never listed, never read.
const buddiesTheirChat = 'buddy-ann';

String buddiesChatPath(String chat, {String swarmId = tab}) =>
    '/api/super-tabs/$swarmId/conversations/$chat/messages';

Map<String, dynamic> buddiesMessage(
  String chat,
  int sequence, {
  String text = '',
  bool mine = false,
  String author = 'agent-wren',
  String? thread,
}) => {
  'id': '$chat-$sequence',
  'conversationId': chat,
  'text': text.isEmpty ? 'Row $sequence' : text,
  'sequence': sequence,
  'thread': ?thread,
  'author': mine
      ? {'kind': 'person', 'id': me, 'name': 'person-me@example.com'}
      : {'kind': 'agent', 'id': author, 'name': 'Buddy'},
  'createdAt': DateTime.utc(2026, 10, 29, 8, sequence).toIso8601String(),
};

Map<String, dynamic> buddiesProject(String id, String name, String lead) => {
  'id': id,
  'name': name,
  'ownerId': me,
  'leadConversationId': lead,
  'visibility': 'public',
  'members': <Object>[],
  'updateMinutes': 5,
};

/// Swarm [swarmId]'s first load: Mobile, Web and Docs, each with its project
/// chat; the person's Buddy chats in Mobile ([mobileSequence] rows, Wren's
/// Buddy [wren] by name, running) and Web (4 rows, Kite offline); someone
/// else's Buddy chat in Mobile. The server's read marks are [readMarks].
Map<String, dynamic> buddiesLoad({
  String swarmId = tab,
  String swarmName = 'Phone Swarm',
  int mobileSequence = 7,
  int? mobileMainSequence,
  String wren = 'Wren',
  Map<String, int> readMarks = const {buddiesMobileChat: 5, buddiesWebChat: 4},
}) {
  Map<String, dynamic> inWeb(Map<String, dynamic> row) => {
    ...row,
    'projectId': buddiesWeb,
  };
  Map<String, dynamic> inDocs(Map<String, dynamic> row) => {
    ...row,
    'projectId': buddiesDocs,
  };
  return firstLoad(
    tabId: swarmId,
    derived: {'readMarks': readMarks},
    head: headData(
      id: swarmId,
      name: swarmName,
      projects: [
        buddiesProject(project, 'Mobile', leadChat),
        buddiesProject(buddiesWeb, 'Web', 'group-lead-web'),
        buddiesProject(buddiesDocs, 'Docs', 'group-lead-docs'),
      ],
    ),
    agents: [
      agent('agent-lead', name: 'Lead', displayName: 'River'),
      buddyData('agent-wren', displayName: wren),
      inWeb({
        ...buddyData('agent-kite', displayName: 'Kite'),
        'downSince': '2026-10-29T07:00:00.000Z',
      }),
      buddyData('agent-ann', owner: 'person-ann', displayName: 'Ann'),
    ],
    groups: [
      {
        ...buddyChatData(
          buddiesMobileChat,
          agentIds: ['agent-wren'],
          lastMessageSequence: mobileSequence,
        ),
        'lastMainSequence': ?mobileMainSequence,
      },
      inWeb(
        buddyChatData(
          buddiesWebChat,
          agentIds: ['agent-kite'],
          lastMessageSequence: 4,
        ),
      ),
      buddyChatData(
        buddiesTheirChat,
        owner: 'person-ann',
        agentIds: ['agent-ann'],
        lastMessageSequence: 3,
      ),
      inWeb(groupData('group-lead-web', title: 'Web', leadId: 'agent-lead')),
      inDocs(groupData('group-lead-docs', title: 'Docs', leadId: 'agent-lead')),
    ],
  );
}

/// One Swarm as [buddiesLoad] has it. Mobile's Buddy chat answers Wren's
/// last line, Web's the person's own; every other chat answers nothing.
FakeSwarm buddiesBackend({
  int mobileSequence = 7,
  int? mobileMainSequence,
  Map<String, int> readMarks = const {buddiesMobileChat: 5, buddiesWebChat: 4},
}) {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me, 'lastChangedAt': 1},
    ],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => buddiesLoad(
    mobileSequence: mobileSequence,
    mobileMainSequence: mobileMainSequence,
    readMarks: readMarks,
  );
  fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
      changes(cursor: 'c2', derived: {'readMarks': readMarks});
  fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/commands'] = (body) => {
    'result': switch (body?['command']) {
      {'type': 'buddy.chat', 'projectId': buddiesDocs} => {
        'conversationId': 'buddy-docs',
      },
      _ => <String, dynamic>{},
    },
  };
  fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
    'messages': <Object>[],
    'next': null,
  };
  fake.routes[buddiesChatPath(buddiesMobileChat)] = (_) => {
    'messages': [
      buddiesMessage(buddiesMobileChat, 7, text: 'Done: the build is up.'),
    ],
    'threads': <Object>[],
    'next': null,
  };
  fake.routes[buddiesChatPath(buddiesWebChat)] = (_) => {
    'messages': [
      buddiesMessage(buddiesWebChat, 4, text: 'Is 0.9 out yet?', mine: true),
    ],
    'threads': <Object>[],
    'next': null,
  };
  return fake;
}
