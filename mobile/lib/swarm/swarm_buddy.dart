import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';

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

/// A machine's name without its `.local`, as the desktop shows it.
String _machineName(Object? name) {
  const suffix = '.local';
  if (name is! String || name.isEmpty) return 'Your machine';
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}
