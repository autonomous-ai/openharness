import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_outbox.dart' show SwarmPost;
import 'swarm_reader.dart';

// Buddy thread sessions on the phone (spec docs/superpowers/specs/2026-10-30-
// buddy-thread-sessions-design.md; Desktop's `SuperTabController` and
// `buddy_sessions.dart`): a message or thread of the person's own Buddy chat
// may start a session of its own, answering there while the Buddy keeps
// answering the chat. This holds the rules for when that is offered and the
// words for how a session stands; the chat and its thread carry the choice.

/// What a message refused for New session says: the server does not take it
/// yet (an older backend, or one of its servers during a release).
const swarmSessionsUnavailable =
    "New sessions aren't available yet; send without it?";

/// Whether [post] was refused only because the server does not know New
/// session (the schema's `Unrecognized key`, naming the field).
bool swarmRefusedForSessions(SwarmPost post) {
  final command = post.body['command'];
  final failure = post.refusedBy;
  return command is Map &&
      command['newSession'] == true &&
      failure != null &&
      failure.code == 'VALIDATION_ERROR' &&
      failure.message.contains('Unrecognized key') &&
      failure.message.contains('newSession');
}

/// How long New session is not offered after a server refused it.
const swarmSessionsRefusedFor = Duration(minutes: 10);

final _refusedAt = Expando<DateTime>('swarm sessions refused');

/// [reader]'s server refused New session as an unknown field, though it said
/// it takes it: not offered for [swarmSessionsRefusedFor] after.
void swarmSessionsRefused(SwarmReader reader, {DateTime? now}) =>
    _refusedAt[reader] = now ?? DateTime.now();

bool _serverTakesSessions(SwarmReader reader, {required bool fromChat}) {
  final snapshot = reader.snapshot;
  if (snapshot == null ||
      !snapshot.threadSessions ||
      (fromChat && !snapshot.sessionsFromChat)) {
    return false;
  }
  final refused = _refusedAt[reader];
  return refused == null ||
      DateTime.now().difference(refused) >= swarmSessionsRefusedFor;
}

/// Whether [chat] is the reader's own Buddy chat, where a thread may have a
/// session of its own: not someone else's, nor an older one kept to read.
bool _ownBuddyChat(SwarmReader reader, SuperTabConversation chat) =>
    !reader.accessRevoked &&
    chat.isBuddyChat &&
    chat.buddyOwnerId == reader.accountId &&
    !swarmIsOldBuddyChat(reader, chat.id);

/// Whether [chat]'s own composer shows New session: the reader's own Buddy
/// chat, with a Buddy, on a server that takes New session on a top-level
/// message. It may still show disabled, saying why ([swarmSessionBlocked]).
bool swarmOffersChatSessions(SwarmReader reader, SuperTabConversation chat) =>
    _ownBuddyChat(reader, chat) &&
    _serverTakesSessions(reader, fromChat: true) &&
    swarmBuddy(reader, chat.projectId) != null;

/// Whether [chat]'s thread reply box shows New session: the reader's own
/// Buddy chat, with a Buddy — or a thread that [hadSession], whose reply must
/// start a new one. It may still show disabled, saying why.
bool swarmOffersThreadSessions(
  SwarmReader reader,
  SuperTabConversation chat, {
  required bool hadSession,
}) =>
    _ownBuddyChat(reader, chat) &&
    _serverTakesSessions(reader, fromChat: false) &&
    (swarmBuddy(reader, chat.projectId) != null || hadSession);

/// Why [chat] cannot start a session now, as the disabled choice says it;
/// null when it can, as far as the phone can tell (the server still decides,
/// and its refusal shows in the composer).
String? swarmSessionBlocked(SwarmReader reader, SuperTabConversation chat) {
  final snapshot = reader.snapshot;
  if (snapshot == null) return null;
  if (snapshot.paused) return 'New work is paused in this Swarm';
  final main = swarmBuddy(reader, chat.projectId);
  if (main == null || main.downSince != null) return 'Start your Buddy first';
  if (main.engine != 'claude') return 'Sessions need a Claude Code Buddy';
  // The host says what it can run in its report; a machine the phone has no
  // report of is left to the server.
  final observation = snapshot.pool(main.machineId)?['observation'];
  if (observation is Map) {
    final capabilities = observation['capabilities'];
    if (capabilities is! List || !capabilities.contains('buddySessions')) {
      return 'Update Harness on ${swarmBuddyMachineName(reader, main.machineId)} '
          'to start sessions';
    }
  }
  return null;
}

/// Why a session ended, as its thread says it.
String swarmSessionEndedWords(String? reason) => switch (reason) {
  'idle' => 'Session ended: idle for 30 minutes',
  'ended' => 'Session ended: you ended it',
  'stopped' => 'Session ended: it stopped unexpectedly',
  'failed' => 'Session ended: it couldn\'t start',
  'removed' => 'Session ended: its Buddy was removed or replaced',
  'maintenance' => 'Session ended: Harness was updated',
  _ => 'Session ended',
};

/// A live session's line: which session it is and how it stands. A session of
/// one project names it ("Web session"), else it is the "Own session"; it is
/// starting until its agent joins, offline while its machine reports it gone,
/// else running (the phone sees no terminal to tell working from idle).
String swarmSessionWords(
  SwarmReader reader,
  SuperTabConversation chat,
  SuperTabBuddySession session,
) {
  final agent = session.agentId == null
      ? null
      : reader.snapshot?.agent(session.agentId!);
  final projectId = agent?.buddySession?.projectId;
  final project = projectId == null
      ? null
      : reader.snapshot?.projects.where((p) => p.id == projectId).firstOrNull;
  final who = project == null ? 'Own session' : '${project.name} session';
  final state = agent == null
      ? 'Starting…'
      : agent.downSince != null
      ? '${swarmBuddyMachineName(reader, agent.machineId)} is offline'
      : 'Running';
  return '$who · $state';
}
