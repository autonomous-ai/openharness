import 'dart:convert';

import 'package:flutter/material.dart';

import '../../shared/widgets/app_dialog.dart';
import '../../state/app_state.dart';
import '../../logging/app_log.dart';
import '../controller.dart';
import 'agent_dialog.dart';
import 'agent_launcher.dart';

/// Shared entry for the left pane and the post-join Buddy prompt. The local
/// transport's identity is used directly; a remote machine is never a fallback.
Future<Map<String, dynamic>?> showSwarmNewAgentDialog(
  BuildContext context, {
  required SuperTabController controller,
  required AppNotifier app,
  bool bringing = false,
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
          'Wait for this computer’s Harness connection, then try bringing your agent again.',
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
  final machineId = here.machine.machineId;
  // Probe executables through the existing hidden native path; do not inspect
  // a sign-in or read settings here. Those belong to the owner's actual CLI.
  await app
      .probeEngines(machineId, force: true)
      .timeout(const Duration(seconds: 20), onTimeout: () {});
  if (!current()) return null;
  final engines = [
    for (final e in ['claude', 'codex'])
      if (here.engines[e]?.installed == true) e,
  ];
  final launcher = SwarmAgentLauncher(
    machineId: machineId,
    machineName: here.machine.displayName,
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
      if (prepared['state'] == 'preparing') {
        throw const SwarmAgentLaunchFailure(
          'Your agent’s folder is still being prepared. Retry to check it.',
        );
      }
      if (prepared['state'] != 'ready' ||
          prepared['cwd'] is! String ||
          prepared['engines'] is! List) {
        throw const SwarmAgentLaunchFailure(
          'Update Harness on this computer, then try again.',
        );
      }
      return {
        'name': here.machine.displayName,
        'cwd': prepared['cwd'],
        'engines': prepared['engines'],
      };
    },
    command: (command, operation) async {
      final pending = controller.pendingCommand;
      if (pending != null && jsonEncode(pending) != jsonEncode(command)) {
        throw const SwarmAgentLaunchFailure(
          'Finish or retry the pending action in this org first.',
        );
      }
      final result = pending == null
          ? await controller.command(command, operationId: operation)
          : await controller.retry();
      if (result != null) return result;
      if (const {
        'INVALID_COMMAND',
        'VALIDATION_ERROR',
        'UPDATE_REQUIRED',
      }.contains(controller.operationErrorCode)) {
        throw const SwarmAgentLaunchFailure(
          'Update Harness to use this agent flow.',
        );
      }
      throw const SwarmAgentLaunchFailure(
        'The agent start is not confirmed. Retry to check it.',
      );
    },
  );
  if (!context.mounted || !current()) return null;
  final result = await showAppDialog<Map<String, dynamic>>(
    context: context,
    builder: (_) => SwarmAgentDialog(
      bringing: bringing,
      engines: engines,
      create: launcher.create,
      isCurrent: current,
    ),
  );
  if (!current() || result == null) return null;
  final conversation = result['conversationId'];
  if (conversation is String) await controller.select(conversation);
  if (current()) {
    // Refresh the host without making a failed wake turn a confirmed start
    // into a second start. Host liveness is still visible through existing UI.
    try {
      await app
          .wakeSuperTabHost(machineId)
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
