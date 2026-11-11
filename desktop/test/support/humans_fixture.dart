import 'pm_chat_fixture.dart';
import 'super_tab_fixture.dart';

/// Seven people, so a cut-off list would hide some.
ConversationServer humansSwarm() {
  final server = pmChatSwarm();
  (server.state['agents'] as List).first['displayName'] = 'River';
  server.state['people'] = [
    {'id': 'owner', 'email': 'ken@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'dee@example.com', 'role': 'collaborator'},
    for (final name in [
      'tony',
      'scholes',
      'diego',
      'huy',
      'maximilian.alexander.longname',
    ])
      {'id': name, 'email': '$name@example.com', 'role': 'collaborator'},
  ];
  server.state['projects'] = [projectFixture('lead', 'Pilot', 'lead')];
  server.state['machines'] = [
    {'machineId': 'studio', 'name': 'Mac Studio', 'contributorId': 'owner'},
  ];
  return server;
}

/// Adds workgroups #1 to #[count] to the Pilot project, created in that order.
void addNumberedWorkgroups(ConversationServer server, int count) {
  final conversations = server.state['conversations'] as List;
  for (var number = 1; number <= count; number++) {
    conversations.add({
      ...conversationFixture('g$number', 'Workgroup $number'),
      'number': number,
    });
  }
}

/// The Pilot project's PM River, a Builder Luna and Dee's agent Sparky;
/// another project's agent is named Luna.
ConversationServer membersSwarm() {
  final server = humansSwarm();
  final agents = server.state['agents'] as List;
  final lead = (agents.first as Map).cast<String, dynamic>()
    ..['machineId'] = 'studio';
  server.state['agents'] = <Object>[
    lead,
    {
      ...lead,
      'id': 'luna',
      'harnessId': 'h-luna',
      'name': 'Luna',
      'displayName': 'Luna',
      'projectId': 'lead',
    },
    {
      ...lead,
      'id': 'sparky',
      'harnessId': 'h-sparky',
      'name': 'Sparky',
      'displayName': 'Sparky',
    },
  ];
  return server;
}
