import 'finder_models.dart';

/// Unchanged lines kept around each change; longer unchanged runs fold —
/// Monaco's "hide unchanged regions", as Orca's diff shows them.
const kDiffContext = 3;

/// One row of a diff as the view draws it.
sealed class DiffRow {
  const DiffRow();
}

/// Inline: one line, on whichever side it exists.
class DiffSingleRow extends DiffRow {
  const DiffSingleRow(this.line);
  final DiffLine line;
}

/// Side by side: the old line on the left, the new on the right; a missing
/// side is an insertion or a deletion.
class DiffPairRow extends DiffRow {
  const DiffPairRow(this.left, this.right);
  final DiffLine? left, right;
}

/// A folded run of unchanged lines; [key] unfolds it.
class DiffFoldRow extends DiffRow {
  const DiffFoldRow(this.key, this.count);
  final int key;
  final int count;
}

/// Git's file headers say what the tab already says; only the notes that
/// mean something (`Binary files differ`, `\ No newline…`) are kept.
bool _shown(DiffLine line) =>
    line.kind != DiffLineKind.hunk &&
    !(line.kind == DiffLineKind.meta &&
        RegExp(
          r'^(diff --git|index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |copy )',
        ).hasMatch(line.text));

/// The rows of [lines] read top to bottom, unchanged runs folded unless
/// their key is in [unfolded].
List<DiffRow> inlineDiffRows(List<DiffLine> lines, Set<int> unfolded) =>
    _fold(lines.where(_shown).toList(), unfolded, DiffSingleRow.new);

/// The rows of [lines] in two columns: each run of removals beside the run
/// of additions that replaced it.
List<DiffRow> sideBySideDiffRows(List<DiffLine> lines, Set<int> unfolded) {
  final shown = lines.where(_shown).toList();
  final rows = <DiffRow>[];
  for (var i = 0; i < shown.length;) {
    final line = shown[i];
    if (line.kind != DiffLineKind.removed && line.kind != DiffLineKind.added) {
      rows.add(DiffPairRow(line, line));
      i++;
      continue;
    }
    final removed = <DiffLine>[], added = <DiffLine>[];
    while (i < shown.length && shown[i].kind == DiffLineKind.removed) {
      removed.add(shown[i++]);
    }
    while (i < shown.length && shown[i].kind == DiffLineKind.added) {
      added.add(shown[i++]);
    }
    final height = removed.length > added.length
        ? removed.length
        : added.length;
    for (var j = 0; j < height; j++) {
      rows.add(
        DiffPairRow(
          j < removed.length ? removed[j] : null,
          j < added.length ? added[j] : null,
        ),
      );
    }
  }
  return _foldPairs(rows, unfolded);
}

/// Where each change starts, as row indexes — what Previous and Next change
/// move between.
List<int> diffChangeStarts(List<DiffRow> rows) {
  final starts = <int>[];
  var inChange = false;
  for (var i = 0; i < rows.length; i++) {
    final changed = _isChange(rows[i]);
    if (changed && !inChange) starts.add(i);
    inChange = changed;
  }
  return starts;
}

bool _isChange(DiffRow row) => switch (row) {
  DiffSingleRow(:final line) => _changed(line),
  DiffPairRow(:final left, :final right) => _changed(left) || _changed(right),
  DiffFoldRow() => false,
};

bool _changed(DiffLine? line) =>
    line?.kind == DiffLineKind.added || line?.kind == DiffLineKind.removed;

List<DiffRow> _fold(
  List<DiffLine> lines,
  Set<int> unfolded,
  DiffRow Function(DiffLine) row,
) => _foldRuns(
  [for (final line in lines) row(line)],
  (row) => (row as DiffSingleRow).line.kind == DiffLineKind.context,
  unfolded,
);

List<DiffRow> _foldPairs(List<DiffRow> rows, Set<int> unfolded) =>
    _foldRuns(rows, (row) {
      final pair = row as DiffPairRow;
      return identical(pair.left, pair.right) &&
          pair.left?.kind == DiffLineKind.context;
    }, unfolded);

/// Replaces the middle of every unchanged run longer than twice
/// [kDiffContext] with a fold, keyed by where the run starts.
List<DiffRow> _foldRuns(
  List<DiffRow> rows,
  bool Function(DiffRow) unchanged,
  Set<int> unfolded,
) {
  final out = <DiffRow>[];
  for (var i = 0; i < rows.length;) {
    if (!unchanged(rows[i])) {
      out.add(rows[i++]);
      continue;
    }
    var end = i;
    while (end < rows.length && unchanged(rows[end])) {
      end++;
    }
    final keepStart = i == 0 ? 0 : kDiffContext;
    final keepEnd = end == rows.length ? 0 : kDiffContext;
    final hidden = end - i - keepStart - keepEnd;
    if (hidden <= 1 || unfolded.contains(i)) {
      out.addAll(rows.sublist(i, end));
    } else {
      out
        ..addAll(rows.sublist(i, i + keepStart))
        ..add(DiffFoldRow(i, hidden))
        ..addAll(rows.sublist(end - keepEnd, end));
    }
    i = end;
  }
  return out;
}
