import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'message_row.dart';
import 'model.dart';

/// A Lead's typing into a worker's terminal, or a worker's machine telling its
/// Lead it waits at a prompt or hit a usage limit
/// (spec/2026-10-23-lead-sees-agent-terminal.md). The backend writes what
/// happened as one sentence; it is a note in the group, not chat from the
/// agent, so it has no author heading, reply or receipt.
class SuperTabTerminalRow extends StatelessWidget {
  const SuperTabTerminalRow({super.key, required this.message});
  final SuperTabMessage message;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final alert = message.source['kind'] == 'terminal-alert';
    final style = DesktopChrome.metadata(
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        SuperTabMessageRow.bodyInset,
        4,
        SuperTabMessageRow.horizontalInset,
        4,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1, right: 6),
            child: Icon(
              alert ? Icons.warning_amber_rounded : Icons.keyboard_outlined,
              size: 14,
              color: alert ? grid.AppPalette.warn : style.color,
            ),
          ),
          Expanded(child: Text.rich(_typed(message.text, style), style: style)),
        ],
      ),
    );
  }

  /// The backend quotes what was typed in backticks (`` `2` + Enter ``): shown
  /// in the terminal's face instead, so the typed text stands apart from the
  /// sentence around it.
  static TextSpan _typed(String text, TextStyle style) {
    final parts = text.split('`');
    if (parts.length.isEven) return TextSpan(text: text);
    return TextSpan(
      children: [
        for (var i = 0; i < parts.length; i++)
          if (parts[i].isNotEmpty)
            TextSpan(
              text: parts[i],
              style: i.isOdd
                  ? style.copyWith(fontFamily: grid.AppType.monoFamily)
                  : null,
            ),
      ],
    );
  }
}
