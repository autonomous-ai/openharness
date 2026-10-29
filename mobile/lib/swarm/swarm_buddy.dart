import 'package:flutter/foundation.dart';

import 'identity.dart';
import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What the phone knows of Buddies (spec: Buddies, 10-28; in every Swarm
/// since #2090, where they replaced Chat with PM): each person's Buddy chat in
/// each project, where the PM's private lines to them land, and the Buddy that
/// may run in it. Read from a Swarm's raw state, as [SwarmReader.partners] is:
/// the model the phone shares with the desktop (`model.dart`, held to it by
/// `desktop_parity_test.dart`) does not carry Buddies on this branch yet.
@immutable
class SwarmBuddies {
  const SwarmBuddies._({
    required this.chatOwners,
    required this.buddyOwners,
    required this.ownChats,
    required this.ownBuddies,
    required this.ownStarts,
  });

  /// Nothing read yet, or nothing left to read.
  static const none = SwarmBuddies._(
    chatOwners: {},
    buddyOwners: {},
    ownChats: {},
    ownBuddies: {},
    ownStarts: [],
  );

  /// [state]'s Buddies, as [accountId] reads them. A group or agent from
  /// before projects belongs to the first, as the model reads it.
  factory SwarmBuddies.read(Map<String, dynamic> state, String accountId) {
    final chatOwners = <String, String>{};
    final ownChats = <String, String>{};
    for (final row in _rows(state['conversations'])) {
      if (row case {
        'kind': 'buddy',
        'id': final String id,
        'buddyOwnerId': final String owner,
      }) {
        chatOwners[id] = owner;
        if (owner == accountId) {
          ownChats.putIfAbsent(row['projectId'] as String? ?? 'lead', () => id);
        }
      }
    }
    final buddyOwners = <String, String>{};
    final ownBuddies = <String, String>{};
    for (final row in _rows(state['agents'])) {
      if (row case {
        'id': final String id,
        'buddyOf': {'personId': final String person},
      }) {
        buddyOwners[id] = person;
        if (person == accountId) {
          ownBuddies.putIfAbsent(
            row['projectId'] as String? ?? 'lead',
            () => id,
          );
        }
      }
    }
    return SwarmBuddies._(
      chatOwners: Map.unmodifiable(chatOwners),
      buddyOwners: Map.unmodifiable(buddyOwners),
      ownChats: Map.unmodifiable(ownChats),
      ownBuddies: Map.unmodifiable(ownBuddies),
      ownStarts: List.unmodifiable([
        for (final row in _rows(state['starts']))
          if (row
              case {'request': {'buddyOf': {'personId': final String person}}}
              when person == accountId)
            Map<String, dynamic>.unmodifiable(row),
      ]),
    );
  }

  /// Every Buddy chat the read holds, anyone's, with the person it belongs
  /// to: none of them is a workgroup.
  final Map<String, String> chatOwners;

  /// Every Buddy the read holds, anyone's, with the person it belongs to.
  final Map<String, String> buddyOwners;

  /// The reader's own Buddy chat in each project, by project id.
  final Map<String, String> ownChats;

  /// The reader's own Buddy in each project, its agent id by project id.
  final Map<String, String> ownBuddies;

  /// The starts of the reader's own Buddies, oldest first: one is under way
  /// while it has neither a harness nor an error.
  final List<Map<String, dynamic>> ownStarts;

  static Iterable<Map<String, dynamic>> _rows(Object? list) => [
    if (list is List)
      for (final row in list)
        if (row is Map) Map<String, dynamic>.from(row),
  ];
}

/// The person's own Buddy chat in [projectId]; null while the read holds none
/// (none opened yet, or quiet for a day and left out of a first load).
SuperTabConversation? swarmBuddyChat(SwarmReader reader, String projectId) =>
    switch (reader.buddies.ownChats[projectId]) {
      final id? => reader.snapshot?.conversation(id),
      null => null,
    };

/// The person's own Buddy in [projectId]; null while none runs there.
SuperTabAgent? swarmBuddy(SwarmReader reader, String projectId) =>
    switch (reader.buddies.ownBuddies[projectId]) {
      final id? => reader.snapshot?.agent(id),
      null => null,
    };

/// Whether [conversationId] is a Buddy chat, anyone's.
bool swarmIsBuddyChat(SwarmReader reader, String conversationId) =>
    reader.buddies.chatOwners.containsKey(conversationId);

/// Whether [conversationId] is the person's own Buddy chat, in any project.
bool swarmIsOwnBuddyChat(SwarmReader reader, String conversationId) =>
    reader.buddies.chatOwners[conversationId] == reader.accountId;

/// Whether [message] is one of the PM's private lines to the person: its
/// project's Lead writing in the person's own Buddy chat, where it writes but
/// cannot read (#2090; the desktop's `_shownAuthor`).
bool swarmIsPmLine(SwarmReader reader, SuperTabMessage message) {
  if (!message.fromAgent ||
      !swarmIsOwnBuddyChat(reader, message.conversationId)) {
    return false;
  }
  final snapshot = reader.snapshot;
  final project = snapshot?.projectFor(message.conversationId);
  return project != null &&
      snapshot!.conversation(project.leadConversationId)?.leadId ==
          message.authorId;
}

/// The newest start of the person's Buddy in [projectId]: under way while it
/// has neither a harness nor an error, failed with an error (the desktop's
/// `SuperTabController.buddyStart`).
Map<String, dynamic>? swarmBuddyStart(SwarmReader reader, String projectId) {
  final chat = reader.buddies.ownChats[projectId];
  for (final start in reader.buddies.ownStarts.reversed) {
    final request = start['request'] as Map;
    if (request['projectId'] == projectId ||
        (chat != null && request['conversationId'] == chat)) {
      return start;
    }
  }
  return null;
}

/// The engines a Buddy runs on (spec: Buddies, 10-28), as people read them.
const swarmBuddyEngines = {'claude': 'Claude', 'codex': 'Codex'};

/// An engine as people read it: "Claude", "Codex".
String swarmBuddyEngineName(String engine) =>
    swarmBuddyEngines[engine] ??
    (engine.isEmpty ? 'Agent' : engine[0].toUpperCase() + engine.substring(1));

/// The person's Buddy in [projectId] by its name, or plain "Buddy" while none
/// runs (docs/naming-system.md: Buddies).
String swarmBuddyName(SwarmReader reader, String projectId) =>
    switch (swarmBuddy(reader, projectId)) {
      final agent? => reader.snapshot!.agentName(agent.id, fallback: 'Buddy'),
      null => 'Buddy',
    };

/// How the person's Buddy in [projectId] stands, in a quiet word after its
/// name: "starting" while a start is under way, "not started" with none
/// running, "offline" while it is down; null while it runs (the desktop's
/// Buddies rows).
String? swarmBuddyNote(SwarmReader reader, String projectId) {
  final agent = swarmBuddy(reader, projectId);
  if (agent != null) return agent.downSince == null ? null : 'offline';
  final start = swarmBuddyStart(reader, projectId);
  return start != null && start['harnessId'] == null && start['error'] == null
      ? 'starting'
      : 'not started';
}

/// Whether the person may write in [reader]'s Swarm: start or remove a
/// Buddy. A viewer may not.
bool swarmCanWrite(SwarmReader reader) =>
    reader.snapshot?.people
        .where((p) => p.id == reader.accountId)
        .firstOrNull
        ?.canWrite ??
    false;

/// A machine a Buddy may start on, as Start your Buddy lists it.
typedef SwarmBuddyMachine = ({String id, String name});

/// The person's own machines in the Swarm: a Buddy runs only there, like a
/// Lead, whatever its engine (Ken, 10-28). Not a machine someone else shared
/// with them, and not another person's; the backend refuses any other (the
/// desktop's `buddyMachines`).
List<SwarmBuddyMachine> swarmBuddyMachines(SwarmReader reader) => [
  for (final m in reader.snapshot?.machines ?? const <Map<String, dynamic>>[])
    if (m['hostMachineId'] == null &&
        m['contributorId'] == reader.accountId &&
        m['machineId'] is String)
      (id: m['machineId'] as String, name: _machineName(m['name'])),
];

/// The machine [machineId] by its name in the Swarm, as a Buddy's chat
/// says what it runs on; "another machine" while the Swarm names none (the
/// desktop's `buddyMachineName`).
String swarmBuddyMachineName(SwarmReader reader, String machineId) =>
    _machineName(
      reader.snapshot?.pool(machineId)?['name'],
      fallback: 'another machine',
    );

/// A machine's name without its `.local`, as the desktop shows it.
String _machineName(Object? name, {String fallback = 'Your machine'}) {
  const suffix = '.local';
  if (name is! String || name.isEmpty) return fallback;
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}

/// A person of [reader]'s Swarm by the name it shows them by: their address
/// before the @; "its owner" while the Swarm does not list them (the
/// desktop's `buddyPersonName`).
String swarmBuddyPersonName(SwarmReader reader, String personId) {
  final email = reader.snapshot?.people
      .where((p) => p.id == personId)
      .firstOrNull
      ?.email;
  return email == null || email.isEmpty
      ? 'its owner'
      : superTabPersonName(email);
}

/// Opens the person's Buddy chat in [projectId], on the server first when
/// the read holds none: every person has one in each project before any
/// Buddy (backend buddy.chat), so the PM's private lines never drop. One
/// request per person, membership and project, as the desktop's
/// `openBuddyChat` sends it, so a second tap or another device gets the same
/// chat back. Answers its id — the chat opened on it looks it up as it reads
/// its messages — or null when the server named none; a refusal throws.
Future<String?> openSwarmBuddyChat(SwarmReader reader, String projectId) async {
  if (swarmBuddyChat(reader, projectId) case final chat?) return chat.id;
  final generation = reader.snapshot?.people
      .where((p) => p.id == reader.accountId)
      .firstOrNull
      ?.generation;
  var operation =
      'buddy-chat-$projectId-${reader.accountId}-${generation ?? ''}';
  // The backend's operation ids are at most 160 characters.
  if (operation.length > 160) operation = operation.substring(0, 160);
  final result = await _command(reader, {
    'type': 'buddy.chat',
    'projectId': projectId,
  }, operation: operation);
  return result['conversationId'] as String?;
}

/// Starts the person's Buddy in [projectId] on [machineId] with [engine]
/// (backend buddy.create; a Buddy that is down is replaced), then reads the
/// Swarm again, so its start shows. Answers its chat's id; a refusal throws.
Future<String?> startSwarmBuddy(
  SwarmReader reader, {
  required String projectId,
  required String machineId,
  required String engine,
}) async {
  final result = await _command(reader, {
    'type': 'buddy.create',
    'projectId': projectId,
    'machineId': machineId,
    'engine': engine,
  });
  await reader.refresh();
  return result['conversationId'] as String?;
}

/// Removes the person's Buddy in [projectId]: its session stops and its chat
/// stays. Reads the Swarm again; a refusal throws.
Future<void> removeSwarmBuddy(SwarmReader reader, String projectId) async {
  await _command(reader, {'type': 'buddy.remove', 'projectId': projectId});
  await reader.refresh();
}

/// What the person does to their Buddy in one project from its chat: start
/// it, start it again, remove it. One at a time — a second tap while one is
/// under way does nothing — and what went wrong with the last, as a sentence
/// to show; it lasts until the next.
class SwarmBuddyActions extends ChangeNotifier {
  SwarmBuddyActions(this.reader, this.projectId);

  final SwarmReader reader;
  final String projectId;

  bool _busy = false, _disposed = false;
  String? _error;

  /// One is under way.
  bool get busy => _busy;

  /// What went wrong with the last one; null when it went through.
  String? get error => _error;

  /// Starts the Buddy on [machineId] with [engine] ([startSwarmBuddy]).
  Future<void> start({required String machineId, required String engine}) =>
      _run(
        () => startSwarmBuddy(
          reader,
          projectId: projectId,
          machineId: machineId,
          engine: engine,
        ),
        "Couldn't start your Buddy. Try again.",
      );

  /// Removes the Buddy ([removeSwarmBuddy]); its chat stays.
  Future<void> remove() => _run(
    () => removeSwarmBuddy(reader, projectId),
    "Couldn't remove your Buddy. Try again.",
  );

  Future<void> _run(Future<Object?> Function() act, String fallback) async {
    if (_busy || _disposed) return;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      await act();
    } on SuperTabFailure catch (failure) {
      _error = failure.message;
    } catch (_) {
      _error = fallback;
    }
    _busy = false;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Sends [command] to [reader]'s Swarm and answers its result.
Future<Map<String, dynamic>> _command(
  SwarmReader reader,
  Map<String, dynamic> command, {
  String? operation,
}) async {
  final answer = superTabMap(
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {
        'operationId': operation ?? superTabOperationId(),
        'command': command,
      },
    ),
  );
  final result = answer['result'];
  return result is Map ? Map<String, dynamic>.from(result) : const {};
}
