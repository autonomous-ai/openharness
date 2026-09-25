import 'package:flutter/services.dart';

import 'package:harness_mobile/state/app_state.dart' show MachineState;
import 'package:harness_mobile/terminal/terminal_session.dart';

/// Said when the terminal the paste was meant for is no longer the one to send it to.
const pasteChangedMessage =
    'The terminal changed before the paste, so nothing was sent.';

/// Pastes the phone's clipboard text into [session], as one paste rather than as typing.
///
/// The Paste row of the terminal's actions sheet (`phone/terminal_page.dart`). iOS has no other way
/// in: long-press on the terminal is selection there, and the soft keyboard has no paste key.
///
/// Text is asked about first with [Clipboard.hasStrings], which iOS answers without its "Allow
/// Paste" prompt, so an empty clipboard never asks. Unlike the desktop's ⌘V there is no Ctrl+V
/// fallthrough: the agent runs on another machine, whose engine would read THAT machine's
/// clipboard rather than this phone's.
///
/// [machine] is the session's machine, read for what its CLI can take at the moment of sending.
/// Every outcome worth telling the person about goes to [report]; a refused prompt says nothing.
///
/// ⚠️ **The paste lands only in the stream Paste was tapped on.** Reading the clipboard crosses a
/// platform boundary and can wait on the system's permission prompt, and in that time the page can
/// have been swiped away, its pane replaced, or its stream reconnected or taken over. Nothing is
/// sent unless [stillShowing] holds (the page is still mounted and active, and its pane's session,
/// looked up afresh, is still [session]), the session still accepts input, and its stream id is
/// the one it had when Paste was tapped. Otherwise [report] hears [pasteChangedMessage].
Future<void> pasteClipboard({
  required TerminalSession session,
  required MachineState? machine,
  required bool Function() stillShowing,
  required void Function(String message) report,
}) async {
  final streamId = session.streamId;
  bool stillOwnsPaste() =>
      stillShowing() && session.acceptsInput && session.streamId == streamId;

  final String? text;
  try {
    if (!await Clipboard.hasStrings()) {
      report('There is no text on the clipboard.');
      return;
    }
    text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
  } on PlatformException {
    report('Could not read the clipboard.');
    return;
  }
  // Empty here is a refused prompt as often as an empty string: nothing to say about either.
  if (text == null || text.isEmpty) return;
  if (!stillOwnsPaste()) {
    report(pasteChangedMessage);
    return;
  }
  // The same choice the desktop's paste makes: one atomic paste frame where the machine's CLI
  // knows it, otherwise xterm's own paste (bracketed when the program asked for it).
  if (machine != null && machine.terminalPasteRawAvailable) {
    if (!await session.pasteText(text)) {
      report('The paste could not be sent.');
    }
  } else {
    session.terminal.paste(text);
  }
}
