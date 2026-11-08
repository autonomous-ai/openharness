import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';
import 'swarm_type.dart';

/// A project's tasks (Swarm v4, anh Dee 2026-11-08): every thread in its channel, newest activity first, as quiet cards
/// beside the channel. A task is a thread: its first line is the task, its replies are the agents' talk, and tapping a
/// card opens that thread.
class SwarmTaskList extends StatelessWidget {
  const SwarmTaskList({
    super.key,
    required this.controller,
    required this.conversationId,
    required this.onOpen,
    required this.onClose,
  });

  final SuperTabController controller;
  final String conversationId;
  final ValueChanged<String> onOpen;
  final VoidCallback onClose;

  /// The channel's threads with at least one reply, newest activity first.
  static List<(SuperTabMessage, SuperTabThread)> tasksOf(
    SuperTabController controller,
    String conversationId,
  ) {
    final tasks = [
      for (final message in controller.messages(conversationId))
        if (!message.threadReply)
          if (controller.thread(conversationId, message.id) case final thread?
              when thread.replies > 0)
            (message, thread),
    ];
    DateTime at((SuperTabMessage, SuperTabThread) task) =>
        task.$2.lastAt ?? task.$1.createdAt ?? DateTime(0);
    tasks.sort((a, b) => at(b).compareTo(at(a)));
    return tasks;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final tasks = tasksOf(controller, conversationId);
    return ColoredBox(
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              children: [
                Text('Tasks', style: DesktopChrome.text(medium: true)),
                const Spacer(),
                AppIconButton(
                  key: const ValueKey('swarm-tasks-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: onClose,
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.separated(
              key: const ValueKey('swarm-task-list'),
              padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
              itemCount: tasks.length,
              separatorBuilder: (_, _) =>
                  const SizedBox(height: grid.AppDesktop.controlGap),
              itemBuilder: (context, i) =>
                  _card(context, tasks[i].$1, tasks[i].$2),
            ),
          ),
        ],
      ),
    );
  }

  Widget _card(
    BuildContext context,
    SuperTabMessage root,
    SuperTabThread thread,
  ) {
    final (number, title) = _split(root.text);
    final faces = [
      for (final author in thread.authors.reversed.take(4)) _face(author),
    ];
    return Material(
      color: grid.AppPalette.cardBg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: DesktopChrome.rim),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: ValueKey('swarm-task-${root.id}'),
        onTap: () => onOpen(root.id),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (number != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: grid.AppSurface.recess,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(number, style: DesktopChrome.metadata()),
                  ),
                ),
              Text(
                title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: SwarmType.body(context)
                    .copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  for (final (i, face) in faces.indexed)
                    Padding(
                      padding: EdgeInsets.only(left: i == 0 ? 0 : 4),
                      child: face,
                    ),
                  const Spacer(),
                  Text(
                    thread.replies == 1
                        ? '1 reply'
                        : '${thread.replies} replies',
                    style: DesktopChrome.metadata(),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// "#5861 Forget every copy. More…" reads as #5861 and its first sentence.
  static (String?, String) _split(String text) {
    final first = text.trim().split('\n').first;
    final match = RegExp(r'^(#\d+)\s+').firstMatch(first);
    final rest = match == null ? first : first.substring(match.end);
    final sentence = RegExp(r'^(.+?[.!?])(\s|$)').firstMatch(rest);
    final title = (sentence?.group(1) ?? rest).trim();
    return (
      match?.group(1),
      title.endsWith('.') ? title.substring(0, title.length - 1) : title,
    );
  }

  Widget _face(Map<String, dynamic> author) {
    const size = 22.0;
    final kind = author['kind'] as String? ?? '';
    final id = author['id'] as String? ?? '';
    final agent = kind == 'agent' ? controller.snapshot?.agent(id) : null;
    if (agent != null) {
      return SuperTabAvatar.agent(agent, size: size, engineBadge: false);
    }
    return SuperTabAvatar(
      identity: '$kind:$id',
      name: author['name'] as String? ?? id,
      size: size,
      face: kind == 'agent',
    );
  }
}
