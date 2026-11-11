import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// What a project's channel says while nobody has posted in it (anh Dee, 2026-11-09: a blank page under the project's name
/// read as broken). The channel is where agents talk to each other, as lampOS's agents do on their Queue (anh Dee,
/// 2026-11-10); a task's talk is in its chat.
const superTabEmptyChannel = 'No posts yet. Agents talk to each other here.';

/// The one line in the middle of a chat with nothing in it: muted and centred inside the pane's side padding, as the composer
/// has it, so a long line wraps there.
class SuperTabEmptyWords extends StatelessWidget {
  const SuperTabEmptyWords(this.words, {super.key});

  final String words;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(
      horizontal: grid.AppDesktop.panelPadding,
    ),
    child: Center(
      child: Text(
        words,
        textAlign: TextAlign.center,
        style: DesktopChrome.text(color: DesktopChrome.muted),
      ),
    ),
  );
}

/// The quiet line under a post's bubble, in 12 metadata grey: what its answer waits for ("Juno is offline", [superTabPostOfflineLine]),
/// or what its text lacks ("Response interrupted").
class SuperTabPostNote extends StatelessWidget {
  const SuperTabPostNote(this.line, {super.key});

  final String line;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: SwarmLayout.postNoteTop),
    child: Text(line, style: DesktopChrome.metadata()),
  );
}

/// The agents an agent's post is to that the Swarm has (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent chat"):
/// those its `recipientIds` name, each once, never its author. Nobody for a person's message and for a post that names nobody
/// ("free: Pip").
List<SuperTabAgent> superTabPostRecipients(
  SuperTabSnapshot? swarm,
  SuperTabMessage message,
) {
  if (swarm == null || !message.fromAgent) return const [];
  final seen = {message.authorId};
  return [
    for (final id in message.recipientIds)
      if (seen.add(id)) ?swarm.agent(id),
  ];
}

/// The names of [superTabPostRecipients] as their tags read them: those a post's words do not tag open its bubble (`@Juno`),
/// as a group chat addresses a post (anh Dee, 2026-11-10: "why not use tag? like in a group chat").
List<String> superTabPostTo(SuperTabSnapshot? swarm, SuperTabMessage message) =>
    [for (final agent in superTabPostRecipients(swarm, message)) agent.name];

/// What waits under a post that names an agent that was offline when it was posted and still is (`downSince`: its machine has
/// reported its session gone): "Juno is offline", "Juno and Kai are offline". An agent that was up when it was named has
/// seen the post, and one that is up now has come back to it: neither is in it. Null when nobody is.
String? superTabPostOfflineLine(
  SuperTabSnapshot? swarm,
  SuperTabMessage message,
) {
  final at = message.createdAt;
  if (at == null) return null;
  final names = [
    for (final agent in superTabPostRecipients(swarm, message))
      if (agent.downSince case final since? when !at.isBefore(since))
        agent.displayName ?? agent.name,
  ];
  return switch (names) {
    [] => null,
    [final one] => '$one is offline',
    [...final first, final last] => '${first.join(', ')} and $last are offline',
  };
}

/// What waits under a person's newest message in their own agent's 1:1 chat while that agent is offline, as Your Team says it
/// (`downSince`): "Juno is offline". Null once the agent is back, and for a message sent before it went down, which it has.
String? superTabChatOfflineLine(
  SuperTabSnapshot? swarm,
  SuperTabMessage message,
) {
  final chat = swarm?.conversation(message.conversationId);
  if (chat == null || !chat.isAgentChat || chat.agentIds.isEmpty) return null;
  final agent = swarm!.agent(chat.agentIds.first);
  final since = agent?.downSince, at = message.createdAt;
  if (since == null || at == null || at.isBefore(since)) return null;
  return '${agent!.displayName ?? agent.name} is offline';
}
