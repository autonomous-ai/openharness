import 'dart:math';

import 'package:xterm/xterm.dart';

/// How far up from the cursor a prompt's own text can reach. A sentence
/// dictated into the prompt wraps, and its first line is as much the prompt as
/// the line the cursor ended on.
const _maxPromptRows = 6;

/// The rows at the foot of the screen that count whatever the cursor says.
const _footRows = 3;

/// A line a TUI draws around its input rather than a line anybody typed.
final _rule = RegExp(r'^[─━═╭╮╰╯┌┐└┘\-]+$');

/// Whether a tap on buffer row [row] is aimed at the program's prompt — on a
/// phone, the one tap that should raise the keyboard. A tap anywhere else on the
/// terminal is somebody reading.
///
/// **The cursor says where the prompt is.** Both agent TUIs park the REAL
/// terminal cursor on their input line — Codex on `› `, Claude Code on `❯ ` —
/// as measured in live tmux panes (`#{cursor_y}` against `capture-pane`), and
/// Claude Code keeps it there while it is hidden, on the trust dialog's
/// selection for one. So the prompt is the block of text the cursor sits in,
/// walked up to its first line, and everything under it: the footer, the mode
/// line, the empty screen below a session that has barely started.
///
/// One row of slack above that, because a terminal row is ~16pt and a thumb is
/// not.
///
/// ⚠️ The bottom [_footRows] rows always count. Every agent TUI keeps its input
/// at the foot of the screen, and a program that leaves its cursor on the last
/// row — under its input rather than on it — must not leave the keyboard, which
/// on the phone only a tap raises, out of reach.
///
/// [row] is an absolute buffer row, scrollback included: what
/// `RenderTerminal.getCellOffset` reports. A tap on history scrolled far above
/// the prompt is therefore never a prompt tap.
bool isPromptTap(Buffer buffer, int row) {
  final top = _promptTop(buffer, buffer.absoluteCursorY) - 1;
  return row >= min(top, buffer.height - _footRows);
}

int _promptTop(Buffer buffer, int cursorRow) {
  var top = cursorRow;
  while (top > 0 &&
      cursorRow - top < _maxPromptRows - 1 &&
      _isTyped(buffer.lines[top]) &&
      _isTyped(buffer.lines[top - 1])) {
    top--;
  }
  return top;
}

bool _isTyped(BufferLine line) {
  final text = line.getText().trim();
  return text.isNotEmpty && !_rule.hasMatch(text);
}

/// How many rows a prompt's typed text can run to — a long paste included.
const _maxInputRows = 200;

/// What an agent's prompt starts with, in column 0 or just inside a box's side: Claude Code's `❯`
/// (`>` in older builds), its `!` shell mode and `#` memory mode, and Codex's `›`. A shell themed
/// with a `❯` prompt reads the same way, and rightly: what follows it is what was typed.
const _promptGlyphs = {0x276F, 0x3E, 0x21, 0x23, 0x203A};

/// The side of the box older Claude Code draws its prompt inside: `│ > text │`.
const _boxSide = 0x2502;

/// An open question's answer, which the cursor sits on too: `❯ 1. Yes`. Not a prompt.
final _answerRow = RegExp(r'^\d+[.)]\s');

/// Where the text typed into the program's prompt is — from just past `❯ ` to its last character —
/// or null when nothing is typed there: an empty prompt, one showing only its grey placeholder, an
/// open question, or a prompt this cannot read (a plain shell's `%`, which cannot be told apart from
/// what was typed after it).
///
/// Found from the cursor, as [isPromptTap] finds the prompt: walked up to the row with the prompt's
/// glyph, then down through the rows the text wrapped onto, to the box's rule or a blank row.
BufferRangeLine? promptInputRange(Buffer buffer) {
  final lines = buffer.lines;
  final cursorRow = buffer.absoluteCursorY;
  if (cursorRow < 0 || cursorRow >= lines.length) return null;
  int? top;
  int? glyph;
  for (
    var row = cursorRow;
    row >= 0 && cursorRow - row < _maxInputRows;
    row--
  ) {
    final line = lines[row];
    if (!_isTyped(line)) return null;
    glyph = _promptGlyphColumn(line);
    if (glyph != null) {
      top = row;
      break;
    }
  }
  if (top == null || glyph == null) return null;
  if (_answerRow.hasMatch(lines[top].getText(glyph + 1).trimLeft())) {
    return null;
  }
  var last = top;
  for (
    var row = top + 1;
    row < lines.length && row - top < _maxInputRows;
    row++
  ) {
    final line = lines[row];
    if (!_isTyped(line) || _promptGlyphColumn(line) != null) break;
    last = row;
  }
  final start = CellOffset(glyph + 2, top);
  final end = CellOffset(_textEnd(lines[last]), last);
  if (!start.isBefore(end)) return null;
  final range = BufferRangeLine(start, end);
  return _isPlaceholder(buffer, range) ? null : range;
}

/// How many screen rows the prompt the cursor is in can take, at most: from its first row — the
/// one with the prompt's glyph, or the one under the rule a TUI draws over its input — to the foot
/// of the screen. The whole screen when neither is above the cursor.
///
/// ⚠️ **An overcount, by design.** It counts the footer under the prompt too, and a row the prompt
/// is not on. Its one use is how many times to kill a line ([TerminalSession.clearPrompt]), and a
/// kill too many does nothing, where one too few leaves text behind.
int promptRowsBound(Buffer buffer) {
  final lines = buffer.lines;
  final screenTop = max(0, buffer.height - buffer.viewHeight);
  var top = screenTop;
  for (
    var row = min(buffer.absoluteCursorY, buffer.height - 1);
    row >= screenTop;
    row--
  ) {
    final line = lines[row];
    if (_promptGlyphColumn(line) != null) {
      top = row;
      break;
    }
    if (_isRuleRow(line)) {
      top = row + 1;
      break;
    }
  }
  return max(1, buffer.height - top);
}

/// A rule a TUI draws across the screen, from column 0 — not a line of dashes typed into the
/// prompt, which is indented under its glyph.
bool _isRuleRow(BufferLine line) {
  if (line.length == 0) return false;
  final lead = line.getCodePoint(0);
  if (lead == 0 || lead == 0x20) return false;
  return _rule.hasMatch(line.getText().trim());
}

/// The column of [line]'s prompt glyph — 0, or 2 inside a box's side — or null when the line does
/// not start a prompt. Always followed by a blank, which is what keeps a `#` or `>` the person
/// typed at the start of a wrapped row from reading as a new prompt: those rows are indented.
int? _promptGlyphColumn(BufferLine line) {
  int at(int column) => column < line.length ? line.getCodePoint(column) : 0;
  bool blank(int column) => at(column) == 0 || at(column) == 0x20;
  if (_promptGlyphs.contains(at(0)) && blank(1)) return 0;
  if (at(0) == _boxSide &&
      blank(1) &&
      _promptGlyphs.contains(at(2)) &&
      blank(3)) {
    return 2;
  }
  return null;
}

/// Where [line]'s text ends, short of a box's closing side and the padding before it.
int _textEnd(BufferLine line) {
  var end = line.getTrimmedLength();
  if (end > 0 && line.getCodePoint(end - 1) == _boxSide) {
    end--;
    while (end > 0 &&
        (line.getCodePoint(end - 1) == 0 ||
            line.getCodePoint(end - 1) == 0x20)) {
      end--;
    }
  }
  return end;
}

/// Whether [range] holds the prompt's placeholder rather than anything typed: faint text, as both
/// TUIs draw it (`Try "fix lint errors"`), all of it but the cell the TUI's own cursor is drawn on.
bool _isPlaceholder(Buffer buffer, BufferRangeLine range) {
  var cells = 0;
  var faint = 0;
  for (final segment in range.toSegments()) {
    final line = buffer.lines[segment.line];
    final from = segment.start ?? 0;
    final to = (segment.end ?? line.length).clamp(0, line.length);
    for (var x = from; x < to; x++) {
      final codePoint = line.getCodePoint(x);
      if (codePoint == 0 || codePoint == 0x20) continue;
      cells++;
      if (line.getAttributes(x) & CellFlags.faint != 0) faint++;
    }
  }
  return faint > 0 && faint >= cells - 1;
}
