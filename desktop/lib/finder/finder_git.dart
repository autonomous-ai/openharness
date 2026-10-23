import 'finder_models.dart';

/// Where a Finder tile reads and changes its folder's Git state.
///
/// Every call runs `git` itself, like Orca's main process does — porcelain
/// output, no prompts, bounded — never a library's idea of the repository.
abstract interface class FinderGit {
  /// The repository [folder] is in, with what changed under it, or null when
  /// it is in none.
  Future<GitChanges?> changes(String folder);

  /// The paths of the [entries] Git ignores.
  Future<Set<String>> ignored(GitChanges repository, List<FinderEntry> entries);

  /// How [change] differs, with the whole file as context.
  Future<List<DiffLine>> diff(GitChanges repository, GitChange change);

  Future<void> stage(GitChanges repository, List<GitChange> changes);
  Future<void> unstage(GitChanges repository, List<GitChange> changes);

  /// Puts tracked files back as the index has them. Untracked files are not
  /// Git's to discard; the tile moves those to the Trash.
  Future<void> discard(GitChanges repository, List<GitChange> changes);
}
