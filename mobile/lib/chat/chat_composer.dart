import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

/// Chat UI's input: a message to the agent, and Stop while it works.
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
  });

  /// Sends the text; false when it did not go, and the text is kept.
  final Future<bool> Function(String text) onSend;

  /// Esc to the agent: what stops a turn in every agent's own terminal.
  final VoidCallback onStop;

  final bool working;
  final bool enabled;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _text = TextEditingController();
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _text.text;
    if (text.trim().isEmpty || _sending) return;
    setState(() => _sending = true);
    final sent = await widget.onSend(text);
    if (!mounted) return;
    setState(() => _sending = false);
    if (sent) _text.clear();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final canSend = widget.enabled && !_sending && _text.text.trim().isNotEmpty;
    return ColoredBox(
      color: AppPalette.windowBg,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.m,
            AppSpace.s,
            AppSpace.m,
            AppSpace.s,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _text,
                  enabled: widget.enabled,
                  minLines: 1,
                  maxLines: 6,
                  textCapitalization: TextCapitalization.sentences,
                  style: AppType.body(color: AppPalette.textPrimary),
                  decoration: InputDecoration(
                    hintText: 'Message',
                    hintStyle: AppType.body(color: AppPalette.textFaint),
                    filled: true,
                    fillColor: AppSurface.wellFill,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: AppSpace.m + 2,
                      vertical: AppSpace.s + 2,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(20),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: AppSpace.s),
              if (widget.working && _text.text.trim().isEmpty)
                IconButton.filled(
                  tooltip: 'Stop',
                  onPressed: widget.enabled ? widget.onStop : null,
                  style: IconButton.styleFrom(
                    backgroundColor: AppPalette.textPrimary,
                    foregroundColor: AppPalette.windowBg,
                  ),
                  icon: const Icon(LucideIcons.square, size: 16),
                )
              else
                IconButton.filled(
                  tooltip: 'Send',
                  onPressed: canSend ? () => unawaited(_send()) : null,
                  style: IconButton.styleFrom(
                    backgroundColor: AppPalette.accent,
                    foregroundColor: Colors.white,
                  ),
                  icon: const Icon(LucideIcons.arrowUp, size: 18),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
