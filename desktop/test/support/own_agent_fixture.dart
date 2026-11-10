import 'pm_chat_fixture.dart';
import 'super_tab_fixture.dart';

/// [pmChatSwarm] where Ken (`peer`) reads it, owns a Mac, and the owner's
/// Studio is shared with the Swarm. [giveOwnAgent] gives someone an agent and
/// its 1:1 chat.
ConversationServer ownAgentSwarm() {
  final server = pmChatSwarm();
  server.state['machines'] = <dynamic>[
    {
      'machineId': 'ken-mac',
      'name': 'Kens-MacBook.local',
      'contributorId': 'peer',
      'scope': 'swarm',
      'engines': <dynamic>[],
      'maxAgents': 4,
      'availableSlots': 4,
      // Reporting now.
      'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
    },
    {
      'machineId': 'studio',
      'name': 'Studio.local',
      'contributorId': 'owner',
      'scope': 'swarm',
      'engines': <dynamic>[],
      'maxAgents': 8,
      'availableSlots': 8,
    },
  ];
  return server;
}

/// Gives [person] a running agent named [name] in [projectId], on [machineId],
/// with its 1:1 chat `agent-chat-<id>`, as the backend's agentChats.ts leaves
/// them.
void giveOwnAgent(
  ConversationServer server, {
  String person = 'peer',
  String projectId = 'lead',
  String id = 'wren',
  String name = 'Wren',
  String machineId = 'ken-mac',
  String machineOwnerId = 'peer',
  String engine = 'claude',
}) {
  (server.state['agents'] as List).add({
    'id': id,
    'name': name,
    'projectId': projectId,
    'machineId': machineId,
    'harnessId': 'h-$id',
    'contributorId': person,
    'machineOwnerId': machineOwnerId,
    'chatId': 'agent-chat-$id',
    'configuration': {'engine': engine, 'model': 'default'},
  });
  (server.state['conversations'] as List).add({
    ...conversationFixture('agent-chat-$id', name),
    'kind': 'agent-chat',
    'projectId': null,
    'agentIds': [id],
  });
}

/// The agent [agentId] posts [text] in [conversationId].
void agentReply(
  ConversationServer server,
  String conversationId,
  String text, {
  String agentId = 'wren',
  String name = 'Wren',
  Map<String, dynamic>? source,
}) {
  server.append(text, conversationId: conversationId);
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': agentId,
    'name': name,
  };
  if (source != null) server.messages.last['source'] = source;
}
