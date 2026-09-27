import 'package:flutter/material.dart';

import '../shortcuts/app_keymap.dart';
import '../state/take_over.dart';
import '../terminal/terminal_text.dart';
import 'box_chrome.dart';
import 'terminal_prompt.dart';

export '../state/take_over.dart';

/// Asks whether to move a conversation open in a terminal into Harness. Idle,
/// the choice is to move it. Mid-turn, the choice is to wait for the turn to
/// end or stop it now. Null when dismissed: it stays where it is.
Future<TakeOver?> askTakeOver(
  BuildContext context, {
  required String title,
  required String engine,
  required bool busy,
  String? machine,
  AppKeymap? keymap,
}) => showTerminalPrompt<TakeOver>(
  context,
  keymap: keymap,
  builder: (_) => _TakeOverPrompt(
    title: title,
    engine: engine,
    busy: busy,
    machine: machine,
  ),
);

class _TakeOverPrompt extends StatefulWidget {
  const _TakeOverPrompt({
    required this.title,
    required this.engine,
    required this.busy,
    this.machine,
  });
  final String title, engine;
  final bool busy;
  final String? machine;
  @override
  State<_TakeOverPrompt> createState() => _TakeOverPromptState();
}

class _TakeOverPromptState extends State<_TakeOverPrompt> {
  final _first = FocusNode(debugLabel: 'Take over');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _first.requestFocus();
    });
  }

  @override
  void dispose() {
    _first.dispose();
    super.dispose();
  }

  void _pick(TakeOver? choice) => Navigator.pop(context, choice);

  String get _engineName => switch (widget.engine) {
    'claude' => 'Claude Code',
    'codex' => 'Codex',
    final other => other,
  };

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final busy = widget.busy;
    return ListenableBuilder(
      listenable: terminalFontStore,
      builder: (context, _) => TerminalPromptKeys(
        cancel: () => _pick(null),
        child: TerminalPrompt(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Move to Harness',
                      style: boxMonoStyle(color: kBoxFaint),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      widget.title,
                      key: const ValueKey('take-over-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: boxMonoStyle(weight: FontWeight.w600),
                    ),
                    if (widget.machine case final machine?) ...[
                      const SizedBox(height: 4),
                      Text(machine, style: boxMonoStyle(color: kBoxFaint)),
                    ],
                    const SizedBox(height: 10),
                    Text(
                      busy
                          ? '$_engineName is working on it in a terminal.'
                          : 'It is open in $_engineName in a terminal. '
                                'Moving it here quits it there.',
                      style: boxMonoStyle(color: Colors.white70),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      busy
                          ? 'Wait moves it here when this turn ends. '
                                'Take Over Now stops the turn and tells it to continue.'
                          : 'The conversation is kept.',
                      style: boxMonoStyle(color: kBoxFaint),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                child: Wrap(
                  spacing: 12,
                  children: [
                    if (busy) ...[
                      terminalPromptButton(
                        'Wait',
                        () => _pick(TakeOver.wait),
                        focusNode: _first,
                        key: const Key('take-over-wait'),
                      ),
                      terminalPromptButton(
                        'Take Over Now',
                        () => _pick(TakeOver.now),
                        danger: true,
                        key: const Key('take-over-now'),
                      ),
                    ] else
                      terminalPromptButton(
                        'Move Here',
                        () => _pick(TakeOver.idle),
                        focusNode: _first,
                        key: const Key('take-over-move'),
                      ),
                    terminalPromptButton('Cancel', () => _pick(null)),
                  ],
                ),
              ),
              BoxHintStrip(
                hints: [
                  BoxHint(
                    terminalPromptHint(context, 'picker.accept', 'enter'),
                    'select',
                  ),
                  BoxHint(
                    terminalPromptHint(context, 'picker.complete', 'tab'),
                    'controls',
                  ),
                  BoxHint(
                    terminalPromptHint(context, 'picker.cancel', 'esc'),
                    'close',
                    onTap: () => _pick(null),
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
