import 'finder_files.dart';
import 'finder_load.dart';
import 'finder_models.dart';

/// One visible row of the tree: an entry and how deep it sits.
class FinderTreeRow {
  const FinderTreeRow(
    this.entry,
    this.depth, {
    required this.expanded,
    this.listing,
  });
  final FinderEntry entry;
  final int depth;
  final bool expanded;

  /// An open folder's own read, so the row can say it is still listing or
  /// could not be listed — its children are not there to say it.
  final FinderLoad<List<FinderEntry>>? listing;
}

/// A folder tree read lazily: a folder is listed the first time it opens, and
/// the listing is kept while it is closed so reopening it is instant.
class FinderTree {
  FinderTree(this.root, this._files, this._changed);

  final String root;
  final FinderFiles _files;
  final void Function() _changed;
  final Map<String, FinderLoad<List<FinderEntry>>> _listings = {};
  final Set<String> _expanded = {};

  /// Called with each folder's entries once they are listed — where the
  /// ignored-file marks are asked for.
  void Function(List<FinderEntry> entries)? onListed;

  FinderLoad<List<FinderEntry>> listingOf(String folder) =>
      _listings[folder] ?? const FinderLoading();

  bool isExpanded(String folder) => _expanded.contains(folder);

  /// Reads the root, and every open folder again.
  Future<void> reload() => refresh({root, ..._expanded});

  /// Reads [folders] again — those already listed; a folder never opened is
  /// read when it is.
  Future<void> refresh(Set<String> folders) => Future.wait([
    for (final folder in folders)
      if (folder == root || _listings.containsKey(folder)) _list(folder),
  ]);

  Future<void> toggle(String folder) async {
    if (_expanded.remove(folder)) return _changed();
    await expand(folder);
  }

  Future<void> expand(String folder) async {
    _expanded.add(folder);
    _changed();
    if (_listings[folder] is! FinderLoaded) await _list(folder);
  }

  void collapseAll() {
    _expanded.clear();
    _changed();
  }

  /// The tree as it reads top to bottom: every entry under an open folder.
  List<FinderTreeRow> get rows {
    final rows = <FinderTreeRow>[];
    void walk(String folder, int depth) {
      final listing = _listings[folder];
      if (listing is! FinderLoaded<List<FinderEntry>>) return;
      for (final entry in listing.value) {
        final open = entry.isDirectory && _expanded.contains(entry.path);
        rows.add(
          FinderTreeRow(
            entry,
            depth,
            expanded: open,
            listing: open ? listingOf(entry.path) : null,
          ),
        );
        if (open) walk(entry.path, depth + 1);
      }
    }

    walk(root, 0);
    return rows;
  }

  Future<void> _list(String folder) async {
    // A refresh keeps the rows on screen until the new ones arrive.
    if (_listings[folder] is! FinderLoaded) {
      _listings[folder] = const FinderLoading();
    }
    try {
      final entries = await _files.list(folder);
      _listings[folder] = FinderLoaded(entries);
      onListed?.call(entries);
    } on FinderException catch (error) {
      _listings[folder] = FinderFailed(error.message);
    }
    _changed();
  }
}
