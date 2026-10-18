import 'dart:math' as math;

import 'package:xterm/xterm.dart';

/// What a terminal showed — its visible screen as the escape sequences that redraw it — kept so the
/// next time its agent opens in this run, that screen is up at once while the live stream attaches
/// (`AppNotifier._attachSession`, [TerminalSession.seedSnapshot]). In memory only — see
/// `KeptScreenStore`.
///
/// ⚠️ **The visible screen only, never the scrollback.** What it is for is the first frame of an
/// open: a page that shows the reader's last view of the agent instead of a skeleton until the
/// machine's keyframe lands, which then replaces it whole. Scrollback would multiply what is kept —
/// fifty of these — for nothing that first frame shows.
class ScreenSnapshot {
  const ScreenSnapshot({
    required this.cols,
    required this.rows,
    required this.ansi,
    required this.savedAt,
  });

  final int cols;
  final int rows;

  /// The screen, as cursor moves, SGR runs and text — what a fresh terminal of [cols]×[rows] draws
  /// back into the same screen.
  final String ansi;
  final DateTime savedAt;

  /// The largest screen worth keeping. A terminal past this is not one a phone drew.
  static const maxCols = 512;
  static const maxRows = 256;

  /// A screen whose redraw runs past this is dropped rather than kept: dense colour on a large
  /// screen, and the store is meant to be small.
  static const maxAnsiChars = 96 * 1024;

  /// [terminal]'s visible screen, or null when there is nothing worth keeping — an empty screen, an
  /// impossible size, or a redraw past [maxAnsiChars].
  ///
  /// Row by row, each placed with its own cursor move rather than joined by newlines, so a full
  /// row never wraps into the next and a blank one costs nothing. Trailing blank cells are left
  /// out; every change of colour or attribute is a full SGR reset-and-set, which is longer than a
  /// diff but cannot carry an attribute over by mistake.
  static ScreenSnapshot? capture(Terminal terminal, {DateTime? now}) {
    final cols = terminal.viewWidth;
    final rows = terminal.viewHeight;
    if (cols < 1 || rows < 1 || cols > maxCols || rows > maxRows) return null;
    final buffer = terminal.buffer;
    final top = math.max(0, buffer.height - rows);
    final out = StringBuffer();
    var drewAnything = false;
    for (var row = 0; row < rows; row++) {
      final index = top + row;
      if (index >= buffer.height) break;
      final line = buffer.lines[index];
      var end = math.min(line.length, cols);
      while (end > 0 && _isBlank(line, end - 1)) {
        end--;
      }
      if (end == 0) continue;
      drewAnything = true;
      out.write('\x1b[${row + 1};1H');
      int? foreground;
      int? background;
      int? attributes;
      var afterWide = false;
      for (var col = 0; col < end; col++) {
        final codePoint = line.getCodePoint(col);
        // The cell a wide character's second half occupies: the redraw writes that character and
        // the terminal fills this cell itself.
        if (afterWide && codePoint == 0) {
          afterWide = false;
          continue;
        }
        afterWide = line.getWidth(col) == 2;
        final cellForeground = line.getForeground(col);
        final cellBackground = line.getBackground(col);
        final cellAttributes = line.getAttributes(col);
        if (cellForeground != foreground ||
            cellBackground != background ||
            cellAttributes != attributes) {
          out.write(_sgr(cellForeground, cellBackground, cellAttributes));
          foreground = cellForeground;
          background = cellBackground;
          attributes = cellAttributes;
        }
        out.writeCharCode(codePoint == 0 ? 0x20 : codePoint);
      }
      out.write('\x1b[0m');
      if (out.length > maxAnsiChars) return null;
    }
    if (!drewAnything) return null;
    final cursorRow = (buffer.cursorY + 1).clamp(1, rows);
    final cursorCol = (buffer.cursorX + 1).clamp(1, cols);
    out.write('\x1b[$cursorRow;${cursorCol}H');
    if (out.length > maxAnsiChars) return null;
    return ScreenSnapshot(
      cols: cols,
      rows: rows,
      ansi: out.toString(),
      savedAt: now ?? DateTime.now(),
    );
  }

  /// Whether the cell at [index] draws nothing: no character, the default background, and no
  /// attribute that marks an empty cell (an inverse block, an underline).
  static bool _isBlank(BufferLine line, int index) {
    final codePoint = line.getCodePoint(index);
    if (codePoint != 0 && codePoint != 0x20) return false;
    if (line.getBackground(index) & CellColor.typeMask != CellColor.normal) {
      return false;
    }
    const visibleWhenEmpty =
        CellAttr.inverse | CellAttr.underline | CellAttr.strikethrough;
    return line.getAttributes(index) & visibleWhenEmpty == 0;
  }

  /// A full reset followed by [attributes], [foreground] and [background] — see [capture].
  static String _sgr(int foreground, int background, int attributes) {
    final codes = <Object>[0];
    if (attributes & CellAttr.bold != 0) codes.add(1);
    if (attributes & CellAttr.faint != 0) codes.add(2);
    if (attributes & CellAttr.italic != 0) codes.add(3);
    if (attributes & CellAttr.underline != 0) codes.add(4);
    if (attributes & CellAttr.blink != 0) codes.add(5);
    if (attributes & CellAttr.inverse != 0) codes.add(7);
    if (attributes & CellAttr.invisible != 0) codes.add(8);
    if (attributes & CellAttr.strikethrough != 0) codes.add(9);
    _color(codes, foreground, base: 30, bright: 90, extended: 38);
    _color(codes, background, base: 40, bright: 100, extended: 48);
    return '\x1b[${codes.join(';')}m';
  }

  /// [color] as SGR parameters — a named colour as 30–37/90–97 (or 40–47/100–107), a palette
  /// index as `38;5;n`, a true colour as `38;2;r;g;b`, and the default as nothing (the reset before
  /// it already put it back).
  static void _color(
    List<Object> codes,
    int color, {
    required int base,
    required int bright,
    required int extended,
  }) {
    final value = color & CellColor.valueMask;
    switch (color & CellColor.typeMask) {
      case CellColor.named:
        codes.add(value < 8 ? base + value : bright + (value - 8));
      case CellColor.palette:
        codes.addAll([extended, 5, value]);
      case CellColor.rgb:
        codes.addAll([
          extended,
          2,
          (value >> 16) & 0xff,
          (value >> 8) & 0xff,
          value & 0xff,
        ]);
      default:
        break;
    }
  }
}
