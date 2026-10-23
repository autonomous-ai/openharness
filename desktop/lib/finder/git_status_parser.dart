import 'finder_models.dart';

/// The branch line `git status --branch` leads with, and the changes after it.
typedef ParsedGitStatus = ({
  String? branch,
  int ahead,
  int behind,
  List<GitChange> changes,
});

const _conflicts = {'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'};

/// Reads `git status --porcelain=v1 -z --branch` output.
///
/// `-z` keeps every path verbatim — no quoting of spaces or non-ASCII — and
/// puts a rename's source in the NEXT record rather than after an arrow, so
/// this never has to unescape anything.
ParsedGitStatus parseGitStatus(String output) {
  final records = output.split('\u0000');
  String? branch;
  var ahead = 0, behind = 0;
  final changes = <GitChange>[];
  for (var i = 0; i < records.length; i++) {
    final record = records[i];
    if (record.startsWith('## ')) {
      (branch, ahead, behind) = _parseBranch(record.substring(3));
      continue;
    }
    if (record.length < 4) continue;
    final x = record[0], y = record[1];
    final path = record.substring(3);
    final code = '$x$y';
    if (code == '??') {
      changes.add(
        GitChange(
          path: path,
          kind: GitChangeKind.untracked,
          area: GitArea.untracked,
        ),
      );
      continue;
    }
    if (code == '!!') continue;
    if (_conflicts.contains(code)) {
      changes.add(
        GitChange(
          path: path,
          kind: GitChangeKind.conflicted,
          area: GitArea.conflict,
        ),
      );
      continue;
    }
    final moved = x == 'R' || x == 'C';
    final original = moved && i + 1 < records.length ? records[++i] : null;
    if (x != ' ') {
      changes.add(
        GitChange(
          path: path,
          kind: _kindOf(x),
          area: GitArea.staged,
          originalPath: original,
        ),
      );
    }
    if (y != ' ') {
      changes.add(
        GitChange(path: path, kind: _kindOf(y), area: GitArea.unstaged),
      );
    }
  }
  return (branch: branch, ahead: ahead, behind: behind, changes: changes);
}

GitChangeKind _kindOf(String code) => switch (code) {
  'A' => GitChangeKind.added,
  'D' => GitChangeKind.deleted,
  'R' => GitChangeKind.renamed,
  'C' => GitChangeKind.copied,
  'T' => GitChangeKind.typeChanged,
  _ => GitChangeKind.modified,
};

/// `main...origin/main [ahead 1, behind 2]`, `No commits yet on main`, or
/// `HEAD (no branch)` for a detached checkout.
(String?, int, int) _parseBranch(String line) {
  final bracket = RegExp(r' \[(.*)\]$').firstMatch(line);
  final head = bracket == null ? line : line.substring(0, bracket.start);
  int count(String word) =>
      int.tryParse(
        RegExp('$word (\\d+)').firstMatch(bracket?.group(1) ?? '')?.group(1) ??
            '',
      ) ??
      0;
  final local = head.split('...').first;
  final branch = switch (local) {
    _ when local.startsWith('No commits yet on ') => local.substring(18),
    _ when local.startsWith('Initial commit on ') => local.substring(18),
    'HEAD (no branch)' => null,
    _ => local,
  };
  return (branch, count('ahead'), count('behind'));
}
