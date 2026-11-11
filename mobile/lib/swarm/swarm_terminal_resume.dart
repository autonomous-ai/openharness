import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_style.dart';

/// Asks before [agent]'s stopped session is started again on its machine,
/// then resumes it ([PhoneShellScope.onResumeAgent]) and, once its terminal
/// is back, opens it ([PhoneShellScope.onOpenAgent]): the desktop's Resume
/// on a Swarm agent's stopped pane (`workspace.dart`), for the person's own
/// machines alone. The desktop resumes at once; the phone asks first, as it
/// does before archiving, saying which machine it runs on ([machineName]).
///
/// The question goes, as Cancel, once [allowed] no longer holds, checked
/// whenever [until] changes (access lost, signed out, a viewer now). A resume
/// the machine refuses says why under the question, and Resume tries again.
Future<void> confirmSwarmResume(
  BuildContext context, {
  required SuperTabAgent agent,
  required String? machineName,
  required PhoneShellScope shell,
  required bool Function() allowed,
  Listenable? until,
}) async {
  final resume = shell.onResumeAgent;
  if (resume == null || !context.mounted || !allowed()) return;
  final resumed = await showDialog<bool>(
    context: context,
    builder: (_) => SwarmResumeDialog(
      name: agent.displayName ?? agent.name,
      machineName: machineName,
      resume: () => resume(agent.machineId, agent.harnessId),
      allowed: allowed,
      until: until,
    ),
  );
  if (resumed != true || !context.mounted || !allowed()) return;
  shell.onOpenAgent(agent.machineId, agent.harnessId);
}

/// [confirmSwarmResume]'s question: "Resume River?", where it runs, then
/// Cancel and Resume. Pops true once [resume] has brought the terminal back.
class SwarmResumeDialog extends StatefulWidget {
  const SwarmResumeDialog({
    super.key,
    required this.name,
    required this.machineName,
    required this.resume,
    required this.allowed,
    this.until,
  });

  final String name;
  final String? machineName;

  /// Null once the terminal can be opened, or what to say.
  final Future<String?> Function() resume;
  final bool Function() allowed;
  final Listenable? until;

  @override
  State<SwarmResumeDialog> createState() => _SwarmResumeDialogState();
}

class _SwarmResumeDialogState extends State<SwarmResumeDialog> {
  bool _busy = false;
  bool _closing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.until?.addListener(_check);
  }

  @override
  void didUpdateWidget(SwarmResumeDialog oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.until != widget.until) {
      oldWidget.until?.removeListener(_check);
      widget.until?.addListener(_check);
    }
  }

  @override
  void dispose() {
    widget.until?.removeListener(_check);
    super.dispose();
  }

  void _check() {
    if (widget.allowed()) return;
    _close(false);
  }

  /// Pops with [result], once: not while a listener is being told, after
  /// this frame.
  void _close(bool result) {
    if (_closing) return;
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop(result);
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _resume() async {
    if (_busy || _closing || !widget.allowed()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      error = await widget.resume();
    } catch (_) {
      error = 'Could not resume this agent. Try again.';
    }
    if (!mounted || _closing) return;
    if (error == null) {
      _close(true);
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final machine = widget.machineName;
    final error = _error;
    // Neither the veil nor back closes it while the machine is starting it.
    return PopScope(canPop: !_busy, child: _dialog(machine, error));
  }

  Widget _dialog(String? machine, String? error) {
    return AlertDialog(
      title: Text(
        'Resume ${widget.name}?',
        key: const ValueKey('swarm-resume-title'),
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            machine == null || machine.isEmpty
                ? 'This agent is stopped.'
                : 'This agent is stopped on $machine.',
            style: AppType.body(color: AppPalette.textSecondary),
          ),
          if (error != null) ...[
            const SizedBox(height: AppSpace.s),
            Text(
              error,
              key: const ValueKey('swarm-resume-error'),
              style: AppType.body(color: Theme.of(context).colorScheme.error),
            ),
          ],
        ],
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-resume-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          // The machine is already starting it: nothing to cancel then.
          onPressed: _busy ? null : () => _close(false),
        ),
        SwarmButton(
          key: const ValueKey('swarm-resume-confirm'),
          label: 'Resume',
          busyLabel: 'Resuming…',
          busy: _busy,
          style: SwarmButtonStyle.fill,
          onPressed: _resume,
        ),
      ],
    );
  }
}
