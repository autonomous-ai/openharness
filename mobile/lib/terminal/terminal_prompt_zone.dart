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
