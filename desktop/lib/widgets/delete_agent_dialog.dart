import 'dart:async';

import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'box_chrome.dart' show BoxAnnouncer;
import 'engine_identity.dart';
import 'terminal_prompt.dart';

/// Explicit Stop ends the running process across its views.
/// Requests remain with the model if this prompt is dismissed.
Future<void> confirmDeleteAgent(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String name, {
  String? engine,
  AppKeymap? keymap,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => _StopAgentPrompt(
    notifier: notifier,
    machineId: machineId,
    agentId: agentId,
    name: name,
    terminal: isTerminalEngine(engine),
  ),
);

class _StopAgentPrompt extends StatefulWidget {
  const _StopAgentPrompt({
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.name,
    required this.terminal,
  });
  final AppNotifier notifier;
  final String machineId, agentId, name;
  final bool terminal;
  @override
  State<_StopAgentPrompt> createState() => _StopAgentPromptState();
}

class _StopAgentPromptState extends State<_StopAgentPrompt> {
  final _cancel = FocusNode(debugLabel: 'Cancel stop');
  final _promptFocus = FocusNode(debugLabel: 'Pending stop');
  final _body = ScrollController();
  final _announcer = BoxAnnouncer();
  late final Future<String?> Function() _requestStop;
  bool _stopping = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _requestStop = widget.notifier.prepareAgentStop(
      widget.machineId,
      widget.agentId,
    );
    if (widget.notifier.pendingAgentStop(widget.machineId, widget.agentId)
        case final pending?) {
      _stopping = true;
      unawaited(_finish(pending));
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _stopping) _promptFocus.requestFocus();
      });
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

  void _stop() {
    if (_stopping) return;
    // The Stop button is removed while pending; keep Escape and custom keys
    // in the prompt instead of letting focus fall back to the terminal.
    _promptFocus.requestFocus();
    setState(() {
      _stopping = true;
      _error = null;
    });
    unawaited(_finish(_requestStop()));
  }

  Future<void> _finish(Future<String?> request) async {
    String? error;
    try {
      error = await request;
    } catch (_) {
      error = 'Could not stop the harness. Try again.';
    }
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _stopping = false;
      _error = error;
    });
    _announcer.row(context, error);
    _focusCancel();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    final closeLabel = _stopping ? 'Close' : 'Cancel';
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
              Text(
                widget.terminal ? 'Stop Terminal' : 'Stop Harness',
                style: DesktopChrome.heading(),
              ),
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                widget.name,
                style: DesktopChrome.text(size: 14, medium: true),
              ),
              if (widget.notifier.stateOf(widget.machineId)?.machine.displayName
                  case final machine?) ...[
                const SizedBox(height: 4),
                Text(machine, style: DesktopChrome.metadata()),
              ],
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                widget.terminal
                    ? 'End this shell and anything running in it? Files are kept.'
                    : 'Stop this harness? Project files and saved conversation history are kept.',
                style: DesktopChrome.text(size: 13),
              ),
              const SizedBox(height: 8),
              Text(
                'Its panes close across tabs. Switching tabs keeps it running.',
                style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
              ),
              if (_stopping) ...[
                const SizedBox(height: 12),
                Text(
                  'Stopping continues if you close this dialog.',
                  style: DesktopChrome.text(
                    size: 13,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
            ],
          ),
        ),
        footer: _error != null || _stopping
            ? Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(
                  _error ?? 'Stopping…',
                  color: _error == null ? DesktopChrome.muted : danger,
                ),
              )
            : null,
        actions: [
          Tooltip(
            message:
                '$closeLabel · ${terminalPromptHint(context, 'picker.cancel', 'esc')}',
            child: TextButton(
              focusNode: _stopping ? null : _cancel,
              onPressed: _close,
              child: Text(closeLabel),
            ),
          ),
          if (!_stopping)
            Tooltip(
              message:
                  'Stop · ${terminalPromptHint(context, 'picker.accept', 'enter')}',
              child: FilledButton(
                key: const Key('agent-stop-confirm'),
                onPressed: _stop,
                style: grid.dangerButtonStyle(),
                child: const Text('Stop'),
              ),
            ),
        ],
      ),
    );
  }
}
