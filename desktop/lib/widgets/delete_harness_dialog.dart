import 'dart:async';

import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../super_tabs/lead_guard.dart';
import '../super_tabs/controller.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'box_chrome.dart' show BoxAnnouncer;
import 'terminal_prompt.dart';

/// Delete Harness: a harness and its saved conversation, gone for good
/// ([AppNotifier.purgeAgent]). Stop keeps the conversation to reopen; this is
/// how a harness leaves Open Harness. Running or stopped alike.
Future<void> confirmDeleteHarness(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String name, {
  AppKeymap? keymap,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => _DeleteHarnessPrompt(
    notifier: notifier,
    machineId: machineId,
    agentId: agentId,
    name: name,
  ),
);

class _DeleteHarnessPrompt extends StatefulWidget {
  const _DeleteHarnessPrompt({
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.name,
  });
  final AppNotifier notifier;
  final String machineId, agentId, name;
  @override
  State<_DeleteHarnessPrompt> createState() => _DeleteHarnessPromptState();
}

class _DeleteHarnessPromptState extends State<_DeleteHarnessPrompt> {
  String? get _protectionReason => superTabLeadProtectionReason(
    widget.notifier,
    widget.machineId,
    widget.agentId,
  );
  final _cancel = FocusNode(debugLabel: 'Cancel delete');
  final _promptFocus = FocusNode(debugLabel: 'Pending delete');
  final _body = ScrollController();
  final _announcer = BoxAnnouncer();
  final _observedTabs = <SuperTabController>[];
  bool _deleting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _observedTabs.addAll(widget.notifier.superTabs.loadedControllers);
    for (final tab in _observedTabs) {
      tab.addListener(_onTabChanged);
    }
    _focusCancel();
  }

  void _onTabChanged() {
    if (mounted) setState(() {});
  }

  void _focusCancel() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted && ModalRoute.of(context)?.isCurrent != false) {
      _cancel.requestFocus();
    }
  });

  @override
  void dispose() {
    for (final tab in _observedTabs) {
      tab.removeListener(_onTabChanged);
    }
    _cancel.dispose();
    _promptFocus.dispose();
    _body.dispose();
    super.dispose();
  }

  void _close() => Navigator.pop(context);
  void _page(int direction) {
    if (!_body.hasClients) return;
    final position = _body.position;
    _body.jumpTo(
      (position.pixels + direction * position.viewportDimension * .8).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    );
  }

  Future<void> _delete() async {
    if (_deleting || _protectionReason != null) return;
    _promptFocus.requestFocus();
    setState(() {
      _deleting = true;
      _error = null;
    });
    String? error;
    try {
      error = await widget.notifier.purgeAgent(
        widget.machineId,
        widget.agentId,
      );
    } catch (_) {
      error = 'Could not delete the harness. Try again.';
    }
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
      pageDown: () => _page(1),
      pageUp: () => _page(-1),
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          controller: _body,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Delete Harness', style: DesktopChrome.heading()),
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                widget.name,
                style: DesktopChrome.text(size: 14, medium: true),
              ),
              if (widget.notifier.shownMachineName(widget.machineId)
                  case final machine?) ...[
                const SizedBox(height: 4),
                Text(machine, style: DesktopChrome.metadata()),
              ],
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                _protectionReason ??
                    'Delete this harness and its saved conversation? It stops if '
                        'running, and it cannot be opened again. Project files are kept.',
                style: DesktopChrome.text(size: 13),
              ),
              if (_protectionReason == null) ...[
                const SizedBox(height: 8),
                Text(
                  'To keep the conversation to reopen later, use Stop Harness instead.',
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
                  _error ?? 'Deleting…',
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
                  _protectionReason ??
                  'Delete · ${terminalPromptHint(context, 'picker.accept', 'enter')}',
              child: FilledButton(
                key: const Key('agent-delete-confirm'),
                onPressed: _protectionReason == null
                    ? () => unawaited(_delete())
                    : null,
                style: grid.dangerButtonStyle(),
                child: const Text('Delete'),
              ),
            ),
        ],
      ),
    );
  }
}
