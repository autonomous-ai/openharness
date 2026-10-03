import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// The empty workspace's next step before its creation form is ready.
/// Inventory and choosing a machine remain owned by the workspace.
class WorkspaceMachinePrompt extends StatelessWidget {
  const WorkspaceMachinePrompt({
    super.key,
    required this.loading,
    required this.onChoose,
    this.preparing = false,
  });

  final bool loading;
  final VoidCallback onChoose;
  final bool preparing;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          header: true,
          child: Text(
            'Harness anything',
            textAlign: TextAlign.center,
            style: grid.AppType.display(color: DesktopChrome.foreground),
          ),
        ),
        const SizedBox(height: 8),
        Semantics(
          liveRegion: true,
          child: Text(
            preparing
                ? 'Preparing your harness…'
                : loading
                ? 'Finding your machines…'
                : 'Choose a machine to start a new harness.',
            textAlign: TextAlign.center,
            style: DesktopChrome.text(color: DesktopChrome.muted),
          ),
        ),
        if (!preparing) ...[
          const SizedBox(height: 24),
          FilledButton(
            onPressed: onChoose,
            child: const Text('Choose a machine'),
          ),
        ],
      ],
    );
  }
}
