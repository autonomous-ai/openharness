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
    this.preparingText = 'Preparing your harness…',
    this.recovery,
    this.onRetry,
    this.onStartNew,
    this.checkingStatus = false,
  });

  final bool loading;
  final VoidCallback onChoose;
  final bool preparing;

  /// What [preparing] says: the first workspace on a new computer opens agents instead.
  final String preparingText;
  final String? recovery;
  final VoidCallback? onRetry, onStartNew;
  final bool checkingStatus;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          header: true,
          child: Text(
            recovery != null ? 'Open your first harness' : 'Harness anything',
            textAlign: TextAlign.center,
            style: grid.AppType.display(color: DesktopChrome.foreground),
          ),
        ),
        const SizedBox(height: 8),
        Semantics(
          liveRegion: true,
          child: Text(
            recovery ??
                (preparing
                    ? preparingText
                    : loading
                    ? 'Finding your machines…'
                    : 'Choose a machine to start a new harness.'),
            textAlign: TextAlign.center,
            style: DesktopChrome.text(color: DesktopChrome.muted),
          ),
        ),
        if (recovery != null) ...[
          const SizedBox(height: 24),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            alignment: WrapAlignment.center,
            children: [
              if (onRetry != null)
                FilledButton(
                  onPressed: onRetry,
                  child: Text(checkingStatus ? 'Check status' : 'Try again'),
                ),
              if (onStartNew != null)
                OutlinedButton(
                  onPressed: onStartNew,
                  child: const Text('Start a new harness'),
                ),
              TextButton(
                onPressed: onChoose,
                child: const Text('Open harnesses'),
              ),
            ],
          ),
        ] else if (!preparing) ...[
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
