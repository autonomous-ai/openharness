import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'super_tab_fixture.dart';

/// One project, "web-project", whose chat is `lead`; `offline` is a workgroup
/// of it that Kestrel works in.
ConversationServer swarm() {
  final server = ConversationServer()..threads = true;
  server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
  server.state['agents'] = [
    {
      'id': 'kestrel',
      'projectId': 'lead',
      'name': 'Builder',
      'displayName': 'Kestrel',
      'machineId': 'host',
      'harnessId': 'session',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  final offline = _group(server, 'offline');
  offline
    ..['projectId'] = 'lead'
    ..['title'] = 'Windows credential fix'
    ..['agentIds'] = ['kestrel'];
  return server;
}

Map<String, dynamic> _group(ConversationServer server, String id) =>
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == id);

/// The task in `offline` whose agent asked [askedOf], the default reader, by name.
void wait(ConversationServer server, {String askedOf = 'owner'}) {
  _group(server, 'offline')['assignment'] = {
    'id': 'a1',
    'agentId': 'kestrel',
    'status': 'needs_human',
    'askedOf': askedOf,
  };
}

/// A controller over [server] for [account], read once; disposed when the test ends.
Future<SuperTabController> load(
  ConversationServer server, {
  String account = 'owner',
}) async {
  final c = server.controller(account: account);
  addTearDown(() async {
    await c.flush();
    c.dispose();
  });
  await c.refresh();
  return c;
}

/// An agent of the reader named [name], with its own chat where it wrote to them and they have not read it: one that
/// asks them (Swarm v4).
void addAskingAgent(ConversationServer server, String name) {
  (server.state['agents'] as List).add({
    'id': name,
    'name': name,
    'machineId': 'host',
    'harnessId': 'session-$name',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
    'chatId': 'agent-chat-$name',
    'myAgent': true,
  });
  (server.state['conversations'] as List).add({
    ...conversationFixture('agent-chat-$name', name),
    'kind': 'agent-chat',
    'agentIds': [name],
  });
  server.append(
    'Which build?',
    conversationId: 'agent-chat-$name',
    agent: true,
  );
  server.messages.last['author'] = {'kind': 'agent', 'id': name, 'name': name};
}
