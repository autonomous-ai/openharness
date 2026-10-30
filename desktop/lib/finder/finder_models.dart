import 'dart:typed_data';

/// One row of a folder listing in a Finder tile.
class FinderEntry {
  const FinderEntry({
    required this.name,
    required this.path,
    required this.isDirectory,
  });

  final String name;

  /// Absolute, on the tile's machine.
  final String path;
  final bool isDirectory;
}

/// A file's size and modification time: enough to tell a later read apart
/// from the one an editor holds, and to recognise the tile's own save.
class DiskStamp {
  const DiskStamp(this.modified, this.size);
  final DateTime modified;
  final int size;

  @override
  bool operator ==(Object other) =>
      other is DiskStamp && other.modified == modified && other.size == size;

  @override
  int get hashCode => Object.hash(modified, size);
}

/// A file as an editor tab reads it. Sealed, so the tab answers every shape.
sealed class FinderContent {
  const FinderContent();
}

class FinderText extends FinderContent {
  const FinderText(this.text, this.stamp);
  final String text;
  final DiskStamp stamp;
}

class FinderImage extends FinderContent {
  const FinderImage(this.bytes, {this.svg = false});
  final Uint8List bytes;
  final bool svg;
}

/// A file the tile cannot draw — a binary, or one too large to edit here —
/// said with why, so the tab can offer the system's own app instead.
class FinderBinary extends FinderContent {
  const FinderBinary(this.reason);
  final String reason;
}

/// How one path differs from what Git last recorded.
enum GitChangeKind {
  modified,
  added,
  deleted,
  renamed,
  copied,
  typeChanged,
  untracked,
  conflicted,
}

/// Which list a change belongs to — the sections of the Changes view, in the
/// order they are shown: conflicts first, because nothing commits past them.
enum GitArea { conflict, unstaged, staged, untracked }

/// One row of `git status`: a path, and which side of the index it is on.
///
/// A file edited after it was staged is TWO rows (`MM`), one staged and one
/// not, because those are two different diffs.
class GitChange {
  const GitChange({
    required this.path,
    required this.kind,
    required this.area,
    this.originalPath,
    this.added,
    this.removed,
  });

  /// Relative to the repository root, as Git spells it (forward slashes).
  final String path;
  final GitChangeKind kind;
  final GitArea area;

  /// A rename's or copy's source, relative to the repository root.
  final String? originalPath;

  /// Lines added and removed, from `git diff --numstat`; null for a binary
  /// or before the count is read.
  final int? added, removed;

  bool get staged => area == GitArea.staged;

  GitChange withCounts(int? added, int? removed) => GitChange(
    path: path,
    kind: kind,
    area: area,
    originalPath: originalPath,
    added: added,
    removed: removed,
  );

  /// The same change whatever its line counts: a selection survives them.
  @override
  bool operator ==(Object other) =>
      other is GitChange &&
      other.path == path &&
      other.kind == kind &&
      other.area == area &&
      other.originalPath == originalPath;

  @override
  int get hashCode => Object.hash(path, kind, area, originalPath);
}

/// A folder's repository as the Changes view reads it.
class GitChanges {
  const GitChanges({
    required this.root,
    required this.changes,
    this.branch,
    this.ahead = 0,
    this.behind = 0,
  });

  /// The repository's top folder: every [GitChange.path] is relative to it.
  final String root;
  final String? branch;
  final int ahead, behind;
  final List<GitChange> changes;
}

enum DiffLineKind { meta, hunk, context, added, removed }

/// One line of a unified diff, numbered on the side(s) it exists on.
class DiffLine {
  const DiffLine(this.kind, this.text, {this.oldLine, this.newLine});
  final DiffLineKind kind;
  final String text;
  final int? oldLine, newLine;
}
