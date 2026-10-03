import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../state/workspace_learning.dart';
import 'desktop_chrome.dart';

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
    grid.AppTheme.watch(context);
    final next = learning.next;
    final (command, label) = switch (next) {
      WorkspaceLesson.agent => ('swarm.new', 'Open your first harness'),
      WorkspaceLesson.pane => (
        'agent.open',
        'Add a second harness to this tab',
      ),
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
    final hint = KeymapTheme.of(context)?.hint(command);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Wrap(
          spacing: 16,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              next == null
                  ? 'Quick start · Complete'
                  : 'Quick start · ${next.index + 1} of 4',
              style: DesktopChrome.metadata(),
            ),
            Semantics(
              liveRegion: true,
              child: Text(label, style: DesktopChrome.control()),
            ),
            DesktopPill(
              key: const ValueKey('quick-start-action'),
              onPressed: next == null ? onPractice : () => onCommand(command),
              compact: true,
              label: next == null
                  ? 'Keyboard practice'
                  : '${hint == null ? '' : '$hint  '}${next == WorkspaceLesson.commands ? 'Search commands' : 'Try it'}',
            ),
            DesktopPill(
              key: const ValueKey('quick-start-pause'),
              onPressed: learning.pause,
              compact: true,
              quiet: true,
              label: next == null ? 'Done' : 'Pause guide',
            ),
          ],
        ),
      ),
    );
  }
}
