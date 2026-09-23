import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_type.dart';

import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../screens/login_screen.dart';
import '../state/app_state.dart';
import '../shortcuts/app_keymap.dart';
import '../state/swarm_catalog.dart';
import 'link_another_machine_dialog.dart';
import 'remote_folder_picker.dart';
import 'clone_repository_dialog.dart';
import 'terminal_name_prompt.dart';
import 'terminal_prompt.dart';

Future<String?> showSwarmRenameDialog(
  BuildContext context,
  String name, {
  AppKeymap? keymap,
}) => showTerminalPrompt<String>(
  context,
  keymap: keymap,
  builder: (_) => TerminalNamePrompt(
    title: 'Rename Tab',
    name: name,
    fieldKey: const Key('tab-rename-input'),
    fieldLabel: 'Tab name',
    maxLength: 80,
  ),
);

Future<SavedSwarmProject?> showSwarmProjectDialog(
  BuildContext context,
  AppNotifier notifier,
) => showAppDialog<SavedSwarmProject>(
  context: context,
  builder: (_) => _ProjectDialog(notifier: notifier),
);

class _ProjectDialog extends StatefulWidget {
  const _ProjectDialog({required this.notifier});
  final AppNotifier notifier;
  @override
  State<_ProjectDialog> createState() => _ProjectDialogState();
}

class _ProjectDialogState extends State<_ProjectDialog> {
  late String? machineId =
      (widget.notifier.machineStates.values
                  .where((m) => m.isLocalMachine)
                  .firstOrNull ??
              widget.notifier.machineStates.values.firstOrNull)
          ?.machine
          .machineId;
  String? path;
  String? error;
  bool picking = false;
  int _machineRevision = 0;
  String get folderName =>
      (path
                  ?.split(RegExp(r'[/\\]'))
                  .where((part) => part.isNotEmpty)
                  .lastOrNull ??
              path ??
              '')
          .characters
          .take(80)
          .join();

  Future<void> browse() async {
    final id = machineId;
    if (id == null || picking) return;
    final revision = _machineRevision;
    setState(() {
      picking = true;
      error = null;
    });
    try {
      final folder = widget.notifier.stateOf(id)?.isLocalMachine == true
          ? await getDirectoryPath(initialDirectory: path)
          : await showRemoteFolderPicker(
              context,
              notifier: widget.notifier,
              machineId: id,
              initialPath: path,
            );
      if (!mounted || revision != _machineRevision) return;
      setState(() {
        path = folder ?? path;
      });
    } catch (_) {
      if (mounted && revision == _machineRevision) {
        setState(
          () =>
              error = 'Could not browse this machine. Reconnect and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => picking = false);
    }
  }

  Future<void> clone() async {
    if (picking) return;
    final revision = _machineRevision;
    setState(() => picking = true);
    final folder = await showCloneRepositoryDialog(
      context,
      initialFolder: path,
    );
    if (!mounted) return;
    setState(() {
      picking = false;
      if (folder != null && revision == _machineRevision) {
        path = folder;
        error = null;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add project'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Choose an existing working folder.',
              style: AppType.body(color: Colors.white60),
            ),
            const SizedBox(height: 20),
            if (machineId != null)
              AppSelectField<String>(
                value: machineId!,
                options: [
                  for (final machine in widget.notifier.machineStates.values)
                    SelectOption(
                      value: machine.machine.machineId,
                      label: machine.isLocalMachine
                          ? 'This computer'
                          : machine.machine.displayName,
                    ),
                ],
                onChanged: (value) => setState(() {
                  if (machineId == value) return;
                  _machineRevision++;
                  machineId = value;
                  path = null;
                  error = null;
                }),
              ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: machineId == null || picking ? null : browse,
              icon: const Icon(Icons.folder_open, size: 17),
              label: Text(
                path ?? 'Choose folder',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (widget.notifier.stateOf(machineId ?? '')?.isLocalMachine ==
                true)
              TextButton(
                onPressed: picking ? null : clone,
                style: TextButton.styleFrom(foregroundColor: Colors.white70),
                child: const Text('Clone repository…'),
              ),
            if (error != null)
              Text(error!, style: AppType.body(color: Colors.orangeAccent)),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: path == null || folderName.isEmpty || picking
              ? null
              : () => Navigator.pop(
                  context,
                  SavedSwarmProject(
                    machineId: machineId!,
                    path: path!,
                    name: folderName,
                  ),
                ),
          child: const Text('Add project'),
        ),
      ],
    );
  }
}

/// Link another machine. The dialog itself lives in
/// `link_another_machine_dialog.dart`; this name is what every caller — the
/// Machines menu, ⌘ commands, the machines manager — has always used.
///
/// The one thing on this desk that cannot work without an account: machines are
/// listed, paired and relayed THROUGH it, so a guest is asked to sign in first —
/// over the desk, and only here, where reaching for another machine is exactly
/// what they just did. Declining leaves them where they were.
Future<void> showSwarmLinkDialog(
  BuildContext context,
  AppNotifier notifier, {
  AppKeymap? keymap,
}) async {
  if (notifier.isGuest) {
    final signedIn = await showSignInSheet(
      context,
      notifier,
      reason: 'Your machines live on your account. Sign in to link another one '
          'to this computer.',
    );
    if (!signedIn || !context.mounted) return;
  }
  return showLinkAnotherMachineDialog(context, notifier, keymap: keymap);
}
