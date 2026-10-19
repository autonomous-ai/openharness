import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/terminal/terminal_binary.dart'
    show terminalLocalPasteFileMaxPayloadBytes;
import 'package:harness_mobile/terminal/terminal_session.dart';

/// Opens the system's document picker for one file — Files on iOS, the Storage Access Framework on
/// Android. Null is the person backing out. Replaced in tests, where there is no picker to open.
@visibleForTesting
Future<XFile?> Function() pickTerminalFile = () => openFile();

/// Said when the terminal the file was meant for is no longer the one to send it to.
const fileSendChangedMessage =
    'The terminal changed before the file was sent, so nothing was sent.';

/// Sends a file the person picks to [session] — the key bar's "Choose a file", the phone's half of
/// dropping a file on a desktop pane. The machine writes the bytes to disk there and pastes that
/// path into the prompt (`pasteFile` in the CLI's terminalStreamManager.ts), so the agent can
/// read a PDF, a log or a zip it could not otherwise reach.
///
/// The caller checks `MachineState.terminalPasteFileAvailable` first: a CLI that never advertised
/// it does not know the upload kind, and the bytes would go nowhere.
///
/// Every outcome worth telling the person about goes to [report]; backing out of the picker says
/// nothing. A file that cannot go is said in the desktop's words for a dropped one: it could not
/// be read, or it is larger than 20 MB.
///
/// ⚠️ **The file lands only in the stream it was picked for.** The picker can stay open for as long
/// as the person likes, and in that time the page can have been swiped away or its stream taken
/// over or reconnected. Nothing is sent unless [stillShowing] holds, the session still accepts
/// input and its stream id is the one it had when the key was tapped — otherwise [report] hears
/// [fileSendChangedMessage].
Future<void> sendFileToTerminal({
  required TerminalSession session,
  required bool Function() stillShowing,
  required void Function(String message) report,
}) async {
  final streamId = session.streamId;
  bool stillOwnsSend() =>
      stillShowing() && session.acceptsInput && session.streamId == streamId;

  final XFile? picked;
  try {
    picked = await pickTerminalFile();
  } on PlatformException {
    report('Could not open the picker.');
    return;
  }
  if (picked == null) return;
  final name = picked.name;
  // Measured before it is read: a file past the limit is refused without holding all of it.
  try {
    if (await picked.length() > terminalLocalPasteFileMaxPayloadBytes) {
      report(
        '$name is larger than ${_mb(terminalLocalPasteFileMaxPayloadBytes)}',
      );
      return;
    }
  } catch (_) {
    // No size to read is no reason to refuse yet: the read below says whether the file is there.
  }
  final Uint8List bytes;
  try {
    bytes = await picked.readAsBytes();
  } catch (_) {
    report('Could not read $name');
    return;
  }
  if (bytes.length > terminalLocalPasteFileMaxPayloadBytes) {
    report(
      '$name is larger than ${_mb(terminalLocalPasteFileMaxPayloadBytes)}',
    );
    return;
  }
  if (bytes.isEmpty) {
    report('$name is empty.');
    return;
  }
  if (!stillOwnsSend()) {
    report(fileSendChangedMessage);
    return;
  }
  if (!await session.pasteFile(name.isEmpty ? 'file' : name, bytes)) {
    report('The file could not be sent.');
  }
}

/// The desktop's `_mb`: a byte limit in whole megabytes.
String _mb(int bytes) => '${bytes ~/ (1024 * 1024)} MB';
