import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import 'terminal_name_prompt.dart';
import 'terminal_prompt.dart';

/// Shared by command search and every agent title. The editor owns its input
/// until unmount; the model owns a pending rename after the route closes.
Future<void> showAgentRenameDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String currentName, {
  AppKeymap? keymap,
}) async {
  await showTerminalPrompt<String>(
    context,
    keymap: keymap,
    builder: (_) => TerminalNamePrompt(
      title: 'Rename Harness',
      detail: notifier.stateOf(machineId)?.machine.displayName,
      name: notifier.pendingAgentName(machineId, agentId) ?? currentName,
      fieldKey: const Key('agent-rename-input'),
      fieldLabel: 'Harness name',
      pending: notifier.pendingAgentRename(machineId, agentId),
      save: (name) => notifier.renameAgent(machineId, agentId, name),
    ),
  );
}
