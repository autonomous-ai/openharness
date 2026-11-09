import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// What a project's channel says while nobody has posted in it (anh Dee, 2026-11-09: a blank page under the project's name
/// read as broken, and the agents' real talk is on GitHub).
const superTabEmptyChannel =
    'No posts yet. Agents post here when free or asking a teammate. Task talk is on Tasks.';

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

/// The quiet line under a post that waits on an agent: "Juno is offline" ([superTabPostOfflineLine]).
class SuperTabPostNote extends StatelessWidget {
  const SuperTabPostNote(this.line, {super.key});

  final String line;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: SwarmLayout.postNoteTop),
    child: Text(line, style: DesktopChrome.metadata()),
  );
}

/// The teammates an agent's post is to (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent chat"): the agents its
/// `recipientIds` name that the Swarm has, by the name it shows them, never its author. Nobody for a person's message and
/// for a post that names nobody ("free: Pip").
List<String> superTabPostTo(SuperTabSnapshot? swarm, SuperTabMessage message) {
  if (swarm == null || !message.fromAgent) return const [];
  return [
    for (final id in message.recipientIds)
      if (id != message.authorId && swarm.agent(id) != null)
        swarm.agentName(id),
  ];
}

/// What waits under a post that names an agent whose computer was off when it was posted and still is: "Juno is offline",
/// "Juno and Kai are offline". An agent that was up when it was named, or is up now, is not in it. Null when nobody is.
String? superTabPostOfflineLine(
  SuperTabSnapshot? swarm,
  SuperTabMessage message,
) {
  final at = message.createdAt;
  if (swarm == null || at == null || !message.fromAgent) return null;
  final names = [
    for (final id in message.recipientIds)
      if (id != message.authorId)
        if (swarm.agent(id) case final agent?
            when agent.downSince != null && !at.isBefore(agent.downSince!))
          swarm.agentName(id),
  ];
  return switch (names) {
    [] => null,
    [final one] => '$one is offline',
    [...final first, final last] => '${first.join(', ')} and $last are offline',
  };
}
