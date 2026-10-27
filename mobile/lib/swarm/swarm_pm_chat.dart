import 'package:flutter/widgets.dart';

import 'model.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';

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

/// Opens the person's Chat with PM of [projectId] over [context]'s page,
/// creating it on first use ([openSwarmPmChat]). Answers what went wrong as a
/// sentence to show, or null once it is open.
Future<String?> openSwarmPm(
  BuildContext context,
  SwarmReader reader,
  String swarmId,
  String projectId,
) async {
  final String? id;
  try {
    id = await openSwarmPmChat(reader, projectId);
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    return 'Could not open Chat with PM. Try again.';
  }
  if (id == null) return 'Chat with PM is not ready yet. Try again.';
  if (context.mounted) openSwarmConversation(context, swarmId, id);
  return null;
}
