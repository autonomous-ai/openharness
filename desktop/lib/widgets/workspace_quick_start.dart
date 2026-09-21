import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/workspace_learning.dart';
import 'box_chrome.dart';

/// A temporary guide beside real work. It never requests terminal focus.
class WorkspaceQuickStart extends StatelessWidget {
  const WorkspaceQuickStart({
    super.key,
    required this.learning,
    required this.onCommand,
    required this.onPractice,
  });
  final WorkspaceLearning learning;
  final ValueChanged<String> onCommand;
  final VoidCallback onPractice;

  @override
  Widget build(BuildContext context) {
    final next = learning.next;
    final (command, label) = switch (next) {
      WorkspaceLesson.agent => ('swarm.new', 'Open your first agent'),
      WorkspaceLesson.pane => ('agent.add', 'Add a second agent to this tab'),
      WorkspaceLesson.zoom => ('pane.zoom', 'Zoom the focused pane'),
      WorkspaceLesson.commands => (
        'navigation.commands',
        'Find an action by name',
      ),
      null => (
        'keyboard.practice',
        'Workspace ready. Keep learning at your own pace.',
      ),
    };
    final keys = KeymapTheme.of(context)?.hint(command);
    final hint = keys == null ? null : boxKeyLabel(keys);
    return TerminalBox(
      docked: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
        child: Wrap(
          spacing: 14,
          runSpacing: 2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              next == null
                  ? 'quick start  [done]'
                  : 'quick start  ${next.index + 1}/4',
              style: boxMonoStyle(size: 12, color: kBoxFaint),
            ),
            Semantics(
              liveRegion: true,
              child: Text(label, style: boxMonoStyle(size: 12)),
            ),
            TextButton(
              key: const ValueKey('quick-start-action'),
              onPressed: next == null ? onPractice : () => onCommand(command),
              child: Text(
                next == null
                    ? 'Keyboard practice'
                    : '${hint == null ? '' : '$hint  '}${next == WorkspaceLesson.commands ? 'Search commands' : 'Try it'}',
                style: boxMonoStyle(size: 12),
              ),
            ),
            TextButton(
              key: const ValueKey('quick-start-pause'),
              onPressed: learning.pause,
              child: Text(
                next == null ? 'Done' : 'Pause guide',
                style: boxMonoStyle(size: 12, color: kBoxFaint),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
