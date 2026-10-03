import 'dart:async';

import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'box_chrome.dart' show BoxAnnouncer;
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
  final _promptFocus = FocusNode(debugLabel: 'Machine deletion');
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
    _promptFocus.dispose();
    super.dispose();
  }

  void _close() => Navigator.pop(context);

  void _delete() {
    if (_deleting) return;
    setState(() {
      _deleting = true;
      _error = null;
    });
    // The focused Delete button is removed while waiting. Keep keyboard input
    // on this prompt so Escape can close it without reaching the panel behind.
    _promptFocus.requestFocus();
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
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    final closeLabel = _deleting ? 'Close' : 'Cancel';
    return TerminalPromptKeys(
      focusNode: _promptFocus,
      cancel: _close,
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Delete machine', style: DesktopChrome.heading()),
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                widget.displayName,
                style: DesktopChrome.text(size: 14, medium: true),
              ),
              const SizedBox(height: 8),
              Text(
                'Delete this machine from your account and close its panes in this window?',
                style: DesktopChrome.text(size: 13),
              ),
              if (_deleting) ...[
                const SizedBox(height: 12),
                Text(
                  'Deletion continues if you close this dialog.',
                  style: DesktopChrome.text(
                    size: 13,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
            ],
          ),
        ),
        footer: _error != null || _deleting
            ? Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(
                  _error ?? 'Deleting machine…',
                  color: _error == null ? DesktopChrome.muted : danger,
                ),
              )
            : null,
        actions: [
          Tooltip(
            message:
                '$closeLabel · ${terminalPromptHint(context, 'picker.cancel', 'esc')}',
            child: TextButton(
              focusNode: _deleting ? null : _cancel,
              onPressed: _close,
              child: Text(closeLabel),
            ),
          ),
          if (!_deleting)
            Tooltip(
              message:
                  'Delete · ${terminalPromptHint(context, 'picker.accept', 'enter')}',
              child: FilledButton(
                key: const Key('machine-delete-confirm'),
                onPressed: _delete,
                style: grid.dangerButtonStyle(),
                child: const Text('Delete'),
              ),
            ),
        ],
      ),
    );
  }
}
