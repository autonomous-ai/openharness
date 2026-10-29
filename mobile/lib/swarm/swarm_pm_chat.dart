import 'model.dart';

/// The name of [project]'s Product Manager: the agent leading its project
/// chat; null while it has none.
String? swarmPmName(SuperTabSnapshot snapshot, SuperTabProject project) {
  final leadId = swarmPmId(snapshot, project);
  return leadId == null ? null : snapshot.agentName(leadId);
}

/// The id of [project]'s Product Manager, for its avatar; null while it has
/// none.
String? swarmPmId(SuperTabSnapshot snapshot, SuperTabProject project) =>
    snapshot.conversation(project.leadConversationId)?.leadId;
