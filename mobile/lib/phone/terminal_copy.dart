import 'package:flutter/services.dart';

import 'package:harness_mobile/terminal/output_blocks.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

/// Whether [session]'s terminal holds a reply to copy — whether the actions sheet offers
/// Copy last reply at all.
bool hasLastReply(TerminalSession session) =>
    lastReplyBlock(session.terminal.buffer) != null;

/// Copies the agent's last reply in [session] to the phone's clipboard, as the agent wrote it —
/// the Copy last reply row of the terminal's actions sheet (`phone/terminal_page.dart`).
///
/// Read from the terminal as it stands, not from the session's events: it is the reply the person
/// is looking at, it needs no round trip to the machine, and it is there whether or not the turn
/// was summarised. See [lastReplyBlock] for what counts as a reply, and [outputBlockText] for the
/// text it copies as.
///
/// The terminal is read when the row is tapped, not when the sheet opened: a keyframe can have
/// replaced it in between, and output can have added a newer reply. Every outcome goes to
/// [report].
Future<void> copyLastReply({
  required TerminalSession session,
  required void Function(String message) report,
}) async {
  final buffer = session.terminal.buffer;
  final block = lastReplyBlock(buffer);
  final text = block == null ? '' : outputBlockText(buffer, block);
  if (text.isEmpty) {
    report('There is no reply in this terminal to copy.');
    return;
  }
  try {
    await Clipboard.setData(ClipboardData(text: text));
  } on PlatformException {
    report('Could not copy to the clipboard.');
    return;
  }
  HapticFeedback.lightImpact();
  report('Copied the last reply.');
}
