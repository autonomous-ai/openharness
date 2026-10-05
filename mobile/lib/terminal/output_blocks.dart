import 'dart:math';

import 'package:xterm/xterm.dart';

/// One message an agent's TUI drew — Claude Code's `⏺` block, Codex's `•` — as absolute buffer
/// rows, [first] and [last] inclusive. [first] is the row with the mark; trailing blank rows are
/// left out.
typedef OutputBlock = ({int first, int last});

/// What a message starts with, in column 0: Claude Code's `⏺` (`●` where it draws for Linux and
/// Windows) and Codex's `•`. Everything else a message holds is indented under it — `⎿` and `└`
/// results, wrapped lines, lists — so the next line with anything in column 0 (another mark, the
/// person's `>`/`❯`/`›`, the input box's rule, a spinner) is where the message ends.
const _marks = {0x23FA, 0x25CF, 0x2022};

/// How far up a long press looks for the mark of the message it landed in.
const _maxBlockRows = 2000;

/// How close to the right edge a message has to reach before any of its line breaks is read as
/// the TUI's own wrap rather than the agent's. A message that never comes near the edge was
/// never wrapped, and its line breaks are all kept.
const _nearEdge = 8;

/// A line that never continues the one above it, however long that one is: a list item, a
/// result, a table or box row.
final _ownLine = RegExp(r'^(?:[-*•◦▪‣]\s|[☐☒□✔✓⎿└│├┌╭┃▎]|\d+[.)]\s)');

/// A list item's marker, which its wrapped lines are indented past.
final _listMarker = RegExp(r'^(?:[-*•◦▪‣☐☒□✔✓]|\d+[.)])\s+');

/// A message's first line when it is a tool the agent ran rather than something it said:
/// Claude Code's `Bash(npm test)`, an MCP tool's `(MCP)`, its todo list, a collapsed group's
/// `(ctrl+o to expand)`; Codex's plan, its edits, its status line.
final _toolHead = RegExp(
  r'^(?:[A-Z][A-Za-z]*\(|Update Todos$|Updated Plan$|Explored$|Edited .*\(\+\d+ -\d+\)$|Working \()'
  r'|\(MCP\)|ctrl\+[a-z] to (?:expand|interrupt)|esc to interrupt',
);

/// The message buffer row [row] is in, or null when it is in none — the person's prompt, the
/// input box, a plain shell, the blank rows after a message.
///
/// A long press uses it to select a whole message rather than the word under the finger.
OutputBlock? outputBlockAt(Buffer buffer, int row) {
  final lines = buffer.lines;
  if (row < 0 || row >= lines.length) return null;
  var first = row;
  while (true) {
    final line = lines[first];
    if (!line.isWrapped) {
      final lead = _lead(line);
      if (_marks.contains(lead)) break;
      if (!_isBlank(lead)) return null;
    }
    if (first == 0 || row - first >= _maxBlockRows) return null;
    first--;
  }
  final block = _blockFrom(buffer, first);
  return row <= block.last ? block : null;
}

/// The last thing the agent SAID in [buffer]: the newest message that is not a tool it ran, or
/// null when there is none — a fresh session, a shell, a reply already scrolled out of the
/// history.
OutputBlock? lastReplyBlock(Buffer buffer) {
  final lines = buffer.lines;
  for (var row = lines.length - 1; row >= 0; row--) {
    final line = lines[row];
    if (line.isWrapped || !_marks.contains(_lead(line))) continue;
    final block = _blockFrom(buffer, row);
    if (_isReply(buffer, block)) return block;
  }
  return null;
}

/// [block] as a selection: from its mark to the end of its last line's text.
BufferRangeLine outputBlockRange(Buffer buffer, OutputBlock block) =>
    BufferRangeLine(
      CellOffset(0, block.first),
      CellOffset(buffer.lines[block.last].getTrimmedLength(), block.last),
    );

/// [block]'s text as the agent wrote it, for the clipboard.
///
/// Without its mark, and without the two columns the TUI indents the rest of a message by. The
/// lines the TUI broke only to fit the terminal are joined back up: a phone pane is about forty
/// columns wide, so a reply copied as drawn would paste as a column of short lines anywhere else.
///
/// ⚠️ **Those breaks are hard newlines in the buffer, not soft wraps.** Both TUIs lay their text
/// out themselves and write each row on its own, so xterm's `isWrapped` never marks them. A break
/// is read as the TUI's when the line before it comes near the message's right edge and the next
/// line's first word could not have fitted after it — the test a wrapping TUI applies. List
/// items, results and box rows always keep their own line, as does anything indented
/// differently from the paragraph above it.
String outputBlockText(Buffer buffer, OutputBlock block) {
  final rows = <_Row>[];
  for (var i = block.first; i <= block.last; i++) {
    final line = buffer.lines[i];
    final text = line.getText();
    final end = line.getTrimmedLength();
    if (line.isWrapped && rows.isNotEmpty) {
      final previous = rows.removeLast();
      rows.add((
        text: '${previous.text}$text',
        indent: previous.indent,
        end: end,
        word: previous.word,
      ));
      continue;
    }
    final body = i == block.first ? _withoutMark(text) : _withoutHang(text);
    rows.add((
      text: body,
      indent: body.length - body.trimLeft().length,
      end: end,
      word: _firstWordCells(line),
    ));
  }

  final widest = rows.fold(0, (widest, row) => max(widest, row.end));
  final limit = widest >= buffer.viewWidth - _nearEdge ? widest : 0;
  final out = StringBuffer();
  var paragraphIndent = 0;
  for (var k = 0; k < rows.length; k++) {
    final row = rows[k];
    final text = row.text.trimRight();
    final content = text.trimLeft();
    if (k > 0 &&
        limit > 0 &&
        content.isNotEmpty &&
        rows[k - 1].text.trim().isNotEmpty &&
        row.indent == paragraphIndent &&
        !_ownLine.hasMatch(content) &&
        rows[k - 1].end + 1 + row.word > limit) {
      out
        ..write(' ')
        ..write(content);
      continue;
    }
    if (k > 0) out.write('\n');
    out.write(text);
    paragraphIndent =
        row.indent + (_listMarker.firstMatch(content)?.group(0)?.length ?? 0);
  }
  return out.toString().trimRight();
}

/// One row of a message as [outputBlockText] reads it: its text without the mark or the hang,
/// how far that text is indented, and, in cells as the buffer holds them, where the row ends and
/// how long its first word is.
typedef _Row = ({String text, int indent, int end, int word});

/// What a row holds in column 0; 0 for a row with nothing in it.
int _lead(BufferLine line) => line.length == 0 ? 0 : line.getCodePoint(0);

/// An empty cell, or one a space was written into.
bool _isBlank(int codePoint) => codePoint == 0 || codePoint == 0x20;

/// The message whose mark is on row [first], to its last row with text before the next line
/// with anything in column 0.
OutputBlock _blockFrom(Buffer buffer, int first) {
  final lines = buffer.lines;
  var last = first;
  for (var i = first + 1; i < lines.length; i++) {
    final line = lines[i];
    if (!line.isWrapped && !_isBlank(_lead(line))) break;
    if (line.getTrimmedLength() > 0 && line.getText().trim().isNotEmpty) {
      last = i;
    }
  }
  return (first: first, last: last);
}

/// Whether [block] is something the agent said, rather than a tool it ran: a tool's head line
/// names it, and a tool's result hangs under it on a `⎿` (Claude Code) or `└` (Codex).
bool _isReply(Buffer buffer, OutputBlock block) {
  final head = _withoutMark(buffer.lines[block.first].getText()).trim();
  if (head.isEmpty || _toolHead.hasMatch(head)) return false;
  for (var i = block.first + 1; i <= block.last; i++) {
    final text = buffer.lines[i].getText().trimLeft();
    if (text.startsWith('⎿') || text.startsWith('└')) return false;
  }
  return true;
}

/// A message's first row without its mark and the space after it. Every mark in [_marks] is one
/// UTF-16 unit, and a wide one's second cell writes nothing into [BufferLine.getText].
String _withoutMark(String text) {
  if (text.isEmpty) return text;
  final rest = text.substring(1);
  return rest.startsWith(' ') ? rest.substring(1) : rest;
}

/// A message's later row without the two columns the TUI hangs it under the mark by.
String _withoutHang(String text) {
  var hang = 0;
  while (hang < 2 && hang < text.length && text.codeUnitAt(hang) == 0x20) {
    hang++;
  }
  return text.substring(hang);
}

/// How many cells the first word on [line] takes — wide characters as two.
int _firstWordCells(BufferLine line) {
  final length = line.getTrimmedLength();
  var i = 0;
  while (i < length && _isBlank(line.getCodePoint(i))) {
    i++;
  }
  final start = i;
  while (i < length && !_isBlank(line.getCodePoint(i))) {
    i += max(1, line.getWidth(i));
  }
  return i - start;
}
