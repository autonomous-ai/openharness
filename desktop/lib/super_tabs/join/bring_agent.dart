import 'dart:convert';

import 'package:flutter/material.dart';

import '../../logging/app_log.dart';
import '../../shared/widgets/app_dialog.dart';
import '../../state/app_state.dart';
import '../../state/harness_launch_integration.dart';
import '../../state/new_harness.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/new_harness_form.dart';
import '../controller.dart';
import 'agent_launcher.dart';

/// Join's "bring your agent" (task #4196): the Cmd-N form, its agent and
/// computer, for the person's Buddy, which the Swarm starts as before. The
/// local transport's identity is used directly; a remote machine is never a
/// fallback for this computer.
Future<Map<String, dynamic>?> showBringAgentForm(
  BuildContext context, {
  required SuperTabController controller,
  required AppNotifier app,
  bool Function()? isCurrent,
}) async {
  final accountId = app.currentUser?.id;
  final here = app.machineStates.values
      .where(
        (m) =>
            m.isLocalMachine &&
            !m.belongsToOtherAccount &&
            !m.machine.isTeamAccount &&
            !m.needsLink,
      )
      .firstOrNull;
  bool current() =>
      context.mounted &&
      app.status == AppStatus.authenticated &&
      app.currentUser?.id == accountId &&
      accountId == controller.accountId &&
      !controller.accessRevoked &&
      (isCurrent?.call() ?? true);
  if (!current()) return null;
  if (here == null) {
    await showAppDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Connect this computer'),
        content: const Text(
          'Wait for this computer’s Harness connection, then start your Buddy from your Buddy chat.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      ),
    );
    return null;
  }
  // One start per computer chosen, each keeping its receipt across retries.
  final launchers = <String, (SwarmAgentLauncher, String)>{};
  SwarmAgentLauncher launcherFor(String machineId) => SwarmAgentLauncher(
    machineId: machineId,
    machineName: app.stateOf(machineId)?.machine.displayName ?? machineId,
    inSwarm:
        controller.snapshot?.machines.any(
          (m) => m['machineId'] == machineId && m['buddyOnly'] != true,
        ) ==
        true,
    isCurrent: current,
    prepare: (operation) async {
      final prepared = await app
          .superTabMachineRequest(machineId, {
            'action': 'prepareContribution',
            'tabId': controller.tabId,
            'scope': 'swarm',
            'operationId': operation,
          })
          .timeout(const Duration(seconds: 20));
      if (prepared['state'] == 'preparing') return prepared;
      if (prepared['state'] != 'ready' ||
          prepared['cwd'] is! String ||
          prepared['engines'] is! List) {
        throw const SwarmAgentLaunchFailure(
          'Update Harness on this computer, then try again.',
        );
      }
      return {
        'name': app.stateOf(machineId)?.machine.displayName ?? machineId,
        'cwd': prepared['cwd'],
        'engines': prepared['engines'],
      };
    },
    command: (command, operation) async {
      final pending = controller.pendingCommand;
      if (pending != null && jsonEncode(pending) != jsonEncode(command)) {
        throw const SwarmAgentLaunchFailure(
          'Finish or retry the pending action in this Swarm first.',
        );
      }
      final result = pending == null
          ? await controller.command(command, operationId: operation)
          : await controller.retry();
      if (result != null) return result;
      final refusal = controller.operationError;
      if (controller.pendingCommand == null &&
          refusal != null &&
          !const {
            'INVALID_COMMAND',
            'VALIDATION_ERROR',
            'UPDATE_REQUIRED',
          }.contains(controller.operationErrorCode)) {
        // Refused, with nothing kept to retry: the server's own sentence
        // (a full or paused computer, say).
        throw SwarmAgentLaunchFailure(refusal);
      }
      if (const {
        'INVALID_COMMAND',
        'VALIDATION_ERROR',
        'UPDATE_REQUIRED',
      }.contains(controller.operationErrorCode)) {
        throw const SwarmAgentLaunchFailure(
          'Update Harness to bring your agent.',
        );
      }
      throw const SwarmAgentLaunchFailure(
        'Your agent’s start is not confirmed. Try again to check it.',
      );
    },
  );
  Map<String, dynamic>? started;
  String? startedOn;
  final swarm = controller.snapshot?.name ?? 'this Swarm';
  final integration = HarnessLaunchIntegration(
    creationId: superTabOperationId(),
    actionLabel: 'Bring agent',
    heading: 'Bring your agent to $swarm',
    intro:
        'Your Buddy is your own agent in $swarm: it runs on your computer, '
        'under your sign-in, and you can also start it later from your Buddy '
        'chat.',
    engines: const ['claude', 'codex'],
    ownMachinesOnly: true,
    prepare: (_, task, _) async => task,
    complete: (_, _) async {},
    beforeSubmit: (_, _) async {},
    startBuddy: (machineId, engine) async {
      final (launcher, operation) = launchers[machineId] ??= (
        launcherFor(machineId),
        superTabOperationId(),
      );
      final result = await launcher.create(engine, operation);
      if (result['agentId'] is! String && result['startId'] is! String) {
        throw const SwarmAgentLaunchFailure(
          'Your agent’s start is not confirmed. Try again to check it.',
        );
      }
      started = result;
      startedOn = machineId;
    },
  );
  final box = NewHarnessController(
    app,
    machineId: here.machine.machineId,
    integration: integration,
  );
  if (!context.mounted || !current()) {
    box.dispose();
    return null;
  }
  try {
    // No transition: the form's controller is disposed as the route closes.
    await showAppDialog<void>(
      context: context,
      transitionDuration: Duration.zero,
      veilBlur: 0,
      // The offer doesn't come back by itself: only ×, Not now or Esc, each
      // a choice, close it; a stray click outside doesn't (#4442).
      barrierDismissible: false,
      builder: (dialog) => Padding(
        padding: const EdgeInsets.all(DesktopChrome.panelPadding),
        child: NewHarnessForm(
          controller: box,
          desktop: true,
          onCreated: () => Navigator.pop(dialog),
          onClose: () => Navigator.pop(dialog),
        ),
      ),
    );
  } finally {
    box.dispose();
  }
  final result = started;
  if (!current() || result == null) return null;
  final conversation = result['conversationId'];
  if (conversation is String) await controller.select(conversation);
  if (current()) {
    // Refresh the host without making a failed wake turn a confirmed start
    // into a second start. Host liveness is still visible through existing UI.
    try {
      await app
          .wakeSuperTabHost(startedOn!)
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      appLog.info(
        'super-tabs',
        'own-agent host wake failed; host status remains visible',
      );
    }
  }
  return current() ? result : null;
}
