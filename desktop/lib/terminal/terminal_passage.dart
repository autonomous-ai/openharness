import 'dart:convert';
import 'dart:math' as math;

import 'package:xterm/xterm.dart';

/// A local reading cursor. It never sends keys, scroll reports or terminal input.
/// Anchors follow retained scrollback; changed text invalidates the selection
/// instead of silently making "this" refer to a different passage.
class TerminalPassage {
  static const maxRows = 16;
  static const maxBytes = 4096;

  TerminalPassage(this.terminal, int row, {int? lastRow})
    : _buffer = terminal.buffer {
    final start = row.clamp(0, _buffer.lines.length - 1);
    _anchor = _buffer.createAnchor(0, start);
    _end = _buffer.createAnchor(
      0,
      (lastRow ?? start).clamp(start, _buffer.lines.length - 1),
    );
    if (rows > maxRows) {
      error = 'Choose a shorter passage.';
    } else {
      _remember();
    }
  }

  final Terminal terminal;
  final Buffer _buffer;
  late CellAnchor _anchor, _end;
  String _text = '';
  String? error;
  bool extending = false;
  bool pinned = false;
  bool _disposed = false;
  int? _pinnedRows;

  BufferRangeLine get range {
    final first = math.min(_anchor.y, _end.y);
    final last = math.max(_anchor.y, _end.y);
    return BufferRangeLine(
      CellOffset(0, first),
      CellOffset(_buffer.lines[last].length, last),
    );
  }

  int get rows => _pinnedRows ?? (_anchor.y - _end.y).abs() + 1;
  String get text => _text;

  bool get canHighlight =>
      !_disposed &&
      identical(terminal.buffer, _buffer) &&
      _anchor.attached &&
      _end.attached &&
      (_anchor.y - _end.y).abs() < maxRows &&
      _buffer.getText(range).trimRight() == _text;

  bool validate() {
    if (_disposed || error != null) return false;
    if (pinned) return true; // immutable snapshot, captured before the mic turn
    if (!canHighlight) {
      error = 'That text changed. Choose it again.';
      return false;
    }
    return true;
  }

  void _remember() {
    _text = _buffer.getText(range).trimRight();
    if (utf8.encode(_text).length > maxBytes) {
      error = 'Choose a shorter passage.';
    }
  }

  bool step(int delta) {
    if (!validate() || pinned || delta == 0) return false;
    final next = (_end.y + delta.clamp(-8, 8))
        .clamp(
          extending ? math.max(0, _anchor.y - maxRows + 1) : 0,
          extending
              ? math.min(_buffer.lines.length - 1, _anchor.y + maxRows - 1)
              : _buffer.lines.length - 1,
        )
        .toInt();
    _end.dispose();
    _end = _buffer.createAnchor(0, next);
    if (!extending) {
      _anchor.dispose();
      _anchor = _buffer.createAnchor(0, next);
    }
    _remember();
    return error == null;
  }

  bool setExtending(bool value) {
    if (!validate() || pinned) return false;
    if (!value) {
      _anchor.dispose();
      _anchor = _buffer.createAnchor(0, _end.y);
    }
    extending = value;
    _remember();
    return error == null;
  }

  String? pin() {
    if (!validate()) return null;
    if (_text.trim().isEmpty) {
      error = 'Choose a line with text.';
      return null;
    }
    _pinnedRows = rows;
    pinned = true;
    return _text;
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _anchor.dispose();
    _end.dispose();
  }
}
