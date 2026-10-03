import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../state/swarm_navigation.dart' show externalEngineName;
import '../state/take_over.dart';
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
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

  String get _engineName => externalEngineName(widget.engine);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final busy = widget.busy;
    return TerminalPromptKeys(
      cancel: () => _pick(null),
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Move to Harness', style: DesktopChrome.heading()),
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                widget.title,
                key: const ValueKey('take-over-title'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.text(size: 14, medium: true),
              ),
              if (widget.machine case final machine?) ...[
                const SizedBox(height: 4),
                Text(
                  machine,
                  style: DesktopChrome.text(
                    size: 13,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
              const SizedBox(height: 16),
              Text(
                busy
                    ? '$_engineName is working on it in a terminal.'
                    : 'It is open in $_engineName in a terminal. '
                          'Moving it here quits it there.',
                style: DesktopChrome.text(size: 13),
              ),
              const SizedBox(height: 8),
              Text(
                busy
                    ? engineResumesWithMessage.contains(widget.engine)
                          ? 'Wait moves it here when this turn ends. '
                                'Take Over Now stops the turn and tells it to continue.'
                          : 'Wait moves it here when this turn ends. '
                                'Take Over Now stops the turn; it picks up when you ask.'
                    : 'The conversation is kept.',
                style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => _pick(null),
            style: TextButton.styleFrom(
              foregroundColor: DesktopChrome.foreground,
              textStyle: DesktopChrome.text(size: 13),
            ),
            child: const Text('Cancel'),
          ),
          if (busy)
            OutlinedButton(
              key: const Key('take-over-now'),
              onPressed: () => _pick(TakeOver.now),
              style: OutlinedButton.styleFrom(
                foregroundColor: Theme.of(context).colorScheme.error,
                textStyle: DesktopChrome.text(size: 13),
              ),
              child: const Text('Take Over Now'),
            ),
          FilledButton(
            key: Key(busy ? 'take-over-wait' : 'take-over-move'),
            focusNode: _first,
            onPressed: () => _pick(busy ? TakeOver.wait : TakeOver.idle),
            style: FilledButton.styleFrom(
              textStyle: DesktopChrome.text(size: 13),
            ),
            child: Text(busy ? 'Wait' : 'Move Here'),
          ),
        ],
      ),
    );
  }
}
