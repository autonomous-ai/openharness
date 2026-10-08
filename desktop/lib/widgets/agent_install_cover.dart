import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/app_type.dart';
import '../state/swarm_navigation.dart' show externalEngineName;
import 'engine_identity.dart';

/// What a pane shows while it installs the agent it was opened on.
///
/// The install runs in the pane's terminal as before (some installers need it), but its output is
/// covered: a new person picking Cursor or Copilot used to see "harness: installing the engine — this
/// pane becomes the agent when it finishes", the install command and the installer's raw lines. That
/// read as an error (owner, 2026-10-08: "we don't want to show scary text on the terminal"). Show
/// details uncovers the terminal for anyone who wants it. The bar moves on time, not on bytes: the
/// installers report no progress, and measured installs took 7–20 s (macOS VM, 2026-10-08).
class AgentInstallCover extends StatefulWidget {
  AgentInstallCover({
    super.key,
    required this.engine,
    this.failed = false,
    this.messageWaiting = false,
    this.onTryAgain,
    Duration? expected,
  }) : expected = expected ?? typicalInstall(engine);

  final String engine;

  /// The install or the agent's first start failed; the pane keeps its output under the cover.
  final bool failed;

  /// A first message is waiting and goes to the agent as soon as it starts.
  final bool messageWaiting;
  final VoidCallback? onTryAgain;

  /// How long an install usually takes; the bar fills towards it and slows near the end.
  final Duration expected;

  /// Measured on a fresh Mac (VM, 2026-10-08): OpenCode 7–12 s, Claude Code 8–13 s, Pi 11 s,
  /// Codex 11–22 s. Others are guessed from their installers.
  static Duration typicalInstall(String engine) => Duration(
    seconds: switch (engine) {
      'opencode' => 10,
      'claude' => 12,
      'pi' => 12,
      'codex' => 20,
      _ => 15,
    },
  );

  @override
  State<AgentInstallCover> createState() => _AgentInstallCoverState();
}

class _AgentInstallCoverState extends State<AgentInstallCover>
    with SingleTickerProviderStateMixin {
  // A ticker rather than a timer and the wall clock: it follows the frame clock, so the bar stops
  // with the window and moves under test.
  late final Ticker _ticker;
  Duration _elapsed = Duration.zero;
  bool _details = false;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((elapsed) {
      if (elapsed - _elapsed >= const Duration(milliseconds: 250) ||
          elapsed == Duration.zero) {
        setState(() => _elapsed = elapsed);
      }
    });
    if (!widget.failed) _ticker.start();
  }

  @override
  void didUpdateWidget(AgentInstallCover old) {
    super.didUpdateWidget(old);
    if (widget.failed && _ticker.isActive) _ticker.stop();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  /// Fills to about 70% at [AgentInstallCover.expected] and creeps on after it, never reaching the
  /// end until the agent actually starts and the cover goes away.
  double get _fraction {
    final t = _elapsed.inMilliseconds / widget.expected.inMilliseconds;
    return (1 - 1 / (1 + 2.4 * t)).clamp(0.04, 0.97);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // "Claude Code", as the pane's header says it, not the engine's short label "Claude".
    final name = externalEngineName(widget.engine);
    if (_details) {
      // Uncovered: the terminal shows through, with a thin bar to cover it again.
      return Align(
        alignment: Alignment.topCenter,
        child: Material(
          color: grid.AppPalette.panelBg,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.failed
                        ? '$name could not be installed'
                        : 'Getting $name ready…',
                    style: AppType.label(color: grid.AppPalette.textSecondary),
                  ),
                ),
                TextButton(
                  key: const ValueKey('agent-install-hide-details'),
                  onPressed: () => setState(() => _details = false),
                  child: const Text('Hide details'),
                ),
              ],
            ),
          ),
        ),
      );
    }
    final left = widget.expected - _elapsed;
    final when = left.inSeconds > 3
        ? 'about ${left.inSeconds} s'
        : 'almost there';
    return Container(
      key: const ValueKey('agent-install-cover'),
      color: grid.AppPalette.panelBg,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            EngineMark(engine: widget.engine, size: 36),
            const SizedBox(height: 16),
            Text(
              widget.failed
                  ? '$name could not be installed'
                  : 'Getting $name ready…',
              textAlign: TextAlign.center,
              style: AppType.title(color: grid.AppPalette.textPrimary),
            ),
            const SizedBox(height: 14),
            if (!widget.failed) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: LinearProgressIndicator(
                  key: const ValueKey('agent-install-progress'),
                  value: _fraction,
                  minHeight: 5,
                  backgroundColor: grid.AppSurface.recess,
                  color: grid.AppPalette.accentOnSurface,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                widget.messageWaiting
                    ? '$when · your message is waiting and goes as soon as it starts'
                    : when,
                textAlign: TextAlign.center,
                style: AppType.body(color: grid.AppPalette.textSecondary),
              ),
            ] else
              Text(
                'Check the connection and try again, or pick another agent from the pane\'s header.',
                textAlign: TextAlign.center,
                style: AppType.body(color: grid.AppPalette.textSecondary),
              ),
            const SizedBox(height: 18),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.failed && widget.onTryAgain != null) ...[
                  FilledButton(
                    key: const ValueKey('agent-install-try-again'),
                    onPressed: widget.onTryAgain,
                    child: const Text('Try again'),
                  ),
                  const SizedBox(width: 10),
                ],
                TextButton(
                  key: const ValueKey('agent-install-show-details'),
                  onPressed: () => setState(() => _details = true),
                  child: const Text('Show details'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
