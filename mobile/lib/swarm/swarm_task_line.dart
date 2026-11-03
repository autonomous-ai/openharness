import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_message_row.dart' show swarmChatText;

/// The server edits this message in place as its task moves.
bool swarmIsTaskLine(SuperTabMessage message) =>
    message.source['kind'] == 'task-line';

/// A task's line replaces its older Shipped card in the loaded chat window.
/// A ship for another task, or without a replacement here, remains visible.
List<SuperTabMessage> swarmTaskLineMessages(List<SuperTabMessage> messages) {
  final lined = <String>{
    for (final message in messages)
      if (swarmIsTaskLine(message) && message.source['taskId'] is String)
        message.source['taskId'] as String,
  };
  if (lined.isEmpty) return messages;
  return [
    for (final message in messages)
      if (!(message.source['kind'] == 'ship' &&
          lined.contains(message.source['conversationId'])))
        message,
  ];
}

/// Desktop's task words; a future state makes no claim this build cannot keep.
String _word(SuperTabMessage message, String readerId) =>
    switch (message.source['state']) {
      'planned' => 'planned',
      'working' => 'working',
      'waiting' =>
        message.source['answerFor'] == readerId ? 'Answer' : 'working',
      'review' => 'in review',
      'ready' => 'ready',
      'shipped' => 'shipped',
      'done' => 'done',
      'stopped' => 'stopped',
      _ => '',
    };

IconData _mark(SuperTabMessage message) => switch (message.source['state']) {
  'planned' => LucideIcons.circleDashed,
  'shipped' || 'done' => LucideIcons.check,
  'stopped' => LucideIcons.circleSlash,
  _ => LucideIcons.circleDot,
};

/// One quiet, thumb-sized row: mark, task name and word. Opening the task is
/// available only while the caller's current read holds that conversation.
class SwarmTaskLine extends StatelessWidget {
  const SwarmTaskLine({
    super.key,
    required this.message,
    required this.readerId,
    this.onOpen,
  });

  final SuperTabMessage message;
  final String readerId;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final title = switch (message.source['title']) {
      final String title when title.isNotEmpty => title,
      _ => message.text,
    };
    final word = _word(message, readerId);
    final answer = word == 'Answer';
    return Semantics(
      label: word.isEmpty ? title : '$title, $word',
      button: onOpen != null,
      onTap: onOpen,
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onOpen,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.l,
                vertical: AppSpace.s,
              ),
              child: Row(
                children: [
                  Icon(
                    _mark(message),
                    size: 16,
                    color: AppPalette.textSecondary,
                  ),
                  const SizedBox(width: AppSpace.s),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: swarmChatText(
                        16,
                        weight: answer ? FontWeight.w600 : FontWeight.w400,
                      ),
                    ),
                  ),
                  if (word.isNotEmpty) ...[
                    const SizedBox(width: AppSpace.s),
                    Text(
                      word,
                      maxLines: 1,
                      style: swarmChatText(
                        14,
                        color: answer
                            ? AppPalette.textPrimary
                            : AppPalette.textSecondary,
                        weight: answer ? FontWeight.w600 : FontWeight.w400,
                      ),
                    ),
                  ],
                  if (onOpen != null) ...[
                    const SizedBox(width: AppSpace.s),
                    Icon(
                      LucideIcons.chevronRight300,
                      size: 18,
                      color: AppPalette.textFaint,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
