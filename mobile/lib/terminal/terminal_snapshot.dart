import 'package:xterm/xterm.dart';

/// Rebase the few locations a reader is using when an authoritative screen
/// replaces a buffer. Matching neighbors distinguish repeated log lines.
/// Only requested rows retain text; the replacement is scanned once.
Map<int, int> remapTerminalRows(
  Buffer before,
  Buffer after,
  Iterable<int> rows,
) {
  final wanted = rows
      .where((row) => row >= 0 && row < before.lines.length)
      .toSet();
  if (wanted.isEmpty || after.lines.length == 0) return {};
  String? text(Buffer buffer, int row) => row >= 0 && row < buffer.lines.length
      ? buffer.lines[row].getText()
      : null;
  final context = {
    for (final row in wanted)
      row: (text(before, row - 1), text(before, row), text(before, row + 1)),
  };
  final byText = <String, List<int>>{};
  for (final row in wanted) {
    (byText[context[row]!.$2!] ??= []).add(row);
  }
  final matches = <int, ({int row, int score})>{};
  String? previous;
  var current = text(after, 0);
  for (var row = 0; row < after.lines.length; row++) {
    final next = text(after, row + 1);
    for (final old in byText[current] ?? const <int>[]) {
      final neighbors = context[old]!;
      final score =
          (neighbors.$1 == previous ? 1 : 0) + (neighbors.$3 == next ? 1 : 0);
      final best = matches[old];
      if (best == null ||
          score > best.score ||
          (score == best.score && (row - old).abs() < (best.row - old).abs())) {
        matches[old] = (row: row, score: score);
      }
    }
    previous = current;
    current = next;
  }
  return {for (final entry in matches.entries) entry.key: entry.value.row};
}
