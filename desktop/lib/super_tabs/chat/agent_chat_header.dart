import 'package:flutter/material.dart';

import '../../core/runtime_model_name.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/engine_identity.dart';
import '../buddies.dart';
import '../buddy_model.dart';
import '../controller.dart';
import '../identity.dart';
import '../model.dart';

/// An agent's chat in the middle, under one row (anh Dee, #4204): its avatar and name on the left; its engine, its
/// model and the chat's menu on the right; no other text. The reader's own Buddy switches engine and model there.
/// The server switches no other agent, so theirs are named in the same place.
class SuperTabAgentChatHeader extends StatelessWidget {
  const SuperTabAgentChatHeader({
    super.key,
    required this.controller,
    required this.group,
    this.menu,
    this.app,
    this.title,
  });

  final SuperTabController controller;
  final SuperTabConversation group;

  /// The chat's ⋮ menu.
  final Widget? menu;

  /// For the model picker's line that asks to add the Buddy's machine to the Swarm.
  final AppNotifier? app;

  /// In place of the avatar and the name, given the name: the reader's own Buddy chat's Buddy card button (view.dart).
  final Widget Function(String name)? title;

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
        ? 'Your agent'
        : group.label;
    final model = switch (agent?.configuration['model']) {
      final String id when id.isNotEmpty && id != 'default' => modelDisplayName(
        id,
      ),
      _ => null,
    };
    Widget label(String text) => Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: DesktopChrome.metadata(color: DesktopChrome.foreground),
    );
    final left =
        title?.call(name) ??
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (agent != null) ...[
              SuperTabAvatar.agent(
                agent,
                size: SuperTabAvatar.rowSize,
                engineBadge: false,
              ),
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
    final right = buddy != null && group.isSwarmBuddyChat
        ? BuddyModelLine(
            controller: c,
            agent: buddy,
            machine: buddyMachineName(c, buddy.machineId, app: app),
          )
        : agent != null
        ? Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              label(engineIdentity(agent.engine).label),
              if (model != null) ...[
                const SizedBox(width: grid.AppDesktop.controlGap),
                Flexible(child: label(model)),
              ],
            ],
          )
        : null;
    return SizedBox(
      key: const ValueKey('super-agent-chat-header'),
      height: 44,
      // The name comes first, up to half the row; the engine and model take the rest, the model giving way with
      // "…", so a long model id never pushes the name or ⋮ out (#4444).
      child: LayoutBuilder(
        builder: (context, box) => Row(
          children: [
            const SizedBox(width: grid.AppDesktop.controlGap),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth / 2),
              child: left,
            ),
            const SizedBox(width: grid.AppDesktop.controlGap),
            Expanded(
              child: Align(alignment: Alignment.centerRight, child: right),
            ),
            const SizedBox(width: grid.AppDesktop.menuInset),
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
