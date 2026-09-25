import 'package:flutter/services.dart';

import 'package:harness_mobile/clipboard/native_clipboard.dart';
import 'package:harness_mobile/state/app_state.dart' show MachineState;
import 'package:harness_mobile/terminal/image_transcode.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

/// Said when the terminal the paste was meant for is no longer the one to send it to.
const pasteChangedMessage =
    'The terminal changed before the paste, so nothing was sent.';

/// Pastes the phone's clipboard into [session]: its text as one paste rather than as typing, or,
/// when there is no text, its image, the same upload the key bar's image button makes.
///
/// The Paste row of the terminal's actions sheet (`phone/terminal_page.dart`). iOS has no other way
/// in: long-press on the terminal is selection there, and the soft keyboard has no paste key.
///
/// Text is asked about first with [Clipboard.hasStrings], which iOS answers without its "Allow
/// Paste" prompt, so the person is asked once, for the one thing actually read. Unlike the
/// desktop's ⌘V there is no Ctrl+V fallthrough: the agent runs on another machine, whose engine
/// would read THAT machine's clipboard rather than this phone's.
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

  try {
    if (await Clipboard.hasStrings()) {
      final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
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
      return;
    }
  } on PlatformException {
    report('Could not read the clipboard.');
    return;
  }

  // A plain shell, not an agent: the CLI delivers an image by replaying Ctrl+V, which a shell reads
  // as quoted-insert. The desktop skips image paste there for the same reason.
  if (session.engineId == 'terminal') {
    report('There is no text on the clipboard.');
    return;
  }
  final imageBytes = await NativeClipboard.readImagePng();
  if (imageBytes == null) {
    report('There is nothing on the clipboard to paste.');
    return;
  }
  // Empty is the native side saying an image IS there but could not be read, see
  // [NativeClipboard.readImagePng].
  if (imageBytes.isEmpty) {
    report("The clipboard's image isn't one this phone can read.");
    return;
  }
  if (machine == null || !machine.terminalImagePasteAvailable) {
    report("This machine's harness is too old to receive images.");
    return;
  }
  // Through the same transcode as a picked photo: a clipboard image is as often a full-size camera
  // shot as a screenshot, and it has to be scaled under the upload's ceiling either way.
  switch (await transcodeToPng(imageBytes)) {
    case ImageTranscodeUnreadable():
      report("The clipboard's image isn't one this phone can read.");
    case ImageTranscodeTooLarge():
      report('That image is too large to send, even scaled down.');
    case ImageTranscodeOk(:final pngBytes):
      if (!stillOwnsPaste()) {
        report(pasteChangedMessage);
        return;
      }
      if (!await session.pasteImage(pngBytes)) {
        report('The image could not be sent.');
      }
  }
}
