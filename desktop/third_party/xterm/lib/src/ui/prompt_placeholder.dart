import 'package:xterm/src/core/buffer/cell_flags.dart';
import 'package:xterm/src/core/buffer/line.dart';

/// Where the dim placeholder an agent's prompt shows after the cursor ends —
/// "Ask Codex to do anything", `Try "edit <filepath> to..."` — or [from]
/// when the rest of the row is anything else.
///
/// Both agents draw it faint (SGR 2) and clear it once the first typed
/// character echoes. Until then an input-method preview painted at the
/// cursor covered only its own width and left the placeholder's tail beside
/// it ("aloCodex to do anything"). A row that is not faint throughout after
/// the cursor holds real text and is never treated as a placeholder; blanks,
/// which prompts pad their row with, count either way.
int promptPlaceholderEnd(BufferLine line, int from) {
  var end = from;
  for (var column = from; column < line.length; column++) {
    final codePoint = line.getCodePoint(column);
    if (codePoint == 0 || codePoint == 0x20) continue;
    if (line.getAttributes(column) & CellFlags.faint == 0) return from;
    end = column + 1;
  }
  return end;
}
