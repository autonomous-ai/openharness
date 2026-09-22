import 'dart:async';

import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import 'box_chrome.dart';
import 'terminal_prompt.dart';

/// Account deletion, shared by the manager and native/legacy machine menus.
/// A pending request stays with the model if its confirmation is closed.
Future<void> confirmDeleteMachine(
  BuildContext context,
  AppNotifier notifier, {
  required String machineId,
  required String displayName,
  AppKeymap? keymap,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => _DeleteMachinePrompt(
    notifier: notifier,
    machineId: machineId,
    displayName: displayName,
  ),
);

class _DeleteMachinePrompt extends StatefulWidget {
  const _DeleteMachinePrompt({
    required this.notifier,
    required this.machineId,
    required this.displayName,
  });
  final AppNotifier notifier;
  final String machineId, displayName;
  @override
  State<_DeleteMachinePrompt> createState() => _DeleteMachinePromptState();
}

class _DeleteMachinePromptState extends State<_DeleteMachinePrompt> {
  final _cancel = FocusNode(debugLabel: 'Cancel machine deletion');
  final _announcer = BoxAnnouncer();
  bool _deleting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.notifier.pendingMachineDelete(widget.machineId)
        case final pending?) {
      _deleting = true;
      unawaited(_finish(pending));
    } else {
      _focusCancel();
    }
  }

  void _focusCancel() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted && ModalRoute.of(context)?.isCurrent != false) {
      _cancel.requestFocus();
    }
  });

  @override
  void dispose() {
    _cancel.dispose();
    super.dispose();
  }

  void _close() => Navigator.pop(context);

  void _delete() {
    if (_deleting) return;
    setState(() {
      _deleting = true;
      _error = null;
    });
    unawaited(_finish(widget.notifier.deleteMachine(widget.machineId)));
  }

  Future<void> _finish(Future<String?> request) async {
    final error = await request;
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _deleting = false;
      _error = error;
    });
    _announcer.row(context, error);
    _focusCancel();
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => TerminalPromptKeys(
        cancel: _close,
        child: TerminalPrompt(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        'Delete machine',
                        style: boxMonoStyle(color: kBoxFaint),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        widget.displayName,
                        style: boxMonoStyle(weight: FontWeight.w600),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Delete this machine from your account and close its panes in this window?',
                        style: boxMonoStyle(color: Colors.white70),
                      ),
                      const SizedBox(height: 12),
                      if (!_deleting)
                        Wrap(
                          spacing: 12,
                          children: [
                            terminalPromptButton(
                              'Cancel',
                              _close,
                              focusNode: _cancel,
                            ),
                            terminalPromptButton(
                              'Delete',
                              _delete,
                              danger: true,
                              key: const Key('machine-delete-confirm'),
                            ),
                          ],
                        )
                      else
                        Text(
                          'Deletion continues if you close this prompt.',
                          style: boxMonoStyle(color: kBoxFaint),
                        ),
                    ],
                  ),
                ),
              ),
              BoxHintStrip(
                message: _error ?? (_deleting ? 'Deleting machine…' : null),
                isError: _error != null,
                hints: [
                  if (!_deleting)
                    BoxHint(
                      terminalPromptHint(context, 'picker.accept', 'enter'),
                      'select',
                    ),
                  if (!_deleting)
                    BoxHint(
                      terminalPromptHint(context, 'picker.complete', 'tab'),
                      'controls',
                    ),
                  BoxHint(
                    terminalPromptHint(context, 'picker.cancel', 'esc'),
                    'close',
                    onTap: _close,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
