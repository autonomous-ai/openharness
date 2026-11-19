import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/chat/command_list.dart';
import 'package:harness_mobile/core/agent_command.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

/// Chat UI's input: one rounded card with the message on top and a row of controls under it —
/// attach, the agent's model, the turn's spinner, the mic, and Send (Stop while the agent works and
/// nothing is typed).
///
/// A message goes as the daemon's `message` (`TerminalSession.sendComposerText`), which types it into
/// the agent's prompt and submits it the way that agent needs — the same road the mic's words take.
class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.onSend,
    required this.onStop,
    required this.working,
    this.enabled = true,
    this.onAttach,
    this.model,
    this.onModel,
    this.mic,
    this.commands,
    this.sheetCommands = const {},
  });

  /// Sends the text; false when it did not go, and the text is kept.
  final Future<bool> Function(String text) onSend;

  /// Esc to the agent: what stops a turn in every agent's own terminal.
  final VoidCallback onStop;

  final bool working;
  final bool enabled;

  /// A picture or a file for the agent; null leaves the `+` out.
  final VoidCallback? onAttach;

  /// The agent and the model it is running, as the chip says it (`Claude Opus 5.5 · Medium`);
  /// null leaves the chip out.
  final String? model;

  /// Opens the agent's Model sheet (`chat/agent_settings_sheet.dart`); null leaves the chip a label.
  final VoidCallback? onModel;

  /// The mic, built by the page that owns the voice input.
  final Widget? mic;

  /// The agent's `/` commands, asked the first time `/` is typed; null shows no list.
  final Future<List<AgentCommand>> Function()? commands;

  /// The commands that open the agent's own picker (`/model`), sent bare: Send opens the Model sheet ([onModel])
  /// instead. The agent's picker would open in the terminal Chat UI hides, and wait there for a key nobody sees.
  final Set<String> sheetCommands;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

/// A command still being typed: `/` and its name, nothing after it.
final _typingCommand = RegExp(r'^/(\S*)$');

class _ChatComposerState extends State<ChatComposer> {
  final _text = TextEditingController();
  bool _sending = false;
  List<AgentCommand> _commands = const [];
  bool _askedCommands = false;

  @override
  void initState() {
    super.initState();
    _text.addListener(() {
      if (_typingCommand.hasMatch(_text.text)) _askCommands();
      setState(() {});
    });
  }

  void _askCommands() {
    final ask = widget.commands;
    if (ask == null || _askedCommands) return;
    _askedCommands = true;
    unawaited(
      ask().then((commands) {
        if (!mounted) return;
        // None came: asked again at the next `/`, once the machine may answer.
        if (commands.isEmpty) _askedCommands = false;
        setState(() => _commands = commands);
      }),
    );
  }

  /// The commands the list shows for what is typed; empty hides it.
  List<AgentCommand> get _shown {
    final typing = _typingCommand.firstMatch(_text.text);
    return typing == null
        ? const []
        : AgentCommand.matching(_commands, typing.group(1)!);
  }

  void _pick(AgentCommand command) {
    final text = '/${command.name} ';
    _text.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _text.text;
    if (text.trim().isEmpty || _sending) return;
    final sheet = widget.onModel;
    if (sheet != null && widget.sheetCommands.contains(text.trim())) {
      _text.clear();
      sheet();
      return;
    }
    setState(() => _sending = true);
    final sent = await widget.onSend(text);
    if (!mounted) return;
    setState(() => _sending = false);
    if (sent) _text.clear();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final typed = _text.text.trim().isNotEmpty;
    final canSend = widget.enabled && !_sending && typed;
    final stops = widget.working && !typed;
    final shown = _shown;
    return ColoredBox(
      color: AppPalette.windowBg,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.m,
            AppSpace.s,
            AppSpace.m,
            AppSpace.m,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (shown.isNotEmpty) ...[
                CommandList(commands: shown, onPick: _pick),
                const SizedBox(height: AppSpace.s),
              ],
              _card(canSend: canSend, stops: stops),
            ],
          ),
        ),
      ),
    );
  }

  Widget _card({required bool canSend, required bool stops}) => DecoratedBox(
    decoration: BoxDecoration(
      color: AppPalette.cardBg,
      borderRadius: BorderRadius.circular(24),
      border: Border.all(color: AppPalette.divider),
    ),
    child: Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpace.l,
        AppSpace.s,
        AppSpace.s,
        AppSpace.s,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _text,
            enabled: widget.enabled,
            minLines: 1,
            maxLines: 6,
            textCapitalization: TextCapitalization.sentences,
            style: AppType.body(color: AppPalette.textPrimary),
            decoration: InputDecoration(
              hintText: 'Ask anything, / for commands',
              hintStyle: AppType.body(color: AppPalette.textFaint),
              border: InputBorder.none,
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(
                vertical: AppSpace.s + 2,
              ),
            ),
          ),
          const SizedBox(height: AppSpace.xs),
          Row(
            children: [
              if (widget.onAttach != null)
                _RoundButton(
                  tooltip: 'Attach',
                  icon: LucideIcons.plus,
                  outlined: true,
                  onPressed: widget.enabled ? widget.onAttach : null,
                ),
              // The chip takes every point the controls at the end leave it, so the
              // model's whole name shows: only a name longer than that is cut.
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: widget.model == null
                      ? const SizedBox.shrink()
                      : Padding(
                          padding: const EdgeInsets.only(
                            left: AppSpace.s,
                            right: AppSpace.xs,
                          ),
                          child: _ModelChip(
                            label: widget.model!,
                            onTap: widget.onModel,
                          ),
                        ),
                ),
              ),
              if (widget.working)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
                  child: SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: AppPalette.textSecondary,
                    ),
                  ),
                ),
              ?widget.mic,
              const SizedBox(width: AppSpace.xs),
              if (stops)
                _RoundButton(
                  tooltip: 'Stop',
                  icon: LucideIcons.square,
                  filled: AppPalette.textPrimary,
                  foreground: AppPalette.windowBg,
                  onPressed: widget.enabled ? widget.onStop : null,
                )
              else
                _RoundButton(
                  tooltip: 'Send',
                  icon: LucideIcons.arrowUp,
                  filled: canSend ? AppPalette.accent : null,
                  foreground: canSend ? Colors.white : AppPalette.textFaint,
                  onPressed: canSend ? () => unawaited(_send()) : null,
                ),
            ],
          ),
        ],
      ),
    ),
  );
}

/// A 36pt round control: outlined (`+`), filled (Send, Stop) or on the card's own ground.
class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.filled,
    this.foreground,
    this.outlined = false,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;
  final Color? filled;
  final Color? foreground;
  final bool outlined;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    child: Semantics(
      button: true,
      label: tooltip,
      enabled: onPressed != null,
      child: InkResponse(
        onTap: onPressed,
        radius: 22,
        child: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: filled ?? AppSurface.recess,
            border: outlined ? Border.all(color: AppPalette.divider) : null,
          ),
          child: Icon(
            icon,
            size: 18,
            color: foreground ?? AppPalette.textPrimary,
          ),
        ),
      ),
    ),
  );
}

/// The agent and the model it runs, as a pill; a tap opens the agent's Model sheet.
class _ModelChip extends StatelessWidget {
  const _ModelChip({required this.label, this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: onTap != null,
    label: 'Model, $label',
    excludeSemantics: true,
    child: Material(
      color: AppSurface.recess,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
          // As wide as its words, from the left: a Container told an alignment fills the row, and centred them.
          child: Align(
            alignment: Alignment.centerLeft,
            widthFactor: 1,
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppType.label(color: AppPalette.textPrimary),
            ),
          ),
        ),
      ),
    ),
  );
}
