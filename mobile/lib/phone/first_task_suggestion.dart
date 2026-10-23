import 'package:flutter/material.dart';

import 'tty.dart';
import 'tty_controls.dart';

/// The same first-task capsule in New Harness and the first session.
class FirstTaskSuggestion extends StatelessWidget {
  const FirstTaskSuggestion({
    super.key,
    required this.text,
    required this.onTap,
  });
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: text,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: tty.dim),
          ),
          child: TtyText(text, size: TtySize.meta, color: tty.text),
        ),
      ),
    );
  }
}

/// The first session's one suggestion: the task in a capsule with a visible Send beside it
/// (owner, 2026-10-22). Send is disabled ([onSend] null) while the session takes no input.
class FirstSessionSuggestion extends StatelessWidget {
  const FirstSessionSuggestion({
    super.key,
    required this.text,
    required this.onSend,
  });

  final String text;
  final VoidCallback? onSend;

  static const sendKey = ValueKey('first-session-send');

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final enabled = onSend != null;
    return Container(
      constraints: const BoxConstraints(minHeight: 44),
      padding: const EdgeInsets.only(left: 14, top: 4, right: 4, bottom: 4),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: tty.dim),
      ),
      child: Row(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text(
                text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: tty.style(size: TtySize.meta, color: tty.text),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Semantics(
            button: true,
            enabled: enabled,
            label: 'Send',
            excludeSemantics: true,
            child: GestureDetector(
              key: sendKey,
              behavior: HitTestBehavior.opaque,
              onTap: onSend,
              child: Container(
                constraints: const BoxConstraints(minHeight: 36, minWidth: 64),
                padding: const EdgeInsets.symmetric(horizontal: 16),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: enabled ? tty.green : tty.selected,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Text(
                  'Send',
                  style: tty.style(
                    size: TtySize.meta,
                    weight: FontWeight.w600,
                    color: enabled ? tty.onFill(tty.theme.black) : tty.faint,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
