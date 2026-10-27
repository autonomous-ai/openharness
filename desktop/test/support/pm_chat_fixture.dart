import 'super_tab_fixture.dart';

/// A Swarm with a Lead in its project and two people: the owner and Ken, a
/// collaborator, each with their own chat with the Product Manager.
ConversationServer pmChatSwarm() {
  final server = ConversationServer();
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'ken.tran@example.com', 'role': 'collaborator'},
  ];
  server.state['agents'] = [
    {
      'id': 'lead-agent',
      'name': 'Lead',
      'machineId': 'm1',
      'harnessId': 'h1',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude', 'model': 'opus'},
    },
  ];
  (server.state['conversations'] as List).first
    ..['leadId'] = 'lead-agent'
    ..['agentIds'] = ['lead-agent'];
  return server;
}

/// The Product Manager (the project's Lead) writes [text] in [conversationId].
void pmReply(ConversationServer server, String conversationId, String text) {
  server.append(text, conversationId: conversationId);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
}
