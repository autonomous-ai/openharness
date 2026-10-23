import 'finder_models.dart';

/// A text file larger than this opens as "too large" rather than in the
/// editor; the system's app is offered instead.
const kFinderEditLimit = 10 * 1024 * 1024;

/// An image larger than this is opened in the system's viewer instead.
const kFinderImageLimit = 50 * 1024 * 1024;

/// A listing stops here; a folder this size is not read by scrolling a tree.
const kFinderListLimit = 5000;

/// Entries a tree never shows, as Orca hides them: Git's store, the package
/// cache nobody browses, and macOS's litter.
const kFinderHiddenNames = {'.git', 'node_modules', '.DS_Store'};

/// A read or write that failed, worded for the person reading the tile.
class FinderException implements Exception {
  const FinderException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Where a Finder tile reads and writes its machine's files.
///
/// One seam so the tile does not care where the folder is: this computer's
/// disk today ([LocalFinderFiles]).
// TODO(BE): a remote machine needs daemon requests for these — `fs_list_dir`
// lists folders only and `agent_read_file` serves media from an agent's own
// project — before the Finder can open there.
abstract interface class FinderFiles {
  /// One level of [directory], folders first, each group by name.
  Future<List<FinderEntry>> list(String directory);

  /// The file at [path] as an editor tab shows it.
  Future<FinderContent> read(String path);

  /// When the file at [path] last changed, or null when it is gone.
  Future<DiskStamp?> stamp(String path);

  /// Replaces the file at [path] with [text]; answers its new stamp.
  Future<DiskStamp> write(String path, String text);

  Future<void> createFile(String path);
  Future<void> createFolder(String path);
  Future<void> rename(String from, String to);

  /// Moves [path] to the Trash, so a delete can be taken back.
  Future<void> trash(String path);

  /// Hands [path] to the system's own app for its kind.
  Future<bool> open(String path);

  /// Shows [path] in the system's file manager.
  Future<bool> reveal(String path);

  /// The paths under [root] that changed, a batch at a time.
  Stream<Set<String>> watch(String root);
}
