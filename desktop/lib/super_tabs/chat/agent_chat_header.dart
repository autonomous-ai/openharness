import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/quiet_link.dart';
import '../buddies.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';
import 'engine_model_line.dart';

/// An agent's chat in the middle, under one quiet 44-high bar that looks the same for every agent (anh Dee's six
/// rules, task #4465): its 22 face and its name in semibold on the left; on the right one 12-point line with its
/// engine and model, then the chat's ⋯ menu. The reader's own Swarm Buddy switches engine and model from that line;
/// the server switches no other agent, so theirs is only named there. Nothing else: no subscription, machine or reach.
class SuperTabAgentChatHeader extends StatelessWidget {
  const SuperTabAgentChatHeader({
    super.key,
    required this.controller,
    required this.group,
    this.menu,
    this.app,
    this.title,
    this.onOpenProject,
  });

  /// The face's size in the bar.
  static const faceSize = 22.0;

  final SuperTabController controller;
  final SuperTabConversation group;

  /// The chat's ⋯ menu.
  final Widget? menu;

  /// For the menu's line that asks to add the Buddy's machine to the Swarm.
  final AppNotifier? app;

  /// In place of the face and the name, given the name: the reader's own Buddy chat's Buddy card button (view.dart),
  /// which draws the same face and name with the same inset.
  final Widget Function(String name)? title;

  /// Opens a project's group chat: a Lead's private chat names its project, one quiet link beside its name (task #4664).
  final ValueChanged<SuperTabProject>? onOpenProject;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = controller;
    final snapshot = c.snapshot;
    final buddy = group.isBuddyChat && snapshot != null
        ? superTabChatBuddy(c, group)
        : null;
    final agent = buddy ?? _agentOf(snapshot, group);
    final name = agent != null
        ? snapshot!.agentName(agent.id, fallback: agent.name)
        : group.isBuddyChat
        ? 'Your Buddy'
        : group.label;
    // A Lead's private chat: its project's chat is one quiet link away (task #4664).
    final project = agent != null && group.isAgentChat && onOpenProject != null
        ? snapshot!.leadProjectForAgent(agent.id)
        : null;
    final identity = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (agent != null) ...[
          SuperTabAvatar.agent(agent, size: faceSize, engineBadge: false),
          const SizedBox(width: grid.AppDesktop.menuInset),
        ],
        Flexible(
          child: Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.control().copyWith(
              fontWeight: grid.AppFont.semibold,
            ),
          ),
        ),
      ],
    );
    final head =
        title?.call(name) ??
        Padding(
          // The Buddy card button's inset, so every face sits in one place.
          padding: const EdgeInsets.all(grid.AppDesktop.menuInset),
          child: identity,
        );
    return SizedBox(
      key: const ValueKey('super-agent-chat-header'),
      height: 44,
      // The name comes first, up to half the row; the engine and model take the rest, giving way with "…", so a long
      // model id never pushes the name or ⋯ out (#4444).
      child: LayoutBuilder(
        builder: (context, box) => Row(
          children: [
            const SizedBox(width: grid.AppDesktop.controlGap),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth / 2),
              child: project == null
                  ? head
                  // The link shares the name's half, giving way with "…" first.
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(flex: 2, child: head),
                        const SizedBox(width: grid.AppDesktop.controlGap),
                        Flexible(
                          child: QuietLink(
                            key: const ValueKey('super-agent-chat-project'),
                            label: '${project.name} chat',
                            onPressed: () => onOpenProject!(project),
                          ),
                        ),
                      ],
                    ),
            ),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Expanded(
              child: Align(
                alignment: Alignment.centerRight,
                child: agent == null
                    ? null
                    : SuperTabEngineModelLine(
                        controller: c,
                        agent: agent,
                        machine: buddyMachineName(c, agent.machineId, app: app),
                        switchable: buddy != null && group.isSwarmBuddyChat,
                      ),
              ),
            ),
            ?menu,
            const SizedBox(width: grid.AppDesktop.menuInset),
          ],
        ),
      ),
    );
  }
}

/// The agent a chat is with: the one whose own chat it is (#4116), else the agent on its task.
SuperTabAgent? _agentOf(
  SuperTabSnapshot? snapshot,
  SuperTabConversation group,
) {
  if (snapshot == null) return null;
  return snapshot.agents.where((a) => a.chatId == group.id).firstOrNull ??
      switch (group.assignment?['agentId']) {
        final String id => snapshot.agent(id),
        _ => null,
      };
}
