import 'pm_chat_fixture.dart';
import 'super_tab_fixture.dart';

/// [pmChatSwarm] with Buddies turned on: Ken (`peer`) reads it, owns a Mac,
/// and the owner's Studio is shared with the Swarm. Ken has no Buddy yet;
/// [giveBuddy] adds one.
ConversationServer buddySwarm({bool enabled = true}) {
  final server = pmChatSwarm();
  if (enabled) server.state['buddies'] = true;
  server.state['machines'] = <dynamic>[
    {
      'machineId': 'ken-mac',
      'name': 'Kens-MacBook.local',
      'contributorId': 'peer',
      'scope': 'swarm',
      'engines': <dynamic>[],
      'maxAgents': 4,
      'availableSlots': 4,
      // Reporting now: the Buddy pickers offer a Swarm machine no account
      // list confirms only while it reports (buddyMachines).
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

/// Gives [person] a running Buddy named [name] in [projectId], on [machineId],
/// with its private chat, as the backend's `buddy.add` leaves them.
void giveBuddy(
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
    'buddyOf': {'personId': person, 'generation': 'fixture'},
    'machineId': machineId,
    'harnessId': 'h-$id',
    'contributorId': person,
    'machineOwnerId': machineOwnerId,
    'confidential': true,
    'configuration': {'engine': engine, 'model': 'default'},
  });
  (server.state['conversations'] as List).add({
    ...conversationFixture('buddy-$person-$projectId', "$person's Buddy"),
    'kind': 'buddy',
    'projectId': projectId,
    'buddyOwnerId': person,
    'agentIds': [id],
  });
}

/// The Buddy [agentId] posts [text] in [conversationId].
void buddyReply(
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

/// [person]'s Buddy in [projectId] being added: its chat and its start, with
/// no agent yet. With [error] the start failed.
void startBuddy(
  ConversationServer server, {
  String person = 'peer',
  String projectId = 'lead',
  // A Buddy runs only on its person's own machines (Ken, 10-28).
  String machineId = 'ken-mac',
  String engine = 'claude',
  String? error,
}) {
  (server.state['conversations'] as List).add({
    ...conversationFixture('buddy-$person-$projectId', "$person's Buddy"),
    'kind': 'buddy',
    'projectId': projectId,
    'buddyOwnerId': person,
    'agentIds': <String>[],
  });
  server.state['starts'] = [
    {
      'id': 'start-1',
      'machineOwnerId': person,
      'request': {
        'conversationId': 'buddy-$person-$projectId',
        'machineId': machineId,
        'engine': engine,
        'buddyOf': {'personId': person, 'generation': 'fixture'},
      },
      'harnessId': null,
      'error': error,
    },
  ];
}

/// [buddySwarm] on a server with one Buddy per person for the whole Swarm
/// (spec 2026-10-31-one-buddy-per-swarm).
ConversationServer oneBuddySwarm() {
  final server = buddySwarm();
  server.state['swarmBuddy'] = true;
  // Ken's Mac runs the one Buddy and its sessions (backend SWARM_BUDDY_CAPABILITY).
  ((server.state['machines'] as List).first as Map)['observation'] = {
    'receivedAt': DateTime.now().millisecondsSinceEpoch,
    'capabilities': ['buddySessions', 'swarmBuddy'],
  };
  server.state['threadSessions'] = true;
  server.state['sessionsFromChat'] = true;
  return server;
}

/// Gives [person] their one running Buddy [name] and its chat, in no project,
/// as the backend's `buddy.create` with no project leaves them.
void giveSwarmBuddy(
  ConversationServer server, {
  String person = 'peer',
  String id = 'wren',
  String name = 'Wren',
  String machineId = 'ken-mac',
}) {
  (server.state['agents'] as List).add({
    'id': id,
    'name': name,
    'buddyScope': 'swarm',
    'buddyOf': {'personId': person, 'generation': 'fixture'},
    'machineId': machineId,
    'harnessId': 'h-$id',
    'contributorId': person,
    'machineOwnerId': person,
    'confidential': true,
    'configuration': {'engine': 'claude', 'model': 'default'},
  });
  (server.state['conversations'] as List).add({
    ...conversationFixture('swarm-buddy-$person', "$person's Buddy"),
    'kind': 'swarm-buddy',
    'projectId': null,
    'buddyOwnerId': person,
    'agentIds': [id],
  });
}
