import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'message_row.dart';
import 'model.dart';

/// A Lead's typing into a worker's terminal, or a worker's machine telling its
/// Lead it waits at a prompt or hit a usage limit
/// (spec/2026-10-23-lead-sees-agent-terminal.md), or two projects' tasks that
/// own the same code (spec 2026-10-23-leads-see-and-talk.md). The backend writes what
/// happened as one sentence; it is a note in the group, not chat from the
/// agent, so it has no author heading, reply or receipt.
class SuperTabTerminalRow extends StatelessWidget {
  const SuperTabTerminalRow({super.key, required this.message});
  final SuperTabMessage message;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final alert = message.source['kind'] != 'terminal-input';
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
              alert ? AppIcons.triangleAlert : AppIcons.keyboard,
              size: 14,
              color: alert ? grid.AppPalette.warn : style.color,
            ),
          ),
          Expanded(child: Text.rich(_typed(message.text, style), style: style)),
        ],
      ),
    );
  }

  /// The backend wraps what was typed in one pair of backticks
  /// (`` `2` + Enter ``), and the text inside is the Lead's as typed, backticks
  /// included (`` `echo `date`` ``): so the first and the last backtick are the
  /// wrapper, and what lies between is shown whole, in the terminal's face.
  static TextSpan _typed(String text, TextStyle style) {
    final open = text.indexOf('`'), close = text.lastIndexOf('`');
    if (open < 0 || close == open) return TextSpan(text: text);
    return TextSpan(
      children: [
        TextSpan(text: text.substring(0, open)),
        TextSpan(
          text: text.substring(open + 1, close),
          style: style.copyWith(fontFamily: grid.AppType.monoFamily),
        ),
        TextSpan(text: text.substring(close + 1)),
      ],
    );
  }
}
