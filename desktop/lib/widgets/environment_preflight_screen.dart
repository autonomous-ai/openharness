import 'package:flutter/material.dart';

import '../bootstrap/environment_provisioner.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';
import 'terminal_progress.dart';

/// The read-only gate shown before either sign-in or environment setup.
///
/// Printed as a session, not as a screen: a prompt line, one line per thing
/// checked with its answer in the same column, a bar counting what is done, and
/// a cursor waiting at the end. Everything is the terminal's face at the
/// terminal's size — one cell size, the way a terminal has one (owner,
/// 2026-09-23). A person who has lived in a terminal has read this exact shape
/// ten thousand times, which is the welcome.
///
/// The figure is honest because it is counted: each dependency the provisioner
/// probed is a line, and the bar is how many of them have answered.
///
/// This is deliberately not part of the environment setup wizard: a computer
/// that is already ready should never look as though it has entered an
/// installer. The ready state has no artificial dwell or action; it stays
/// visible only while the app asks the local Harness CLI whether this user is
/// signed in.
class EnvironmentPreflightScreen extends StatelessWidget {
  const EnvironmentPreflightScreen({super.key, required this.readiness});

  final EnvironmentReadiness readiness;

  /// What each dependency is called in the print-out. The enum names the thing
  /// the app runs; these name it the way the person would say it.
  static const _labels = {
    EnvironmentStep.tmux: 'tmux',
    EnvironmentStep.harness: 'harness cli',
    EnvironmentStep.clipboard: 'clipboard helper',
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

    return Scaffold(
      backgroundColor: grid.AppPalette.swarmField,
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 470),
            child: TerminalBox(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                child: Semantics(
                  key: const Key('environment-status'),
                  container: true,
                  liveRegion: true,
                  label: 'Harness setup status',
                  value: ready ? 'Environment ready' : 'Checking this computer',
                  child: ExcludeSemantics(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          '$kBootPrompt harness doctor',
                          style: boxMonoStyle(weight: FontWeight.w600),
                        ),
                        const SizedBox(height: 8),
                        for (final entry in steps) ...[
                          TerminalCheckLine(
                            label: _labels[entry.key]!,
                            status: _status(entry.value),
                            ink: _ink(entry.value),
                          ),
                          const SizedBox(height: 1),
                        ],
                        const SizedBox(height: 9),
                        TerminalProgressLine(
                          value: ready ? 1 : value,
                          color: ready ? grid.AppPalette.online : null,
                        ),
                        const SizedBox(height: 8),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Flexible(
                              child: Text(
                                ready
                                    ? 'all checks passed · opening your workspace'
                                    : 'read-only: nothing is installed by this check',
                                style: boxMonoStyle(
                                  color: ready ? null : kBoxFaint,
                                ),
                              ),
                            ),
                            const SizedBox(width: 6),
                            const TerminalCursor(),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
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

  /// The word in the right-hand column, in a terminal's vocabulary.
  static String _status(EnvironmentStepStatus status) => switch (status) {
    EnvironmentStepStatus.ready => 'ok',
    EnvironmentStepStatus.notApplicable => 'n/a',
    EnvironmentStepStatus.failed => 'fail',
    EnvironmentStepStatus.unavailable => 'missing',
    EnvironmentStepStatus.needsTerminal => 'needs a terminal',
    EnvironmentStepStatus.running => '..',
    EnvironmentStepStatus.pending => '--',
  };

  static Color? _ink(EnvironmentStepStatus status) => switch (status) {
    EnvironmentStepStatus.ready => grid.AppPalette.online,
    EnvironmentStepStatus.failed ||
    EnvironmentStepStatus.unavailable => grid.AppPalette.dangerFill,
    EnvironmentStepStatus.needsTerminal => grid.AppPalette.warn,
    _ => null,
  };
}
