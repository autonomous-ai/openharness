import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_models.dart';
import 'package:harness/finder/git_numstat_parser.dart';
import 'package:harness/finder/git_status_parser.dart';
import 'package:harness/finder/unified_diff_parser.dart';

void main() {
  group('parseGitStatus', () {
    test('reads the branch line with its distance from upstream', () {
      final parsed = parseGitStatus(
        '## main...origin/main [ahead 2, behind 1]\u0000',
      );
      expect(parsed.branch, 'main');
      expect(parsed.ahead, 2);
      expect(parsed.behind, 1);
      expect(parsed.changes, isEmpty);
    });

    test('names the branch of a repository with no commits, and none when detached', () {
      expect(
        parseGitStatus('## No commits yet on trunk\u0000').branch,
        'trunk',
      );
      expect(parseGitStatus('## HEAD (no branch)\u0000').branch, isNull);
    });

    test('splits a file staged and edited again into two changes', () {
      final parsed = parseGitStatus('## main\u0000MM lib/a.dart\u0000');
      expect(parsed.changes, const [
        GitChange(
          path: 'lib/a.dart',
          kind: GitChangeKind.modified,
          area: GitArea.staged,
        ),
        GitChange(
          path: 'lib/a.dart',
          kind: GitChangeKind.modified,
          area: GitArea.unstaged,
        ),
      ]);
    });

    test(
      'takes a rename source from the next record and keeps paths verbatim',
      () {
        final parsed = parseGitStatus(
          'R  new name.md\u0000old name.md\u0000?? notes/ý tưởng.txt\u0000 D gone.txt\u0000',
        );
        expect(parsed.changes, const [
          GitChange(
            path: 'new name.md',
            kind: GitChangeKind.renamed,
            area: GitArea.staged,
            originalPath: 'old name.md',
          ),
          GitChange(
            path: 'notes/ý tưởng.txt',
            kind: GitChangeKind.untracked,
            area: GitArea.untracked,
          ),
          GitChange(
            path: 'gone.txt',
            kind: GitChangeKind.deleted,
            area: GitArea.unstaged,
          ),
        ]);
      },
    );

    test('reads a merge conflict as one conflicted change', () {
      expect(parseGitStatus('UU lib/a.dart\u0000').changes, const [
        GitChange(
          path: 'lib/a.dart',
          kind: GitChangeKind.conflicted,
          area: GitArea.conflict,
        ),
      ]);
    });
  });

  group('parseUnifiedDiff', () {
    test('numbers each line on the side it exists on', () {
      final lines = parseUnifiedDiff('''diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -3,3 +3,3 @@ intro
 keep
-old
+new
 
''');
      expect(lines.map((l) => l.kind), [
        DiffLineKind.meta,
        DiffLineKind.meta,
        DiffLineKind.meta,
        DiffLineKind.meta,
        DiffLineKind.hunk,
        DiffLineKind.context,
        DiffLineKind.removed,
        DiffLineKind.added,
        DiffLineKind.context,
      ]);
      expect((lines[5].oldLine, lines[5].newLine), (3, 3));
      expect(
        (lines[6].text, lines[6].oldLine, lines[6].newLine),
        ('old', 4, null),
      );
      expect(
        (lines[7].text, lines[7].oldLine, lines[7].newLine),
        ('new', null, 4),
      );
      expect((lines[8].text, lines[8].oldLine, lines[8].newLine), ('', 5, 5));
    });

    test('never reads the +++ header as an added line', () {
      final lines = parseUnifiedDiff(
        '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n',
      );
      expect(
        lines.where((l) => l.kind == DiffLineKind.added).single.text,
        'hello',
      );
    });
  });

  test('parseGitNumstat counts lines, files a rename under its new path', () {
    expect(
      parseGitNumstat(
        '3\t1\tlib/a.dart\u0000-\t-\tlogo.png\u00002\t0\t\u0000old.md\u0000new.md\u0000',
      ),
      {'lib/a.dart': (3, 1), 'logo.png': (null, null), 'new.md': (2, 0)},
    );
  });
}
