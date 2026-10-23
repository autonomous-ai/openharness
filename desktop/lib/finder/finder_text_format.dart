import 'package:re_editor/re_editor.dart';

/// How a file writes its lines, read from the file itself so a save puts
/// back what was there: its line break and its indent width. The way Monaco
/// detects them for Orca — by majority, never by a project setting.
CodeLineOptions detectTextFormat(String text) =>
    CodeLineOptions(lineBreak: _lineBreakOf(text), indentSize: _indentOf(text));

TextLineBreak _lineBreakOf(String text) {
  final crlf = '\r\n'.allMatches(text).length;
  final lf = '\n'.allMatches(text).length - crlf;
  return crlf > lf ? TextLineBreak.crlf : TextLineBreak.lf;
}

/// The most common step between the space indents of neighbouring lines,
/// 2 when nothing says otherwise. Tabs read as a step of one tab.
int _indentOf(String text) {
  final steps = <int, int>{};
  var previous = 0;
  for (final line in text.split('\n').take(2000)) {
    if (line.trim().isEmpty) continue;
    final indent = line.length - line.trimLeft().length;
    if (line.startsWith('\t')) return 4;
    final step = (indent - previous).abs();
    if (step >= 2 && step <= 8) steps[step] = (steps[step] ?? 0) + 1;
    previous = indent;
  }
  if (steps.isEmpty) return 2;
  return steps.entries.reduce((a, b) => b.value > a.value ? b : a).key;
}
