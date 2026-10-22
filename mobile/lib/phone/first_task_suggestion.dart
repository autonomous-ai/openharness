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
