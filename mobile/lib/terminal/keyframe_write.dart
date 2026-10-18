import 'package:xterm/xterm.dart';

/// How much of a keyframe is parsed before the frame is handed back — see
/// [writeKeyframeInSlices]. A keyframe no longer than this is written in one go, at once.
const keyframeSliceChars = 16 * 1024;

/// Writes a keyframe's [text] into its [replacement] emulator, [keyframeSliceChars] at a time,
/// handing the frame back between slices. False when [stillWanted] says the stream moved on
/// meanwhile, and the rest is not written.
///
/// ⚠️ **One write froze the screen for the length of the parse.** A keyframe is the whole screen
/// and 500 lines of history (`SNAPSHOT_HISTORY_LINES` in the CLI's `tmuxStream.ts`) — tens of
/// kilobytes of styled cells, every row padded to its full width — and one arrives on every open,
/// every resize (so every keyboard raised or lowered) and every resync. Parsed in one go it held the
/// UI thread for as long as the parse took: a scroll or a swipe in progress stopped dead, then
/// jumped. Sliced, the frames keep coming while it parses.
///
/// Nothing half-parsed is ever shown: the emulator on screen is untouched until the caller swaps
/// [replacement] in, and output that arrives meanwhile waits its turn behind it on the session's
/// render queue (`TerminalSession.handleBinary`).
///
/// A slice never ends between the halves of a surrogate pair — the parser reads each write as its
/// own run of code points. A slice that ends inside an escape sequence is fine: the parser holds
/// the unfinished sequence for the next write, as it does for any packet.
Future<bool> writeKeyframeInSlices(
  Terminal replacement,
  String text, {
  required bool Function() stillWanted,
}) async {
  var start = 0;
  while (text.length - start > keyframeSliceChars) {
    var end = start + keyframeSliceChars;
    final last = text.codeUnitAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    replacement.write(text.substring(start, end));
    start = end;
    await Future<void>.delayed(Duration.zero);
    if (!stillWanted()) return false;
  }
  replacement.write(start == 0 ? text : text.substring(start));
  return true;
}
