import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../bootstrap/environment_provisioner.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// The read-only gate shown before either sign-in or environment setup.
///
/// Every row reflects a dependency the provisioner actually probes. Progress
/// counts checks that have answered, including those that need attention.
///
/// This is deliberately not part of the environment setup wizard: a computer
/// that is already ready should never look as though it has entered an
/// installer. The ready state has no artificial dwell or action; it stays
/// visible only while the app asks the local Harness CLI whether this user is
/// signed in.
class EnvironmentPreflightScreen extends StatelessWidget {
  const EnvironmentPreflightScreen({super.key, required this.readiness});

  final EnvironmentReadiness readiness;

  /// Readable names for the dependencies the app actually checks.
  static const _labels = {
    EnvironmentStep.tmux: 'Terminal tools',
    EnvironmentStep.harness: 'Harness CLI',
    EnvironmentStep.clipboard: 'Clipboard helper',
  };

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ready = readiness.isReady;
    final steps = readiness.steps.entries
        .where((entry) => _labels.containsKey(entry.key))
        .toList();
    final settled = steps.where((entry) => _settled(entry.value)).length;
    final value = steps.isEmpty ? (ready ? 1.0 : null) : settled / steps.length;
    final progress = steps.isEmpty
        ? 'Waiting for checks…'
        : '$settled of ${steps.length} checks finished';
    final status = ready
        ? 'All checks passed. Opening your workspace…'
        : "This check doesn't install anything.";
    final iconSize = MediaQuery.textScalerOf(context).scale(18);
    final progressTrack = MediaQuery.highContrastOf(context)
        ? DesktopChrome.muted
        : DesktopChrome.rim;

    return DesktopChrome(
      child: Scaffold(
        backgroundColor: grid.AppPalette.windowBg,
        body: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(DesktopChrome.panelPadding),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 470),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Semantics(
                    header: true,
                    child: Text(
                      ready
                          ? 'Your computer is ready'
                          : 'Checking this computer',
                      style: grid.AppType.title(
                        color: DesktopChrome.foreground,
                        height: 1.3,
                      ),
                    ),
                  ),
                  const SizedBox(height: DesktopChrome.panelPadding),
                  for (final entry in steps)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: MergeSemantics(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            ExcludeSemantics(
                              child: Icon(
                                _icon(entry.value),
                                size: iconSize,
                                color: _ink(entry.value),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                _labels[entry.key]!,
                                style: DesktopChrome.control(),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Flexible(
                              fit: FlexFit.tight,
                              child: Text(
                                _status(entry.value),
                                textAlign: TextAlign.end,
                                style: DesktopChrome.metadata(),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  const SizedBox(height: DesktopChrome.panelPadding),
                  Semantics(
                    key: const Key('environment-status'),
                    container: true,
                    liveRegion: true,
                    label: 'Harness setup status',
                    value: ready
                        ? 'Environment ready'
                        : 'Checking this computer. $progress',
                    child: ExcludeSemantics(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (value != null)
                            LinearProgressIndicator(
                              value: ready ? 1 : value,
                              minHeight: 4,
                              borderRadius: BorderRadius.circular(2),
                              color: ready
                                  ? grid.AppPalette.online
                                  : DesktopChrome.accent,
                              backgroundColor: progressTrack,
                              stopIndicatorRadius: 0,
                            )
                          else if (MediaQuery.disableAnimationsOf(context))
                            Icon(
                              AppIcons.hourglass,
                              size: 20,
                              color: DesktopChrome.muted,
                            )
                          else
                            LinearProgressIndicator(
                              minHeight: 4,
                              borderRadius: BorderRadius.circular(2),
                              color: DesktopChrome.accent,
                              backgroundColor: progressTrack,
                            ),
                          const SizedBox(height: DesktopChrome.controlGap),
                          Text(progress, style: DesktopChrome.metadata()),
                          const SizedBox(height: DesktopChrome.groupGap),
                          Text(
                            status,
                            style: DesktopChrome.text(
                              color: ready
                                  ? DesktopChrome.foreground
                                  : DesktopChrome.muted,
                              size: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// A step that has answered, whichever answer it gave.
  static bool _settled(EnvironmentStepStatus status) => switch (status) {
    EnvironmentStepStatus.pending || EnvironmentStepStatus.running => false,
    _ => true,
  };

  static String _status(EnvironmentStepStatus status) => switch (status) {
    EnvironmentStepStatus.ready => 'Ready',
    EnvironmentStepStatus.notApplicable => 'Not needed',
    EnvironmentStepStatus.failed => 'Check failed',
    EnvironmentStepStatus.unavailable => 'Unavailable',
    EnvironmentStepStatus.needsTerminal => 'Needs Terminal',
    EnvironmentStepStatus.running => 'Checking…',
    EnvironmentStepStatus.pending => 'Waiting',
  };

  static IconData _icon(EnvironmentStepStatus status) => switch (status) {
    EnvironmentStepStatus.ready => AppIcons.circleCheck,
    EnvironmentStepStatus.notApplicable => AppIcons.circleMinus,
    EnvironmentStepStatus.failed ||
    EnvironmentStepStatus.unavailable => AppIcons.circleAlert,
    EnvironmentStepStatus.needsTerminal => AppIcons.externalLink,
    EnvironmentStepStatus.running => AppIcons.ellipsis,
    EnvironmentStepStatus.pending => AppIcons.clock,
  };

  static Color _ink(EnvironmentStepStatus status) => switch (status) {
    EnvironmentStepStatus.ready => grid.AppPalette.online,
    EnvironmentStepStatus.failed ||
    EnvironmentStepStatus.unavailable => grid.AppPalette.dangerFill,
    EnvironmentStepStatus.needsTerminal => grid.AppPalette.warn,
    _ => DesktopChrome.muted,
  };
}
