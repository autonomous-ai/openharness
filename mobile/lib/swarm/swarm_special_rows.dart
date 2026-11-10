import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_message_row.dart' show SwarmMessageFrame, swarmChatText;
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_switch_pm.dart';

// The notes in a chat that are not chat from their author, drawn as Desktop
// draws them: a note about a terminal (terminal_row.dart), and a Buddy's proposal as one line that opens its
// thread (task_line.dart). Each has no author heading, reply or receipt.

/// The reader of the Swarm whose chat [conversationId] is; null until one is
/// read (as the ship card finds its people).
SwarmReader? swarmReaderOf(BuildContext context, String conversationId) {
  final inbox = SwarmScope.of(context)?.inbox;
  if (inbox == null) return null;
  for (final swarm in inbox.swarms) {
    final reader = inbox.reader(swarm.id);
    if (reader?.snapshot?.conversation(conversationId) != null) return reader;
  }
  return null;
}

TextStyle _quiet() => swarmChatText(14, color: AppPalette.textSecondary);

/// A note's place: under a message's text, past the avatar's column.
const EdgeInsets _inset = EdgeInsets.fromLTRB(
  AppSpace.s + SwarmMessageFrame.column,
  AppSpace.xs,
  AppSpace.s,
  AppSpace.xs,
);

/// A quiet action beside a note, a finger's size.
class _NoteAction extends StatelessWidget {
  const _NoteAction({super.key, required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
          child: Center(
            widthFactor: 1,
            child: Text(
              label,
              style: swarmChatText(14, color: AppPalette.accentOnSurface),
            ),
          ),
        ),
      ),
    ),
  );
}

/// A Lead's typing into a worker's terminal, or a machine's alert about one
/// (Desktop's `SuperTabTerminalRow`). A Product Manager's usage-limit note
/// offers Switch PM… as Desktop's does ([swarmLimitNoteSwitchPm]), following
/// the Swarm as it is read again.
class SwarmTerminalRow extends StatelessWidget {
  const SwarmTerminalRow({super.key, required this.message});
  final SuperTabMessage message;

  /// The backend wraps what was typed in one pair of backticks, and the text
  /// inside is as typed, backticks included: the first and the last are the
  /// wrapper, and what lies between is shown whole, in the terminal's face.
  static TextSpan typed(String text, TextStyle style) {
    final open = text.indexOf('`'), close = text.lastIndexOf('`');
    if (open < 0 || close == open) return TextSpan(text: text);
    return TextSpan(
      children: [
        TextSpan(text: text.substring(0, open)),
        TextSpan(
          text: text.substring(open + 1, close),
          style: style.copyWith(fontFamily: AppFont.mono),
        ),
        TextSpan(text: text.substring(close + 1)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // A row kept as it was is not built again: the PM's limit note follows
    // the Swarm itself, as the ship card does.
    final inbox = message.leadLimitAgentId == null
        ? null
        : SwarmScope.of(context)?.inbox;
    if (inbox == null) return _row(null);
    return ListenableBuilder(
      listenable: inbox,
      builder: (context, _) {
        final reader = swarmReaderOf(context, message.conversationId);
        final projectId = reader == null
            ? null
            : swarmLimitNoteSwitchPm(reader, message);
        return _row(
          projectId == null
              ? null
              : _NoteAction(
                  key: const ValueKey('swarm-limit-switch-pm'),
                  label: 'Switch PM…',
                  onTap: () => unawaited(
                    showSwarmSwitchPm(context, reader!, projectId),
                  ),
                ),
        );
      },
    );
  }

  Widget _row(Widget? action) {
    final alert = message.source['kind'] != 'terminal-input';
    final style = _quiet();
    // Only the coordinator's: a worker's note says its time in its own words.
    final until = message.leadLimitAgentId != null
        ? DateTime.tryParse(message.source['limitedUntil'] as String? ?? '')
        : null;
    final text = Text.rich(
      TextSpan(
        children: [
          typed(message.text, style),
          if (until != null)
            TextSpan(text: ' until ${swarmSwitchPmTime(until)}'),
        ],
      ),
      style: style,
    );
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpace.s,
        _inset.top,
        _inset.right,
        _inset.bottom,
      ),
      child: Row(
        // Beside an action a finger's size, the mark and the words sit on
        // its middle.
        crossAxisAlignment: action == null
            ? CrossAxisAlignment.start
            : CrossAxisAlignment.center,
        children: [
          SizedBox(
            width: SwarmMessageFrame.column,
            child: Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.only(right: AppSpace.s),
                child: Icon(
                  alert
                      ? LucideIcons.triangleAlert300
                      : LucideIcons.keyboard300,
                  size: 15,
                  color: alert ? AppPalette.warn : style.color,
                ),
              ),
            ),
          ),
          Expanded(
            child: action == null
                ? text
                : Row(children: [Flexible(child: text), action]),
          ),
        ],
      ),
    );
  }
}

/// The quiet line a terminal's answer starts with, and the one under a
/// response that was cut short (Desktop's view.dart).
Widget? swarmTerminalNote(SuperTabMessage message) =>
    switch (message.terminalNote) {
      final note? => Padding(
        padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
        child: Text(note, style: _quiet()),
      ),
      null => null,
    };

Widget? swarmCutShort(SuperTabMessage message) {
  final words = message.source['truncated'] == true
      ? 'Excerpt · open the terminal for the full response'
      : message.source['interrupted'] == true
      ? 'Response interrupted'
      : null;
  return words == null
      ? null
      : Padding(
          padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
          child: Text(words, style: _quiet()),
        );
}
