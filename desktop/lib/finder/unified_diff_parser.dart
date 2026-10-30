import 'finder_models.dart';

final _hunkHeader = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@');

/// Splits `git diff` output into lines numbered on the side(s) each exists on.
///
/// Everything before the first hunk — `diff --git`, `index`, `---`/`+++` — is
/// [DiffLineKind.meta], so a `+++ b/file` header is never read as an addition.
List<DiffLine> parseUnifiedDiff(String diff) {
  final lines = <DiffLine>[];
  int? oldLine, newLine;
  for (final raw in diff.split('\n')) {
    final hunk = _hunkHeader.firstMatch(raw);
    if (hunk != null) {
      oldLine = int.parse(hunk.group(1)!);
      newLine = int.parse(hunk.group(2)!);
      lines.add(DiffLine(DiffLineKind.hunk, raw));
      continue;
    }
    if (raw.startsWith('diff --git ')) {
      oldLine = newLine = null;
    }
    if (oldLine == null || newLine == null) {
      if (raw.isNotEmpty) lines.add(DiffLine(DiffLineKind.meta, raw));
      continue;
    }
    if (raw.startsWith('+')) {
      lines.add(
        DiffLine(DiffLineKind.added, raw.substring(1), newLine: newLine++),
      );
    } else if (raw.startsWith('-')) {
      lines.add(
        DiffLine(DiffLineKind.removed, raw.substring(1), oldLine: oldLine++),
      );
    } else if (raw.startsWith(r'\')) {
      // "\ No newline at end of file" belongs to the line before it.
      lines.add(DiffLine(DiffLineKind.meta, raw));
    } else if (raw.isNotEmpty) {
      // Git prefixes even an empty context line with a space, so a bare
      // empty line is only the output's own final newline.
      lines.add(
        DiffLine(
          DiffLineKind.context,
          raw.substring(1),
          oldLine: oldLine++,
          newLine: newLine++,
        ),
      );
    }
  }
  return lines;
}
