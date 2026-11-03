import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import 'controller.dart';
import 'message_row.dart';
import 'model.dart';
import 'switch_pm.dart';

/// A Lead's typing into a worker's terminal, or a worker's machine telling its
/// Lead it waits at a prompt or hit a usage limit
/// (spec/2026-10-23-lead-sees-agent-terminal.md), or two projects' tasks that
/// own the same code (spec 2026-10-23-leads-see-and-talk.md). The backend writes what
/// happened as one sentence; it is a note in the group, not chat from the
/// agent, so it has no author heading, reply or receipt.
class SuperTabTerminalRow extends StatelessWidget {
  const SuperTabTerminalRow({
    super.key,
    required this.message,
    required this.controller,
  });
  final SuperTabMessage message;
  final SuperTabController controller;

  /// Switch PM… on the Product Manager's own limit note, for whoever may switch
  /// it, while its machine still alerts about the limit (as a prompt note
  /// stops saying anything once answered, prompt_alerts.dart).
  bool get _canSwitch {
    final id = message.leadLimitAgentId, snapshot = controller.snapshot;
    final lead = id == null ? null : snapshot?.agent(id);
    final project = id == null ? null : snapshot?.leadProjectForAgent(id);
    return lead != null &&
        project != null &&
        controller.canWrite &&
        lead.alerting.contains('limit') &&
        lead.switchRequest == null &&
        snapshot!.maySwitchLead(project.id, controller.accountId);
  }

  Widget _action(BuildContext context, String label, VoidCallback onPressed) =>
      TextButton(
        onPressed: onPressed,
        style:
            TextButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.onSurfaceVariant,
              backgroundColor: Colors.transparent,
              side: BorderSide.none,
              // A phone's action is a finger's size.
              minimumSize: workspaceIsCompact(context)
                  ? const Size.square(kFingerTarget)
                  : const Size(0, 28),
              padding: const EdgeInsets.symmetric(
                horizontal: grid.AppDesktop.controlGap,
                vertical: grid.AppDesktop.menuInset,
              ),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              textStyle: DesktopChrome.metadata(),
            ).copyWith(
              side: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.focused)
                    ? TextButtonTheme.of(context).style?.side?.resolve(states)
                    : BorderSide.none,
              ),
            ),
        child: Text(label),
      );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final alert = message.source['kind'] != 'terminal-input';
    final style = DesktopChrome.metadata(
      color: Theme.of(context).colorScheme.onSurfaceVariant,
    );
    // The backend names the time in UTC; the reader reads their own.
    final until = message.leadLimitAgentId == null
        ? null
        : DateTime.tryParse(message.source['limitedUntil'] as String? ?? '');
    final project = message.leadLimitAgentId == null
        ? null
        : controller.snapshot?.leadProjectForAgent(message.leadLimitAgentId!);
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
          Expanded(
            child: Wrap(
              spacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text.rich(_typed(message.text, style), style: style),
                if (until != null)
                  Text('until ${switchPmTime(context, until)}', style: style),
                if (project != null && _canSwitch)
                  _action(
                    context,
                    'Switch PM…',
                    () => showSwitchPm(context, controller, project.id),
                  ),
              ],
            ),
          ),
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
