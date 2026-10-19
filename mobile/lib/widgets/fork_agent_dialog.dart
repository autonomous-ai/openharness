import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'engine_identity.dart';

/// The name a fork is offered: the source's, marked as a fork — the desktop's `forkNameFor`.
String forkNameFor(String name) =>
    '${name.trim().isEmpty ? 'Harness' : name.trim()} - fork';

/// Fork Harness: the desktop's prompt, laid out as the phone's rename card — a name, an optional
/// first task, and Fork.
///
/// Returns the fork once it exists, to open; null when the dialog was closed first. A fork still on
/// its way when it closes carries on — [AppNotifier.forkAgent] holds it, and the same attempt's
/// [AgentForkAttempt.pending] says when it lands.
Future<ForkAgentResult?> showForkAgentDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
) => showAppDialog<ForkAgentResult>(
  context: context,
  builder: (_) =>
      _ForkDialog(notifier: notifier, machineId: machineId, agentId: agentId),
);

class _ForkDialog extends StatefulWidget {
  const _ForkDialog({
    required this.notifier,
    required this.machineId,
    required this.agentId,
  });

  final AppNotifier notifier;
  final String machineId, agentId;

  @override
  State<_ForkDialog> createState() => _ForkDialogState();
}

class _ForkDialogState extends State<_ForkDialog> {
  late AgentForkAttempt _attempt;
  final _name = TextEditingController();
  final _task = TextEditingController();
  final _nameFocus = FocusNode(debugLabel: 'Fork name');
  final _taskFocus = FocusNode(debugLabel: 'Fork task');

  /// A fork is on its way: Fork spins, and nothing sends a second one behind it.
  bool _busy = false;
  String? _error;

  /// The fields are held while the fork is out or its outcome unknown: an edit then would be a
  /// fork nobody sent.
  bool get _locked => _busy || _attempt.awaitingConfirmation;

  @override
  void initState() {
    super.initState();
    final source = widget.notifier
        .stateOf(widget.machineId)
        ?.agents
        .where((agent) => agent.id == widget.agentId)
        .firstOrNull;
    _attempt = widget.notifier.forkAttempt(
      widget.machineId,
      widget.agentId,
      name: forkNameFor(source?.displayName ?? ''),
    );
    _name.text = _attempt.name;
    _task.text = _attempt.prompt;
    _error = _attempt.result?.error;
    _nameFocus.addListener(_refocus);
    _taskFocus.addListener(_refocus);
    // Reopened while the fork is still out: wait for that one, never send another.
    if (_attempt.pending case final pending?) {
      _busy = true;
      unawaited(_finish(pending));
    }
  }

  @override
  void dispose() {
    _nameFocus.removeListener(_refocus);
    _taskFocus.removeListener(_refocus);
    _nameFocus.dispose();
    _taskFocus.dispose();
    _name.dispose();
    _task.dispose();
    super.dispose();
  }

  void _refocus() {
    if (mounted) setState(() {});
  }

  /// An edit is the draft, kept on the attempt so the form opened again still has it, and it takes
  /// back the last refusal — that was about choices no longer there.
  void _changed(String _) {
    if (_locked) return;
    _attempt.name = _name.text;
    _attempt.prompt = _task.text;
    _attempt.result = null;
    setState(() => _error = null);
  }

  void _submit() {
    if (_busy) return;
    if (!_attempt.awaitingConfirmation) {
      if (_name.text.trim().isEmpty) {
        setState(() => _error = 'Name cannot be empty');
        _nameFocus.requestFocus();
        return;
      }
      if (_name.text.characters.length > 80) {
        setState(() => _error = 'Use at most 80 characters for the name.');
        _nameFocus.requestFocus();
        return;
      }
    }
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
    // Only a route still in the navigator is this dialog's to close — see the rename dialog's
    // `_submit` for the fade that made `mounted` alone pop the page under it.
    if (!mounted || !(ModalRoute.of(context)?.isActive ?? false)) return;
    if (result.error == null) {
      Navigator.of(context).pop(result);
      return;
    }
    setState(() {
      _busy = false;
      _error = result.error;
    });
  }

  /// The explicit way past an unconfirmed fork: a new attempt with the same draft, said to be one.
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
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    final uncertain = _attempt.awaitingConfirmation;
    final source = _attempt.source;
    final machine = widget.notifier
        .stateOf(widget.machineId)
        ?.machine
        .displayName;
    final error = _error;
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: Semantics(
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: 'Fork Harness',
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          // Scrolls rather than overflows: with the keyboard up a short phone has less room than
          // two fields and their lines ask for.
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    if (source != null) ...[
                      SizedBox.square(
                        dimension: 32,
                        child: Center(
                          child: EngineMark(
                            engine: source.engine,
                            displayName: source.engineDisplayName,
                            size: 32,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                    ],
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Fork Harness',
                            style: TextStyle(
                              color: grid.AppPalette.textPrimary,
                              fontSize: 17,
                              fontWeight: grid.AppFont.semibold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            [
                              'From ${source?.displayName ?? 'harness'}',
                              ?machine,
                            ].join(' · '),
                            key: const Key('fork-source'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: _muted,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  source?.engine == 'opencode'
                      ? 'Starts from a handoff summary, in the same project folder.'
                      : 'Continues the conversation in the same project folder.',
                  style: _muted,
                ),
                const SizedBox(height: 16),
                _field(
                  key: const Key('fork-name'),
                  controller: _name,
                  focus: _nameFocus,
                  hint: 'Name',
                  autofocus: true,
                  action: TextInputAction.next,
                  onSubmitted: (_) => _taskFocus.requestFocus(),
                  danger: error != null && !uncertain ? danger : null,
                ),
                const SizedBox(height: 10),
                _field(
                  key: const Key('fork-task'),
                  controller: _task,
                  focus: _taskFocus,
                  hint: 'First task (optional)',
                  maxLines: 4,
                  action: TextInputAction.newline,
                ),
                if (error != null)
                  Semantics(
                    liveRegion: true,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(2, 10, 2, 0),
                      child: Text(
                        error,
                        key: const Key('fork-error'),
                        style: TextStyle(
                          color: uncertain ? grid.AppPalette.warn : danger,
                          fontSize: 13,
                          height: 1.35,
                        ),
                      ),
                    ),
                  ),
                if (uncertain && !_busy)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      key: const Key('fork-start-another'),
                      onPressed: _startAnother,
                      child: const Text('Start another fork'),
                    ),
                  ),
                if (_busy)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(
                      'Forking continues if you close this dialog.',
                      style: _muted,
                    ),
                  ),
                const SizedBox(height: 20),
                _actions(uncertain: uncertain),
              ],
            ),
          ),
        ),
      ),
    );
  }

  TextStyle get _muted =>
      TextStyle(color: grid.AppPalette.textSecondary, fontSize: 13);

  Widget _field({
    required Key key,
    required TextEditingController controller,
    required FocusNode focus,
    required String hint,
    required TextInputAction action,
    bool autofocus = false,
    int maxLines = 1,
    ValueChanged<String>? onSubmitted,
    Color? danger,
  }) {
    final accent = grid.AppPalette.accent;
    OutlineInputBorder border(Color color, {double width = 1}) =>
        OutlineInputBorder(
          borderRadius: BorderRadius.circular(kDialogControlRadius),
          borderSide: BorderSide(color: color, width: width),
        );
    return TextField(
      key: key,
      controller: controller,
      focusNode: focus,
      autofocus: autofocus,
      readOnly: _locked,
      minLines: 1,
      maxLines: maxLines,
      textInputAction: action,
      inputFormatters: [LengthLimitingTextInputFormatter(2000)],
      style: grid.kFieldTextStyle.copyWith(fontSize: 16),
      onChanged: _changed,
      onSubmitted: onSubmitted,
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(color: grid.AppPalette.textFaint, fontSize: 16),
        filled: true,
        fillColor: grid.AppPalette.panelBg,
        isDense: true,
        contentPadding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
        border: border(danger ?? grid.AppGlass.hair),
        enabledBorder: border(danger ?? grid.AppGlass.hair),
        focusedBorder: border(danger ?? accent, width: 1.5),
      ),
    );
  }

  /// Cancel (Close once a fork is out) and Fork (Check status once its outcome is unknown), half
  /// the width each — the rename card's pair.
  Widget _actions({required bool uncertain}) {
    final accent = grid.AppPalette.accent;
    return Row(
      children: [
        Expanded(
          child: FilledButton(
            key: const Key('fork-cancel'),
            style: appDialogButtonStyle(
              background: grid.AppSurface.recess,
              foreground: grid.AppPalette.textPrimary,
            ),
            onPressed: () => Navigator.of(context).pop(),
            child: Text(_locked ? 'Close' : 'Cancel'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: FilledButton(
            key: const Key('fork-confirm'),
            style: appDialogButtonStyle(
              background: accent,
              foreground: Colors.white,
              // Full colour while it spins: the press was taken.
              disabledBackground: accent,
              disabledForeground: Colors.white,
            ),
            onPressed: _busy ? null : _submit,
            child: _busy
                ? Semantics(
                    label: 'Waiting for fork…',
                    child: SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                        backgroundColor: Colors.white.withValues(alpha: 0.35),
                      ),
                    ),
                  )
                : Text(uncertain ? 'Check status' : 'Fork'),
          ),
        ),
      ],
    );
  }
}
