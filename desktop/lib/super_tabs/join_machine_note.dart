import 'dart:async';

import 'package:flutter/material.dart';

import '../core/runtime_platform.dart';
import 'controller.dart';
import 'join_machine.dart';

/// The note after joining a Swarm (Scholes, 2026-10-29): this computer was
/// added, teammates' agents run here only in Harness Team, never as the
/// person, and Pause or Remove undo it at once. When it could not be added,
/// why, and where to add it.
///
/// [open]: the Swarm's controller ([SuperTabs.open]), which Pause and Remove
/// command.
void showJoinedMachineNote(
  BuildContext context,
  Future<SuperTabController> Function(String tabId) open,
  SwarmJoinedMachine note, {
  String? operatingSystem,
}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  final here = (operatingSystem ?? RuntimePlatform.operatingSystem) == 'macos'
      ? 'This Mac'
      : 'This computer';
  final text = note.added
      ? '$here was added to ${note.swarmName}. Teammates\' agents run here '
            'only in Harness Team, never as you.'
      : '$here was not added to ${note.swarmName}. ${note.problem}';
  messenger.showSnackBar(
    SnackBar(
      key: const Key('swarm-joined-machine-note'),
      duration: const Duration(seconds: 12),
      showCloseIcon: true,
      content: Row(
        children: [
          Expanded(child: Text(text)),
          if (note.added) ...[
            const SizedBox(width: 12),
            _NoteAction(
              key: const Key('swarm-joined-machine-pause'),
              label: 'Pause',
              run: () => _act(open, note, {
                'type': 'machine.pause',
                'machineId': note.machineId,
                'paused': true,
              }),
              messenger: messenger,
            ),
            _NoteAction(
              key: const Key('swarm-joined-machine-remove'),
              label: 'Remove',
              run: () => _act(open, note, {
                'type': 'machine.remove',
                'machineId': note.machineId,
              }),
              messenger: messenger,
            ),
          ],
        ],
      ),
    ),
  );
}

/// Null when it was done; otherwise the Swarm's own sentence.
Future<String?> _act(
  Future<SuperTabController> Function(String tabId) open,
  SwarmJoinedMachine note,
  Map<String, dynamic> command,
) async {
  try {
    final c = await open(note.tabId);
    final result = await c.command(command);
    return result == null
        ? c.operationError ?? 'Could not do that. Try again from Machines.'
        : null;
  } catch (_) {
    return 'Could not do that. Try again from Machines.';
  }
}

class _NoteAction extends StatefulWidget {
  const _NoteAction({
    super.key,
    required this.label,
    required this.run,
    required this.messenger,
  });

  final String label;
  final Future<String?> Function() run;
  final ScaffoldMessengerState messenger;

  @override
  State<_NoteAction> createState() => _NoteActionState();
}

class _NoteActionState extends State<_NoteAction> {
  bool _busy = false;

  Future<void> _press() async {
    if (_busy) return;
    setState(() => _busy = true);
    final failure = await widget.run();
    if (!widget.messenger.mounted) return;
    widget.messenger.hideCurrentSnackBar();
    if (failure != null) {
      widget.messenger.showSnackBar(SnackBar(content: Text(failure)));
    }
  }

  @override
  Widget build(BuildContext context) => TextButton(
    onPressed: _busy ? null : () => unawaited(_press()),
    child: Text(widget.label),
  );
}
