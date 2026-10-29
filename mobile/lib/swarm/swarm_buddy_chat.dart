import 'package:flutter/widgets.dart';

import 'swarm_buddy.dart';
import 'swarm_conversation_page.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_style.dart';

/// Opens the person's Buddy chat in [projectId] over [context]'s page, on the
/// server first when the read holds none ([openSwarmBuddyChat]). Answers what
/// went wrong as a sentence to show, or null once it is open.
Future<String?> openSwarmBuddy(
  BuildContext context,
  SwarmReader reader,
  String swarmId,
  String projectId,
) async {
  final String? id;
  try {
    id = await openSwarmBuddyChat(reader, projectId);
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    return 'Could not open your Buddy chat. Try again.';
  }
  if (id == null) return 'Your Buddy chat is not ready yet. Try again.';
  if (context.mounted) openSwarmConversation(context, swarmId, id);
  return null;
}

/// The person's Buddy in [projectId] as a face: its own, or a plain "B" for
/// Buddy while none runs.
class SwarmBuddyAvatar extends StatelessWidget {
  const SwarmBuddyAvatar({
    super.key,
    required this.reader,
    required this.projectId,
    this.size = 32,
  });

  final SwarmReader reader;
  final String projectId;
  final double size;

  @override
  Widget build(BuildContext context) => switch (swarmBuddy(reader, projectId)) {
    final agent? => SwarmAvatar(
      id: agent.id,
      name: swarmBuddyName(reader, projectId),
      picture: agent.avatar,
      size: size,
    ),
    null => SwarmAvatar(
      id: 'buddy:${reader.tabId}/$projectId',
      name: 'Buddy',
      size: size,
    ),
  };
}
