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
    grid.AppTheme.watch(context);
    final uncertain = _attempt.awaitingConfirmation && !_closeOnly;
    final status = _busy
        ? 'Restarting…'
        : _confirmAgain
        ? 'May have already restarted.'
        : uncertain
        ? 'Restart not confirmed.'
        : null;
    final actionLabel = uncertain ? 'Check status' : 'Retry';
    final closeLabel = _confirmAgain ? 'Cancel' : 'Close';
    return TerminalPromptKeys(
      focusNode: _focus,
      inputFocus: _focus,
      accept: _accept,
      cancel: _confirmAgain ? _cancelAgain : _close,
      pageDown: () => _page(1),
      pageUp: () => _page(-1),
      child: DesktopPromptSurface(
        key: const ValueKey('agent-restart-prompt'),
        body: ExcludeFocusTraversal(
          child: DesktopPromptScrollBody(
            controller: _body,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  _terminal ? 'Restart Terminal' : 'Restart Harness',
                  style: DesktopChrome.heading(),
                ),
                const SizedBox(height: DesktopChrome.groupGap),
                Text(
                  _attempt.agent?.name ?? widget.agentId,
                  style: DesktopChrome.text(size: 14, medium: true),
                ),
                if (widget.notifier
                        .stateOf(widget.machineId)
                        ?.machine
                        .displayName
                    case final machine?) ...[
                  const SizedBox(height: 4),
                  Text(machine, style: DesktopChrome.metadata()),
                ],
                const SizedBox(height: DesktopChrome.groupGap),
                if (_confirmAgain)
                  Text(
                    'Start another restart attempt for this harness?',
                    style: DesktopChrome.text(size: 13),
                  )
                else ...[
                  Text(
                    _terminal ? 'Starts a fresh shell in the same pane.' : 'Restarts the harness in the same pane and tries to resume its conversation.',
                    style: DesktopChrome.text(size: 13),
                  ),
                  if (_busy) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Restart continues if you close this dialog.',
                      style: DesktopChrome.text(
                        size: 13,
                        color: DesktopChrome.muted,
                      ),
                    ),
                  ],
                  if (_error case final error?) ...[
                    const SizedBox(height: 12),
                    DesktopPromptMessage(
                      error,
                      color: uncertain
                          ? grid.AppPalette.warn
                          : Theme.of(context).colorScheme.error,
                    ),
                  ],
                  if (_fresh) ...[
                    const SizedBox(height: 12),
                    DesktopPromptMessage(
                      'Started a new conversation. The previous conversation could not be resumed.',
                      color: grid.AppPalette.warn,
                    ),
                  ],
                ],
              ],
            ),
          ),
        ),
        footer: status == null
            ? null
            : Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(
                  status,
                  color: _busy ? DesktopChrome.muted : grid.AppPalette.warn,
                ),
              ),
        actions: [
          if (!_confirmAgain && uncertain && !_busy)
            OutlinedButton(
              key: const Key('restart-again'),
              onPressed: _askAgain,
              child: const Text('Restart again…'),
            ),
          Tooltip(
            message:
                '$closeLabel · ${terminalPromptHint(context, 'picker.cancel', 'esc')}',
            child: _closeOnly && !_confirmAgain && !_busy
                ? FilledButton(onPressed: _close, child: const Text('Close'))
                : TextButton(
                    focusNode: _confirmAgain ? _cancel : null,
                    onPressed: _confirmAgain ? _cancelAgain : _close,
                    child: Text(closeLabel),
                  ),
          ),
          if (_confirmAgain)
            FilledButton(
              key: const Key('restart-again-confirm'),
              onPressed: _restartAgain,
              style: grid.dangerButtonStyle(),
              child: const Text('Restart'),
            )
          else if (!_busy && !_closeOnly)
            Tooltip(
              message:
                  '$actionLabel · ${terminalPromptHint(context, 'picker.accept', 'enter')}',
              child: FilledButton(
                key: const Key('agent-restart-retry'),
                onPressed: _retry,
                child: Text(actionLabel),
              ),
            ),
        ],
      ),
    );
  }
}
