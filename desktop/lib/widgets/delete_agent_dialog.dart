import 'dart:async';

import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_font_store.dart';
import 'box_chrome.dart';
import 'engine_identity.dart';
import 'terminal_prompt.dart';

/// Stopping ends the running process; closing a pane only removes its view.
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
      error = 'Could not stop the agent. Try again.';
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
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: terminalFontStore,
    builder: (context, _) => TerminalPromptKeys(
      focusNode: _promptFocus,
      cancel: _close,
      pageDown: () => _page(1),
      pageUp: () => _page(-1),
      child: TerminalPrompt(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Flexible(
              child: SingleChildScrollView(
                controller: _body,
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      widget.terminal ? 'Stop Terminal' : 'Stop Agent',
                      style: boxMonoStyle(size: 12, color: kBoxFaint),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      widget.name,
                      style: boxMonoStyle(weight: FontWeight.w600),
                    ),
                    if (widget.notifier
                            .stateOf(widget.machineId)
                            ?.machine
                            .displayName
                        case final machine?) ...[
                      const SizedBox(height: 4),
                      Text(
                        machine,
                        style: boxMonoStyle(size: 11, color: kBoxFaint),
                      ),
                    ],
                    const SizedBox(height: 10),
                    Text(
                      widget.terminal
                          ? 'End this shell and anything running in it? Files are kept.'
                          : 'End the running agent? Project files and saved conversation history are kept.',
                      style: boxMonoStyle(size: 12, color: Colors.white70),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Its panes close across tabs. Close Pane keeps it running.',
                      style: boxMonoStyle(size: 11, color: kBoxFaint),
                    ),
                    if (_stopping) ...[
                      const SizedBox(height: 12),
                      Text(
                        'Stopping continues if you close this prompt.',
                        style: boxMonoStyle(size: 11, color: kBoxFaint),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            if (!_stopping)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                child: Wrap(
                  spacing: 12,
                  children: [
                    terminalPromptButton('Cancel', _close, focusNode: _cancel),
                    terminalPromptButton(
                      'Stop',
                      _stop,
                      danger: true,
                      key: const Key('agent-stop-confirm'),
                    ),
                  ],
                ),
              ),
            BoxHintStrip(
              message: _error ?? (_stopping ? 'Stopping…' : null),
              isError: _error != null,
              hints: [
                if (!_stopping)
                  BoxHint(
                    terminalPromptHint(context, 'picker.accept', 'enter'),
                    'select',
                  ),
                if (!_stopping)
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
