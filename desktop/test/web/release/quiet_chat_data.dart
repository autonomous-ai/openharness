// The made-up Swarm behind quiet_chat_app.dart.
import '../../support/super_tab_fixture.dart';

final _today = DateTime.now();
String _at(int hour, int minute) => DateTime(
  _today.year,
  _today.month,
  _today.day,
  hour,
  minute,
).toUtc().toIso8601String();

Map<String, dynamic> _author(String id, String name, {bool person = false}) => {
  'kind': person ? 'person' : 'agent',
  'id': id,
  'name': name,
};

Map<String, dynamic> _message(
  String id,
  String conversation,
  int sequence,
  Map<String, dynamic> author,
  String text,
  String at, {
  Map<String, Object?> source = const {},
}) => {
  'id': id,
  'thread': id,
  'conversationId': conversation,
  'sequence': sequence,
  'text': text,
  'createdAt': at,
  'author': author,
  'source': source,
};

Map<String, dynamic> _line(
  String id,
  int sequence,
  String task,
  String title,
  String state, {
  String? answerFor,
}) => _message(
  id,
  'lead',
  sequence,
  _author('river', 'River'),
  '$title · $state',
  _at(8, sequence),
  source: {
    'kind': 'task-line',
    'taskId': task,
    'title': title,
    'state': state,
    'answerFor': ?answerFor,
  },
);

ConversationServer quietChatServer(String screen) {
  final server = ConversationServer();
  const projects = ['computer', 'lamp', 'physical-router', 'spaceship'];
  final conversations = server.state['conversations'] as List;
  server.state['projects'] = [
    for (final name in projects) projectFixture(name, name, 'lead-$name'),
    {
      ...projectFixture('lead', 'openharness', 'lead'),
      'coordinatorName': 'Product Manager',
      'status': {
        'text':
            'Three fixes are on main tonight. Windows credential fix: last '
            "real Windows run going. Ken's five database fixes: one ready, "
            "four in review. Dee's calmer app: design out for review.",
        'at': _at(20, 33),
        'by': 'river',
      },
    },
  ];
  for (final name in projects) {
    conversations.add({
      ...conversationFixture('lead-$name', name),
      'projectId': name,
    });
  }
  for (final (id, title) in [
    ('task-closed', 'Closed agents leave the list'),
    ('task-windows', 'Windows credential fix'),
    ('task-phone', 'Phone Activity opens the right message'),
  ]) {
    conversations.add({
      ...conversationFixture(id, title),
      'projectId': 'lead',
      'leadId': 'theo',
      'assignment': {
        'agentId': 'theo',
        'builderAgentId': 'theo',
        'status': 'review',
      },
      'agentIds': ['theo'],
    });
  }
  (server.state['agents'] as List? ?? (server.state['agents'] = [])).addAll([
    for (final (id, name) in [
      ('river', 'River'),
      ('theo', 'Theo'),
      ('reed', 'Reed'),
    ])
      {
        'id': id,
        'name': name,
        'machineId': 'studio',
        'harnessId': 'h',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
  ]);
  final rows = screen == '2'
      ? [
          _line(
            'a',
            1,
            'task-phone',
            'Phone Activity opens the right message',
            'planned',
          ),
          _line(
            'b',
            2,
            'task-phone',
            'Phone Activity opens the right message',
            'working',
          ),
          _line(
            'c',
            3,
            'task-phone',
            'Phone Activity opens the right message',
            'waiting',
            answerFor: 'owner',
          ),
          _line(
            'd',
            4,
            'task-phone',
            'Phone Activity opens the right message',
            'review',
          ),
          _line(
            'e',
            5,
            'task-phone',
            'Phone Activity opens the right message',
            'shipped',
          ),
          _line(
            'f',
            6,
            'task-phone',
            'Phone Activity opens the right message',
            'stopped',
          ),
        ]
      : [
          _message(
            'm1',
            'lead',
            1,
            _author('ken', 'ken15', person: true),
            'Prod DB profile: five slow reads to fix.',
            _at(18, 50),
          ),
          _line(
            'l1',
            2,
            'task-closed',
            'Closed agents leave the list',
            'shipped',
          ),
          _line('l2', 3, 'task-windows', 'Windows credential fix', 'review'),
          _message(
            'p1',
            'lead',
            4,
            _author('buddy', "diego's Buddy"),
            "Proposal from diego's Buddy, on diego's behalf.\n\nGoal: Activity read fix\nScope: The app\nPriority: high",
            _at(20, 2),
            source: {
              'kind': 'buddy-proposal',
              'personId': 'diego',
              'ownerMessageId': 'x',
            },
          ),
          _message(
            'm2',
            'lead',
            5,
            _author('river', 'River'),
            'Three fixes are on main.',
            _at(20, 9),
          ),
          _message(
            'n1',
            'lead',
            6,
            _author('river', 'River'),
            'Theo has gone quiet on a task.',
            _at(20, 20),
            source: {'kind': 'work-stalled'},
          ),
          _message(
            'm3',
            'lead',
            7,
            _author('dee', 'dee', person: true),
            "ok i like a. let's make it perfect.",
            _at(20, 41),
          ),
        ];
  server.messages.addAll(rows);
  (conversations.firstWhere((g) => (g as Map)['id'] == 'lead')
          as Map)['lastMessageSequence'] =
      rows.length;
  server.state['people'] = [
    ...(server.state['people'] as List? ?? const []),
    for (final name in ['diego', 'ken', 'dee'])
      {
        'id': name,
        'email': '$name@example.com',
        'username': name,
        'role': 'member',
      },
  ];
  if (screen == '1') {
    server.state['readMarks'] = {
      'owner': {'lead': 5},
    };
  }
  final thread = [
    (_author('theo', 'Theo'), 'Ready: PR #2605.', _at(20, 12)),
    (_author('reed', 'Reed'), 'With fixes: one Important.', _at(20, 20)),
    (_author('theo', 'Theo'), 'Fixed at 98bcfd21c.', _at(20, 31)),
  ];
  for (final (i, (author, text, at)) in thread.indexed) {
    server.messages.add(
      _message('t$i', 'task-windows', i + 1, author, text, at),
    );
  }
  (conversations.firstWhere((g) => (g as Map)['id'] == 'task-windows')
          as Map)['lastMessageSequence'] =
      thread.length;

  return server;
}
