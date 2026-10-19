import 'package:flutter/foundation.dart';

/// A tab's leader: the harness the other harnesses in it look to (Tab
/// Activity). Named by machine and agent, as every harness is.
@immutable
class AgentMessageLeader {
  const AgentMessageLeader(this.machineId, this.agentId);

  final String machineId, agentId;

  Map<String, String> toJson() => {'machineId': machineId, 'agentId': agentId};

  static AgentMessageLeader? fromJson(Object? json) {
    if (json is! Map) return null;
    final machineId = json['machineId'], agentId = json['agentId'];
    if (machineId is! String || machineId.isEmpty) return null;
    if (agentId is! String || agentId.isEmpty) return null;
    return AgentMessageLeader(machineId, agentId);
  }

  @override
  bool operator ==(Object other) =>
      other is AgentMessageLeader &&
      other.machineId == machineId &&
      other.agentId == agentId;

  @override
  int get hashCode => Object.hash(machineId, agentId);

  @override
  String toString() => 'AgentMessageLeader($machineId/$agentId)';
}

/// What the backend keeps for one desk tab (`GET /api/agent-messages`).
@immutable
class AgentMessageTabSetting {
  const AgentMessageTabSetting({this.enabled = false, this.leader});

  final bool enabled;

  /// Null when none was chosen, or the leader's pane left the tab (the backend
  /// derives that; nothing clears it).
  final AgentMessageLeader? leader;

  AgentMessageTabSetting withLeader(AgentMessageLeader? next) =>
      AgentMessageTabSetting(enabled: enabled, leader: next);

  @override
  bool operator ==(Object other) =>
      other is AgentMessageTabSetting &&
      other.enabled == enabled &&
      other.leader == leader;

  @override
  int get hashCode => Object.hash(enabled, leader);
}

/// The listing's tabs by id. A malformed tab is dropped, a malformed leader
/// is none; never throws.
Map<String, AgentMessageTabSetting> parseTabSettings(
  Map<String, dynamic>? answer,
) {
  final tabs = answer?['tabs'];
  if (tabs is! List) return const {};
  final out = <String, AgentMessageTabSetting>{};
  for (final tab in tabs) {
    if (tab is! Map) continue;
    final id = tab['id'];
    if (id is! String || id.isEmpty) continue;
    out[id] = AgentMessageTabSetting(
      enabled: tab['enabled'] == true,
      leader: AgentMessageLeader.fromJson(tab['leader']),
    );
  }
  return out;
}
