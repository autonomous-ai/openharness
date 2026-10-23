import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_diff_rows.dart';
import 'package:harness/finder/finder_models.dart';

/// A 20-line file whose 10th line changed, as a whole-file diff reads.
List<DiffLine> _diff() => [
  const DiffLine(DiffLineKind.meta, 'diff --git a/f b/f'),
  const DiffLine(DiffLineKind.hunk, '@@ -1,20 +1,20 @@'),
  for (var i = 1; i < 10; i++)
    DiffLine(DiffLineKind.context, 'line $i', oldLine: i, newLine: i),
  const DiffLine(DiffLineKind.removed, 'old 10', oldLine: 10),
  const DiffLine(DiffLineKind.added, 'new 10', newLine: 10),
  const DiffLine(DiffLineKind.added, 'new 11', newLine: 11),
  for (var i = 11; i <= 20; i++)
    DiffLine(DiffLineKind.context, 'line $i', oldLine: i, newLine: i + 1),
];

void main() {
  test('inline rows drop headers and fold unchanged runs to 3 lines', () {
    final rows = inlineDiffRows(_diff(), const {});
    expect(rows.first, isA<DiffFoldRow>());
    expect((rows.first as DiffFoldRow).count, 6);
    expect(rows.whereType<DiffFoldRow>().map((f) => f.count), [6, 7]);
    // 3 context, the change (3 lines), 3 context, around the two folds.
    expect(rows, hasLength(2 + 3 + 3 + 3));
    expect(diffChangeStarts(rows), [4]);
  });

  test('a fold opens by its key', () {
    final folded = inlineDiffRows(_diff(), const {});
    final key = (folded.first as DiffFoldRow).key;
    final opened = inlineDiffRows(_diff(), {key});
    expect(opened.first, isA<DiffSingleRow>());
    expect(opened.whereType<DiffFoldRow>(), hasLength(1));
  });

  test('side by side pairs a removal with the addition that replaced it', () {
    final rows = sideBySideDiffRows(_diff(), const {});
    final pairs = rows.whereType<DiffPairRow>().where(
      (r) => r.left?.kind != DiffLineKind.context,
    );
    expect(pairs.map((r) => (r.left?.text, r.right?.text)), [
      ('old 10', 'new 10'),
      (null, 'new 11'),
    ]);
    expect(diffChangeStarts(rows), hasLength(1));
  });
}
