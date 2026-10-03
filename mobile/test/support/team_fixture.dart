const teamId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherTeamId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const questionId = 'cccccccccccccccccccccccccccccccc';
const mobileId = 'dddddddddddddddddddddddddddddddd';
const daemonId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

Map<String, dynamic> teamFixture({
  String id = teamId,
  int revision = 1,
  bool answered = true,
}) => {
  'id': id,
  'name': 'Harness team',
  'description': 'Build across the stack',
  'machineId': 'host',
  'state': 'active',
  'revision': revision,
  'members': [
    {
      'id': mobileId,
      'name': 'mobile',
      'role': 'Phone UI and device pairing',
      'machineId': 'host',
      'agentId': 'mobile-session',
      'enabled': true,
      'runtime': {'engine': 'claude', 'available': true},
    },
    {
      'id': daemonId,
      'name': 'daemons',
      'role': 'Daemon lifecycle and API contracts',
      'machineId': 'host',
      'agentId': 'daemon-session',
      'enabled': true,
      'runtime': {'engine': 'codex', 'available': true},
    },
  ],
  'exchanges': [
    if (answered)
      {
        'id': questionId,
        'from': mobileId,
        'to': daemonId,
        'origin': 'agent',
        'state': 'answered',
        'text': 'Which endpoint should mobile use to read daemon status?',
        'delivery': {'state': 'started'},
        'continuation': {'state': 'queued', 'reason': 'team_waiting_draft'},
        'answer': {
          'text': 'Use GET /api/daemons. Read the state field and keep the last known status while the machine reconnects.',
          'origin': 'agent',
          'author': daemonId,
          'at': 1790500000000,
          'late': false,
          'evidence': ['routes/daemons.ts:24'],
        },
      },
  ],
};
