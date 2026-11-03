import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_message_row.dart' show swarmChatText;

/// The first of [messages] (oldest first, every one read) the person has
/// not read, for the New messages line (Desktop's `superTabFirstUnread`): in
/// the main stream — a reply only in its thread is read there — from someone
/// else, and past both [mark] and the person's own newest message in the
/// chat, since writing in a chat reads what came before it. Null when all is
/// read, for a chat never read on any device (no mark), and when the read
/// does not reach back to the mark while there are [hasOlder] messages: the
/// first unread may be among those, and the chat then opens at its foot.
String? swarmFirstUnread(
  List<SuperTabMessage> messages,
  int? mark, {
  required String accountId,
  required bool hasOlder,
}) {
  if (mark == null || mark <= 0 || messages.isEmpty) return null;
  if (hasOlder && messages.first.sequence > mark + 1) return null;
  bool own(SuperTabMessage m) => !m.fromAgent && m.authorId == accountId;
  var read = mark;
  for (final m in messages) {
    if (own(m) && m.inMainStream && m.sequence > read) read = m.sequence;
  }
  for (final m in messages) {
    if (m.sequence > read && m.inMainStream && !own(m)) return m.id;
  }
  return null;
}

/// The line above the first unread message: an accent rule and the words,
/// so colour is never the only signal.
class SwarmNewMessagesLine extends StatelessWidget {
  const SwarmNewMessagesLine({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final accent = AppPalette.accentOnSurface;
    return Semantics(
      container: true,
      label: 'New messages',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpace.screenInset,
          vertical: AppSpace.s,
        ),
        child: Row(
          children: [
            Expanded(child: Divider(height: 1, color: accent)),
            const SizedBox(width: AppSpace.s),
            Text(
              'New messages',
              style: swarmChatText(13, color: accent, weight: FontWeight.w600),
            ),
          ],
        ),
      ),
    );
  }
}
