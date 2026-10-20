import 'package:path/path.dart' as p;

import '../core/git_worktree.dart' show insideGitCheckout, runLocalGit;
import 'finder_files.dart' show FinderException;
import 'finder_git.dart';
import 'finder_models.dart';
import 'git_numstat_parser.dart';
import 'git_status_parser.dart';
import 'unified_diff_parser.dart';

/// Context wide enough that a diff carries the whole file: the view folds
/// the unchanged runs itself, and can unfold them without asking git again.
const _wholeFile = '--unified=1000000';

/// [FinderGit] over this computer's `git`.
class LocalFinderGit implements FinderGit {
  const LocalFinderGit();

  @override
  Future<GitChanges?> changes(String folder) async {
    if (!await insideGitCheckout(folder)) return null;
    final top = await _git(folder, ['rev-parse', '--show-toplevel']);
    if (top.code != 0) return null;
    final root = top.output.trim();
    final (status, unstagedCounts, stagedCounts) = await (
      _git(folder, [
        '-c', 'core.quotePath=false', //
        'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all',
        '--', '.',
      ]),
      _git(root, ['diff', '--numstat', '-z', '-M']),
      _git(root, ['diff', '--cached', '--numstat', '-z', '-M']),
    ).wait;
    if (status.code != 0) {
      throw const FinderException('Git couldn’t read this folder’s changes.');
    }
    final parsed = parseGitStatus(status.output);
    final unstaged = parseGitNumstat(unstagedCounts.output);
    final staged = parseGitNumstat(stagedCounts.output);
    return GitChanges(
      root: root,
      branch: parsed.branch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      changes: [
        for (final change in parsed.changes)
          switch ((change.staged ? staged : unstaged)[change.path]) {
            (final added, final removed) => change.withCounts(added, removed),
            null => change,
          },
      ],
    );
  }

  @override
  Future<Set<String>> ignored(
    GitChanges repository,
    List<FinderEntry> entries,
  ) async {
    if (entries.isEmpty) return const {};
    // A folder is asked with its trailing slash: `build/` in .gitignore
    // matches only folders, and git does not look at the disk to tell.
    String asked(FinderEntry entry) =>
        entry.isDirectory ? '${entry.path}/' : entry.path;
    // One path a line: `-z` is for `--stdin` only, and quotePath off keeps
    // non-ASCII names as they are.
    final result = await _git(repository.root, [
      '-c',
      'core.quotePath=false',
      'check-ignore',
      '--',
      ...entries.map(asked),
    ]);
    // 1 is "none of them": an answer, not a failure.
    if (result.code != 0) return const {};
    final ignored = result.output.split('\n').toSet();
    return {
      for (final entry in entries)
        if (ignored.contains(asked(entry))) entry.path,
    };
  }

  @override
  Future<List<DiffLine>> diff(GitChanges repository, GitChange change) async {
    final untracked = change.area == GitArea.untracked;
    final result = await _git(repository.root, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      _wholeFile,
      if (change.staged) ...['--cached', '-M'],
      if (untracked) '--no-index',
      '--',
      if (untracked) '/dev/null',
      change.path,
      ?change.originalPath,
    ], timeout: const Duration(seconds: 10));
    // `--no-index` answers 1 when the files differ, which is always here.
    if (result.code != 0 && !(untracked && result.code == 1)) {
      throw const FinderException('Git couldn’t show this change.');
    }
    return parseUnifiedDiff(result.output);
  }

  @override
  Future<void> stage(GitChanges repository, List<GitChange> changes) =>
      _mutate(repository, ['add', '-A', '--'], _paths(changes), 'stage');

  @override
  Future<void> unstage(GitChanges repository, List<GitChange> changes) =>
      _mutate(repository, ['reset', '-q', '--'], _paths(changes), 'unstage');

  @override
  Future<void> discard(GitChanges repository, List<GitChange> changes) =>
      _mutate(
        repository,
        ['restore', '--worktree', '--'],
        [for (final change in changes) change.path],
        'discard',
      );

  Future<void> _mutate(
    GitChanges repository,
    List<String> command,
    List<String> paths,
    String verb,
  ) async {
    if (paths.isEmpty) return;
    final result = await _git(repository.root, [...command, ...paths]);
    if (result.code != 0) {
      throw FinderException('Git couldn’t $verb ${_count(paths)}.');
    }
  }
}

/// A rename is two paths to Git: both have to move together.
List<String> _paths(List<GitChange> changes) => [
  for (final change in changes) ...[change.path, ?change.originalPath],
];

String _count(List<String> paths) => paths.length == 1
    ? p.posix.basename(paths.single)
    : '${paths.length} files';

Future<({int code, String output, String errorOutput})> _git(
  String folder,
  List<String> arguments, {
  Duration timeout = const Duration(seconds: 6),
}) async {
  try {
    return await runLocalGit(folder, arguments, timeout: timeout);
  } on Exception {
    // Overflow, a deadline or no git at all: never git's own words, which can
    // carry repository contents.
    throw const FinderException(
      'Git didn’t answer in time, or the change is too large to show.',
    );
  }
}
