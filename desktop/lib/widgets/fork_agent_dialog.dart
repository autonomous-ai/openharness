import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/agent_names.dart';
import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'box_chrome.dart' show BoxAnnouncer, ReadlineKeys;
import 'terminal_prompt.dart';

export '../core/agent_names.dart' show forkNameFor;

/// The model retains the draft, receipt and destination across dismissal.
Future<void> forkHarness(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String name, {
  String? engine,
  AppKeymap? keymap,
}) async {
  final result = await showTerminalPrompt<ForkAgentResult>(
    context,
    keymap: keymap,
    builder: (_) => _ForkAgentPrompt(
      notifier: notifier,
      machineId: machineId,
      agentId: agentId,
      sourceName: name,
      engine: engine,
    ),
  );
  if (result == null || !context.mounted) return;
  final message =
      result.notice ??
      (result.level == 'handoff'
          ? 'Fork opened with a handoff summary of the source conversation.'
          : null);
  if (message != null) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }
}

class _ForkAgentPrompt extends StatefulWidget {
  const _ForkAgentPrompt({
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.sourceName,
    this.engine,
  });
  final AppNotifier notifier;
  final String machineId, agentId, sourceName;
  final String? engine;
  @override
  State<_ForkAgentPrompt> createState() => _ForkAgentPromptState();
}

class _ForkAgentPromptState extends State<_ForkAgentPrompt> {
  late AgentForkAttempt _attempt;
  final _name = TextEditingController();
  final _task = TextEditingController();
  final _nameFocus = FocusNode(debugLabel: 'Fork name');
  final _taskFocus = FocusNode(debugLabel: 'Fork task');
  final _body = ScrollController();
  final _announcer = BoxAnnouncer();
  bool _busy = false;
  String? _error;
  bool get _locked => _busy || _attempt.awaitingConfirmation;
  bool get _composing => [_name, _task].any(
    (controller) =>
        controller.value.composing.isValid &&
        !controller.value.composing.isCollapsed,
  );

  @override
  void initState() {
    super.initState();
    _attempt = widget.notifier.forkAttempt(
      widget.machineId,
      widget.agentId,
      name: forkNameFor(widget.sourceName),
    );
    _name.text = _attempt.name;
    _task.text = _attempt.prompt;
    _error = _attempt.result?.error;
    _nameFocus.addListener(_focusChanged);
    _taskFocus.addListener(_focusChanged);
    if (_attempt.pending case final pending?) {
      _busy = true;
      unawaited(_finish(pending));
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _taskFocus.requestFocus();
      }
    });
  }

  void _focusChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _nameFocus.removeListener(_focusChanged);
    _taskFocus.removeListener(_focusChanged);
    _nameFocus.dispose();
    _taskFocus.dispose();
    _name.dispose();
    _task.dispose();
    _body.dispose();
    super.dispose();
  }

  void _changed(String _) {
    if (_locked) return;
    _attempt.name = _name.text;
    _attempt.prompt = _task.text;
    _attempt.result = null;
    setState(() => _error = null);
  }

  void _close() {
    if (!_composing) Navigator.pop(context);
  }

  void _accept() {
    if (_composing) return;
    if (_nameFocus.hasFocus) {
      _taskFocus.requestFocus();
      return;
    }
    if (_taskFocus.hasFocus) {
      _submit();
      return;
    }
    activatePromptControl();
  }

  void _submit() {
    if (_busy || _composing) return;
    if (!_attempt.awaitingConfirmation && _name.text.trim().isEmpty) {
      setState(() => _error = 'Name cannot be empty');
      _nameFocus.requestFocus();
      return;
    }
    if (!_attempt.awaitingConfirmation && _name.text.characters.length > 80) {
      setState(() => _error = 'Use at most 80 characters for the name.');
      _nameFocus.requestFocus();
      return;
    }
    _taskFocus.requestFocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    unawaited(
      _finish(
        widget.notifier.forkAgent(
          widget.machineId,
          widget.agentId,
          attempt: _attempt,
        ),
      ),
    );
  }

  Future<void> _finish(Future<ForkAgentResult> request) async {
    ForkAgentResult result;
    try {
      result = await request;
    } catch (_) {
      result = const ForkAgentResult(
        error: 'Could not confirm the fork. Check harnesses before starting another.',
      );
    }
    if (!mounted) return;
    if (result.error == null) {
      Navigator.pop(context, result);
      return;
    }
    setState(() {
      _busy = false;
      _error = result.error;
    });
    _taskFocus.requestFocus();
    _announcer.row(context, result.error!);
  }

  void _startAnother() {
    if (!widget.notifier.discardForkAttempt(
      widget.machineId,
      widget.agentId,
      _attempt,
    )) {
      return;
    }
    _attempt = widget.notifier.forkAttempt(
      widget.machineId,
      widget.agentId,
      name: _name.text,
      prompt: _task.text,
    );
    setState(
      () => _error =
          'The previous fork may already exist. Confirm to start another.',
    );
    _taskFocus.requestFocus();
  }

  void _newline() {
    if (_locked || _composing || !_taskFocus.hasFocus) return;
    final value = _task.value;
    if (!value.selection.isValid) return;
    _task.value = TextEditingValue(
      text: value.text.replaceRange(
        value.selection.start,
        value.selection.end,
        '\n',
      ),
      selection: TextSelection.collapsed(offset: value.selection.start + 1),
    );
    _changed(_task.text);
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

  void _vertical(int direction) {
    final input = _nameFocus.hasFocus ? _nameFocus : _taskFocus;
    if (input.hasFocus && input.context != null) {
      Actions.maybeInvoke(
        input.context!,
        ExtendSelectionVerticallyToAdjacentLineIntent(
          forward: direction > 0,
          collapseSelection: true,
        ),
      );
    } else if (direction > 0) {
      FocusManager.instance.primaryFocus?.nextFocus();
    } else {
      FocusManager.instance.primaryFocus?.previousFocus();
    }
  }

  Widget _input(
    String label,
    TextEditingController controller,
    FocusNode focus, {
    bool task = false,
  }) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      borderSide: BorderSide(color: DesktopChrome.rim),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: DesktopChrome.control(medium: true)),
        const SizedBox(height: DesktopChrome.controlGap),
        Semantics(
          label: task ? 'Fork first task, optional' : 'Fork name',
          child: ReadlineKeys(
            controller: controller,
            enabled: !_locked,
            onChanged: _changed,
            child: TextField(
              key: ValueKey(task ? 'fork-task' : 'fork-name'),
              controller: controller,
              focusNode: focus,
              readOnly: _locked,
              style: DesktopChrome.text(size: 14),
              cursorColor: DesktopChrome.accent,
              textAlignVertical: TextAlignVertical.center,
              minLines: task ? 3 : 1,
              maxLines: task ? 6 : 1,
              textInputAction: task
                  ? TextInputAction.done
                  : TextInputAction.next,
              decoration: InputDecoration(
                hintText: task
                    ? 'What should the fork work on?'
                    : 'Harness name',
                hintStyle: DesktopChrome.text(
                  size: 14,
                  color: DesktopChrome.muted,
                ),
                isDense: true,
                filled: true,
                fillColor: DesktopChrome.field,
                border: border,
                enabledBorder: border,
                focusedBorder: border.copyWith(
                  borderSide: BorderSide(
                    color: DesktopChrome.focusRing,
                    width: grid.AppDesktop.focusWidth,
                  ),
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
              ),
              onChanged: _changed,
              onEditingComplete: () {},
              onSubmitted: (_) {
                if (task) {
                  _submit();
                } else {
                  _taskFocus.requestFocus();
                }
              },
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final uncertain = _attempt.awaitingConfirmation;
    final status = _busy
        ? 'Waiting for fork…'
        : uncertain
        ? 'Fork may already exist.'
        : null;
    final actionLabel = uncertain ? 'Check status' : 'Fork';
    final closeLabel = _locked ? 'Close' : 'Cancel';
    final cwd = _attempt.source?.project?.cwd;
    return TerminalPromptKeys(
      composing: () => _composing,
      inputFocus: _nameFocus.hasFocus ? _nameFocus : _taskFocus,
      cancel: _close,
      accept: _accept,
      submit: _submit,
      next: () => _vertical(1),
      previous: () => _vertical(-1),
      pageDown: () => _page(1),
      pageUp: () => _page(-1),
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.enter, alt: true): _newline,
          if (KeymapTheme.of(context) == null)
            const SingleActivator(LogicalKeyboardKey.enter, meta: true):
                _submit,
        },
        child: DesktopPromptSurface(
          width: 520,
          body: DesktopPromptScrollBody(
            controller: _body,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Fork Harness', style: DesktopChrome.heading()),
                const SizedBox(height: DesktopChrome.groupGap),
                Text(
                  'From ${_attempt.source?.name ?? widget.sourceName}',
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
                if (cwd != null && cwd.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    cwd,
                    style: grid.AppType.monoMeta(color: DesktopChrome.muted),
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  widget.engine == 'opencode'
                      ? 'Starts from a handoff summary, in the same project folder.'
                      : 'Continues the conversation in the same project folder.',
                  style: DesktopChrome.text(
                    size: 13,
                    color: DesktopChrome.muted,
                  ),
                ),
                const SizedBox(height: DesktopChrome.groupGap),
                _input('Name', _name, _nameFocus),
                const SizedBox(height: DesktopChrome.groupGap),
                _input('First task (optional)', _task, _taskFocus, task: true),
                if (_error case final error?) ...[
                  const SizedBox(height: 12),
                  Semantics(
                    liveRegion: true,
                    child: DesktopPromptMessage(
                      error,
                      color: uncertain
                          ? grid.AppPalette.warn
                          : Theme.of(context).colorScheme.error,
                    ),
                  ),
                ],
                if (uncertain && !_busy) ...[
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton(
                      key: const Key('fork-start-another'),
                      onPressed: _startAnother,
                      child: const Text('Start another fork'),
                    ),
                  ),
                ],
                if (_busy) ...[
                  const SizedBox(height: 12),
                  Text(
                    'Forking continues if you close this dialog.',
                    style: DesktopChrome.text(
                      size: 13,
                      color: DesktopChrome.muted,
                    ),
                  ),
                ],
              ],
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
            Tooltip(
              message:
                  '$closeLabel · ${terminalPromptHint(context, 'picker.cancel', 'esc')}',
              child: TextButton(onPressed: _close, child: Text(closeLabel)),
            ),
            Tooltip(
              message:
                  '$actionLabel · ${terminalPromptHint(context, 'picker.add_here', 'cmd-enter')}',
              child: FilledButton(
                key: const Key('fork-confirm'),
                onPressed: _busy ? null : _submit,
                child: Text(actionLabel),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
