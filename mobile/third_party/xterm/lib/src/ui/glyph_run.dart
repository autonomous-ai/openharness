import 'package:xterm/src/core/buffer/cell_flags.dart';
import 'package:xterm/src/core/cell.dart';

/// AUTONOMOUS PATCH: a run of cells `TerminalPainter.paintLine` lays out and
/// draws as ONE paragraph — printable ASCII in one style, and the blanks
/// between — where every cell used to be a paragraph of its own.
///
/// ⚠️ **ASCII only, and that is what keeps a run on the grid.** In a monospace
/// face every ASCII glyph advances by exactly the width the cell is measured
/// from (`'m'`, `TerminalPainter._measureCharSize`), so the n-th character of a
/// run lands on the n-th cell. A character from a fallback font, an emoji or a
/// CJK glyph advances by its own width, and in a run would push the rest of the
/// line off the grid — so those are drawn a cell at a time, as before.
///
/// Blanks never end a run: a space has no ink whatever its colour (its fill is
/// the background pass's), so it rides along as a space. Underlined cells are
/// never part of one — an underline is ink, and a run's own would stop short of
/// a trailing space.
class GlyphRun {
  final _text = StringBuffer();

  /// The run's first cell; -1 while no run is open.
  int start = -1;

  /// One past the last cell with ink. Blanks after it are not drawn.
  int _inkEnd = -1;

  /// The first cell's content, and the style every character in the run shares.
  int content = 0;
  int foreground = 0;
  int background = 0;
  int flags = 0;

  bool get isOpen => start >= 0;

  /// Cells from the first character to the last, the blanks between included.
  int get length => _inkEnd - start;

  /// What is drawn: one character per cell, from the first to the last ink.
  String get text => _text.toString().substring(0, length);

  /// Whether [cell] can be in a run at all: printable ASCII or blank, and not
  /// underlined. Only such a cell is handed to [add] or [open].
  static bool takes(CellData cell) {
    if (cell.flags & CellFlags.underline != 0) return false;
    final code = cell.content & CellContent.codepointMask;
    return code == 0 || (code >= 0x20 && code < 0x7F);
  }

  /// Adds [cell], at [index], when it fits: a blank fits any run (and opens
  /// none), a character fits the open run when it shares its style. False when
  /// it does not — a character in another style, or no run open — and the
  /// caller draws what is open and [open]s a new run with it.
  bool add(int index, CellData cell) {
    final code = cell.content & CellContent.codepointMask;
    if (code == 0 || code == 0x20) {
      if (isOpen) _text.writeCharCode(0x20);
      return true;
    }
    if (!isOpen ||
        cell.foreground != foreground ||
        cell.background != background ||
        cell.flags != flags) {
      return false;
    }
    _text.writeCharCode(code);
    _inkEnd = index + 1;
    return true;
  }

  /// Starts a new run with the character [cell], at [index].
  void open(int index, CellData cell) {
    close();
    start = index;
    _inkEnd = index + 1;
    content = cell.content;
    foreground = cell.foreground;
    background = cell.background;
    flags = cell.flags;
    _text.writeCharCode(cell.content & CellContent.codepointMask);
  }

  void close() {
    _text.clear();
    start = -1;
    _inkEnd = -1;
  }
}
