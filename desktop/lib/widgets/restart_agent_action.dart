import 'dart:async';

import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import 'box_chrome.dart';
import 'engine_identity.dart';
import 'terminal_prompt.dart';

/// Restart is an immediate action. Its progress and recovery remain accessible
/// through the same prompt, even after Escape returns to the terminal.
Future<void> restartHarness(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId, {
  AppKeymap? keymap,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => _RestartAgentPrompt(
    notifier: notifier,
    machineId: machineId,
    agentId: agentId,
  ),
);

class _RestartAgentPrompt extends StatefulWidget {
  const _RestartAgentPrompt({
    required this.notifier,
    required this.machineId,
    required this.agentId,
  });
  final AppNotifier notifier;
  final String machineId, agentId;
  @override
  State<_RestartAgentPrompt> createState() => _RestartAgentPromptState();
}

class _RestartAgentPromptState extends State<_RestartAgentPrompt> {
  late AgentRestartAttempt _attempt;
  final _focus = FocusNode(debugLabel: 'Restart status');
  final _cancel = FocusNode(debugLabel: 'Cancel another restart');
  final _body = ScrollController();
  final _announcer = BoxAnnouncer();
  bool _busy = false, _confirmAgain = false, _fresh = false;
  String? _error;
  bool get _closeOnly => _fresh || _attempt.result?.retryable == false;
  bool get _terminal => isTerminalEngine(_attempt.agent?.engine);

  @override
  void initState() {
    super.initState();
    _attempt = widget.notifier.restartAttempt(widget.machineId, widget.agentId);
    _error = _attempt.result?.error;
    if (_attempt.pending case final pending?) {
      _busy = true;
      unawaited(_finish(pending));
    } else if (_attempt.result == null) {
      _busy = true;
      unawaited(
        _finish(
          widget.notifier.restartAgent(
            widget.machineId,
            widget.agentId,
            attempt: _attempt,
          ),
        ),
      );
    }
    _focusStatus();
  }

  void _focusStatus() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted && ModalRoute.of(context)?.isCurrent != false) {
      _focus.requestFocus();
    }
  });

  @override
  void dispose() {
    _focus.dispose();
    _cancel.dispose();
    _body.dispose();
    super.dispose();
  }

  void _close() => Navigator.pop(context);

  void _accept() {
    if (_confirmAgain || !_focus.hasPrimaryFocus) {
      activatePromptControl();
      return;
    }
    if (_busy) return;
    if (_closeOnly) {
      _close();
    } else {
      _retry();
    }
  }

  void _retry() {
    if (_busy) return;
    _focus.requestFocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    unawaited(
      _finish(
        widget.notifier.restartAgent(
          widget.machineId,
          widget.agentId,
          attempt: _attempt,
        ),
      ),
    );
  }

  Future<void> _finish(Future<RestartAgentResult> request) async {
    RestartAgentResult result;
    try {
      result = await request;
    } catch (_) {
      result = const RestartAgentResult(
        error: 'Could not confirm the restart. Check the terminal before restarting again.',
      );
    }
    if (!mounted) return;
    if (result.error == null && (result.resumed || _terminal)) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = result.error;
      _fresh = result.error == null && !result.resumed;
    });
    _announcer.row(context, _error ?? 'Restarted with a new conversation.');
    _focusStatus();
  }

  void _askAgain() {
    setState(() => _confirmAgain = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _cancel.requestFocus();
    });
  }

  void _cancelAgain() {
    setState(() => _confirmAgain = false);
    _focusStatus();
  }

  void _restartAgain() {
    if (!widget.notifier.discardRestartAttempt(
      widget.machineId,
      widget.agentId,
      _attempt,
    )) {
      return;
    }
    _attempt = widget.notifier.restartAttempt(widget.machineId, widget.agentId);
    setState(() => _confirmAgain = false);
    _retry();
  }

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

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => TerminalPromptKeys(
        focusNode: _focus,
        inputFocus: _focus,
        accept: _accept,
        cancel: _confirmAgain ? _cancelAgain : _close,
        pageDown: () => _page(1),
        pageUp: () => _page(-1),
        child: TerminalPrompt(
          child: Column(
            key: const ValueKey('agent-restart-prompt'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Flexible(
                child: ExcludeFocus(
                  child: SingleChildScrollView(
                    controller: _body,
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          _terminal ? 'Restart Terminal' : 'Restart Harness',
                          style: boxMonoStyle(color: kBoxFaint),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          _attempt.agent?.name ?? widget.agentId,
                          style: boxMonoStyle(weight: FontWeight.w600),
                        ),
                        if (widget.notifier
                                .stateOf(widget.machineId)
                                ?.machine
                                .displayName
                            case final machine?)
                          Text(machine, style: boxMonoStyle(color: kBoxFaint)),
                        if (!_confirmAgain) ...[
                          const SizedBox(height: 10),
                          Text(
                            _terminal
                                ? 'Starts a fresh shell in the same pane.'
                                : 'Restarts the harness in the same pane and tries to resume its conversation.',
                            style: boxMonoStyle(color: Colors.white70),
                          ),
                          if (_busy) ...[
                            const SizedBox(height: 8),
                            Text(
                              'Restart continues if you close this prompt.',
                              style: boxMonoStyle(color: kBoxFaint),
                            ),
                          ],
                          if (_error case final error?) ...[
                            const SizedBox(height: 12),
                            Text(
                              error,
                              style: boxMonoStyle(color: Colors.orangeAccent),
                            ),
                          ],
                          if (_fresh) ...[
                            const SizedBox(height: 12),
                            Text(
                              'Started a new conversation. The previous session could not be resumed.',
                              style: boxMonoStyle(color: Colors.orangeAccent),
                            ),
                          ],
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              if (_confirmAgain) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
                  child: Wrap(
                    spacing: 12,
                    children: [
                      terminalPromptButton(
                        'Cancel',
                        _cancelAgain,
                        focusNode: _cancel,
                      ),
                      terminalPromptButton(
                        'Restart',
                        _restartAgain,
                        key: const Key('restart-again-confirm'),
                      ),
                    ],
                  ),
                ),
              ] else if (_attempt.awaitingConfirmation && !_busy && !_closeOnly)
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: terminalPromptButton(
                      'Restart again…',
                      _askAgain,
                      key: const Key('restart-again'),
                    ),
                  ),
                ),
              BoxHintStrip(
                message: _busy
                    ? 'Restarting…'
                    : (_confirmAgain
                          ? 'May have already restarted.'
                          : (_attempt.awaitingConfirmation && !_closeOnly
                                ? 'Restart not confirmed.'
                                : null)),
                isError: !_busy && _attempt.awaitingConfirmation,
                hints: [
                  if (!_busy)
                    BoxHint(
                      terminalPromptHint(context, 'picker.accept', 'enter'),
                      _confirmAgain
                          ? 'select'
                          : (_closeOnly
                                ? 'close'
                                : (_attempt.awaitingConfirmation && !_closeOnly
                                      ? 'check status'
                                      : 'retry')),
                      onTap: _confirmAgain
                          ? null
                          : (_closeOnly ? _close : _retry),
                    ),
                  if (_confirmAgain)
                    BoxHint(
                      terminalPromptHint(context, 'picker.complete', 'tab'),
                      'controls',
                    ),
                  BoxHint(
                    terminalPromptHint(context, 'picker.cancel', 'esc'),
                    _confirmAgain ? 'back' : 'close',
                    onTap: _confirmAgain ? _cancelAgain : _close,
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
