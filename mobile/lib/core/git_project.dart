/// The Git choices a project folder offers, and what Start would do with them.
///
/// ⚠️ **This is the phone's HALF of the desktop's `core/git_worktree.dart`**, the
/// same split `core/project_folder.dart` already makes. That file carries a
/// second half built on `dart:io` — it runs `git` itself, which is right for a
/// folder on the machine the desktop is running ON. Every machine a phone talks
/// to is remote, so the machine reads its own repository (`git_project_info`,
/// served by `cli/src/lib/gitProject.ts`) and this only parses the answer and
/// works out what to ask for. Nothing here touches a filesystem or a process.
///
/// The planning rules below ([planWorktree] and its neighbours) are ported from
/// `state/new_harness.dart` unchanged, because they decide what is SENT: a
/// phone that planned differently would make a different branch from a desktop
/// asked the same question.
library;

import 'dart:math';

import 'package:path/path.dart' as p;

import 'project_folder.dart';

class GitBranch {
  const GitBranch(
    this.ref,
    this.name, {
    this.remote = false,
    this.worktree,
    this.harness = false,
  });

  final String ref, name;
  final bool remote;

  /// Harness made this branch for a worktree.
  final bool harness;

  /// Where this local branch is checked out, when it is.
  final String? worktree;
}

class GitProjectInfo {
  const GitProjectInfo({
    this.isGit = false,
    this.branch,
    this.branches = const [],
    this.error,
    this.mainFolder,
    this.mainBranch,
    this.defaultRef,
    this.root,
  });

  factory GitProjectInfo.fromJson(Map<String, dynamic> data) => GitProjectInfo(
    isGit: data['isGit'] == true,
    branch: data['branch'] as String?,
    error: data['error'] as String?,
    mainFolder: data['mainFolder'] is String && validGitPath(data['mainFolder'])
        ? data['mainFolder'] as String
        : null,
    mainBranch: data['mainBranch'] as String?,
    defaultRef: data['defaultRef'] is String && validGitRef(data['defaultRef'])
        ? data['defaultRef'] as String
        : null,
    root: data['root'] is String && validGitPath(data['root'])
        ? data['root'] as String
        : null,
    branches: [
      for (final row in (data['branches'] as List? ?? const []))
        if (row is Map && row['ref'] is String && row['name'] is String)
          GitBranch(
            row['ref'] as String,
            row['name'] as String,
            remote: row['remote'] == true,
            worktree: row['worktree'] is String
                ? row['worktree'] as String
                : null,
            harness: row['harness'] == true,
          ),
    ],
  );

  final bool isGit;
  final String? branch, error;
  final List<GitBranch> branches;

  /// Set only for a folder inside a linked worktree: the same folder in the
  /// repository's main checkout, and the branch that checkout is on.
  final String? mainFolder, mainBranch;

  /// The remote branch new work starts from by default (`origin/HEAD`), and
  /// the checkout the folder belongs to.
  final String? defaultRef, root;

  /// Whether the machine could not answer at all, as opposed to answering
  /// "not a repository". The difference decides whether the screen offers
  /// nothing or says why.
  bool get unavailable => error != null;
}

/// What Start does with a Git project in a new worktree.
enum WorktreeStart {
  /// A new branch from the chosen base.
  newBranch,

  /// An existing local branch, checked out as it is.
  existingBranch,

  /// The branch already has a worktree: the harness starts in it.
  openWorktree,

  /// The branch is the project folder's own and cannot be checked out twice.
  unavailable,
}

class WorktreePlan {
  const WorktreePlan(this.kind, this.branch, {this.base, this.worktree});

  final WorktreeStart kind;
  final String branch;

  /// What a new branch starts from; a remote branch of the same name is tracked.
  final String? base;

  /// Where an existing worktree is.
  final String? worktree;

  bool get tracks =>
      kind == WorktreeStart.newBranch &&
      base != null &&
      base!.startsWith('refs/remotes/') &&
      base!.split('/').skip(3).join('/') == branch;
}

/// The project folder's own branch, if it is on one.
String? currentBranchRef(GitProjectInfo info) =>
    info.branch != null &&
        info.branches.any((b) => b.ref == 'refs/heads/${info.branch}')
    ? 'refs/heads/${info.branch}'
    : null;

/// Worktree starts on for a Git project with a commit to start from.
bool worktreeByDefault(GitProjectInfo info) =>
    info.isGit && info.branches.any((branch) => !branch.remote);

/// Where Start begins when no branch was chosen: new work from the default
/// branch (the local one, which Start brings up to its remote), work in the
/// folder on the branch it is on.
String? defaultBranchRef(GitProjectInfo info, {required bool worktree}) {
  if (!worktree) return currentBranchRef(info);
  final remote = info.defaultRef;
  final local = remote == null
      ? null
      : 'refs/heads/${remote.split('/').skip(3).join('/')}';
  return info.branches.any((b) => b.ref == local)
      ? local
      : remote ?? currentBranchRef(info);
}

/// The branch a worktree started from [base] is on, unless [name] was typed:
/// the default or current branch gets a new [placeholder] branch; another
/// local branch is checked out as it is, or opened in its worktree; a remote
/// branch nobody has locally becomes a local branch tracking it.
WorktreePlan planWorktree(
  GitProjectInfo info, {
  required String? base,
  required String? name,
  required String placeholder,
}) {
  GitBranch? local(String branch) =>
      info.branches.where((b) => !b.remote && b.name == branch).firstOrNull;
  // The folder's own branch cannot be checked out again: typed, it is refused;
  // picked (itself or its remote), a new branch starts from what was picked.
  WorktreePlan onLocal(GitBranch branch, {required bool chosen}) =>
      branch.name == info.branch
      ? chosen
            ? WorktreePlan(WorktreeStart.unavailable, branch.name)
            : WorktreePlan(WorktreeStart.newBranch, placeholder, base: base)
      : branch.worktree != null
      ? WorktreePlan(
          WorktreeStart.openWorktree,
          branch.name,
          worktree: branch.worktree,
        )
      : WorktreePlan(WorktreeStart.existingBranch, branch.name);
  final typed = name?.trim();
  if (typed != null && typed.isNotEmpty) {
    final existing = local(typed);
    return existing == null
        ? WorktreePlan(WorktreeStart.newBranch, typed, base: base)
        : onLocal(existing, chosen: true);
  }
  final fresh = WorktreePlan(WorktreeStart.newBranch, placeholder, base: base);
  final defaultName = info.defaultRef?.split('/').skip(3).join('/');
  if (base == null ||
      base == info.defaultRef ||
      base == 'refs/heads/$defaultName') {
    return fresh;
  }
  if (base.startsWith('refs/heads/')) {
    final branch = local(base.substring('refs/heads/'.length));
    return branch == null ? fresh : onLocal(branch, chosen: false);
  }
  final short = base.split('/').skip(3).join('/');
  final branch = local(short);
  return branch != null
      ? onLocal(branch, chosen: false)
      : WorktreePlan(WorktreeStart.newBranch, short, base: base);
}

/// With Worktree off, the new branch the folder moves to: a typed name no
/// local branch has.
String? newBranchHere(GitProjectInfo info, String? name) {
  final typed = name?.trim();
  return typed == null ||
          typed.isEmpty ||
          info.branches.any((b) => !b.remote && b.name == typed)
      ? null
      : typed;
}

/// The preparation a Git project's folder gets at Start.
///
/// ⚠️ **Ported from the desktop's `state/new_harness.dart` line for line, and
/// that is the point of it.** This is the function that decides what the
/// machine is ASKED to do — make a branch, check one out, open a worktree — and
/// a phone that decided differently would answer the same question with a
/// different repository. Change it here only by changing it there too.
ProjectFolderRequest? gitFolderRequest(
  String folder,
  GitProjectInfo info, {
  required bool worktree,
  required String? branchRef,
  required String? branchName,
  required String placeholder,
}) {
  final ref = branchRef ?? defaultBranchRef(info, worktree: worktree);
  if (!worktree) {
    if (newBranchHere(info, branchName) case final name?) {
      return ProjectFolderRequest.branch(
        folder,
        'refs/heads/$name',
        newBranch: name,
      );
    }
    return ref == null ? null : ProjectFolderRequest.branch(folder, ref);
  }
  final plan = planWorktree(
    info,
    base: ref,
    name: branchName,
    placeholder: placeholder,
  );
  return switch (plan.kind) {
    WorktreeStart.openWorktree => ProjectFolderRequest.branch(
      folder,
      'refs/heads/${plan.branch}',
    ),
    WorktreeStart.existingBranch => ProjectFolderRequest.worktree(
      folder,
      branchRef: 'refs/heads/${plan.branch}',
      branchName: plan.branch,
      existingBranch: true,
    ),
    WorktreeStart.newBranch ||
    WorktreeStart.unavailable => ProjectFolderRequest.worktree(
      folder,
      branchRef: plan.base,
      branchName: plan.branch,
      placeholder: plan.branch == placeholder,
    ),
  };
}

/// Two plain words for a branch nothing has named yet — plumbing, like the
/// worktree's folder: the harness or the person names the real branch when
/// there is something to push. Mirrors cli/src/lib/agentNames.ts.
const kPlaceholderAdjectives = [
  'amber', 'bold', 'brave', 'brisk', 'calm', 'clever', 'cosmic', 'crisp', //
  'dapper', 'eager', 'fancy', 'gentle', 'glad', 'golden', 'happy', 'hidden',
  'jolly', 'keen', 'kind', 'lively', 'lucky', 'merry', 'misty', 'noble', //
  'polite', 'proud', 'quick', 'quiet', 'rapid', 'rosy', 'royal', 'rustic',
  'shiny', 'silent', 'silver', 'sleek', 'smart', 'snowy', 'solar', 'spry',
  'steady', 'sunny', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty',
];

const kPlaceholderNouns = [
  'badger', 'beacon', 'birch', 'bison', 'canyon', 'cedar', 'comet', 'coral',
  'crane', 'delta', 'falcon', 'fern', 'finch', 'fjord', 'fox', 'gecko', //
  'glacier', 'harbor', 'hawk', 'heron', 'ibis', 'island', 'koala', 'lagoon',
  'lark', 'lynx', 'maple', 'meadow', 'meteor', 'moose', 'nebula', 'otter', //
  'owl', 'panda', 'pebble', 'pine', 'puffin', 'quartz', 'raven', 'reef', //
  'river', 'robin', 'sparrow', 'spruce', 'tiger', 'walrus', 'willow', 'zebra',
];

/// `brave-otter`: the branch a new worktree starts on until its session has a
/// name, one none of [taken] (branch names, with or without `refs/heads/`)
/// already uses.
String placeholderBranch(Iterable<String> taken, {Random? random}) {
  final names = {
    for (final name in taken) name.replaceFirst('refs/heads/', ''),
  };
  final pick = random ?? Random();
  String draw() =>
      '${kPlaceholderAdjectives[pick.nextInt(kPlaceholderAdjectives.length)]}'
      '-${kPlaceholderNouns[pick.nextInt(kPlaceholderNouns.length)]}';
  var name = draw();
  for (var tries = 0; tries < 16 && names.contains(name); tries++) {
    name = draw();
  }
  final base = name;
  for (var suffix = 2; names.contains(name); suffix++) {
    name = '$base-$suffix';
  }
  return name;
}

/// What a typed name becomes as a branch, as editors do it: words joined by
/// `-`, and nothing `git check-ref-format` refuses. Empty when nothing is left.
String branchNameFrom(String typed) {
  var name = typed
      .trim()
      .replaceAll(RegExp(r'\s+'), '-')
      .replaceAll(RegExp(r'[\x00-\x1f\x7f~^:?*\[\\]+'), '')
      .replaceAll(RegExp(r'\.{2,}'), '.')
      .replaceAll('@{', '@')
      .replaceAll(RegExp(r'/{2,}'), '/')
      .replaceAll(RegExp(r'/[.]+'), '/')
      .replaceAll(RegExp(r'-{2,}'), '-')
      .replaceAll(RegExp(r'^[-./]+'), '');
  for (var trimmed = ''; trimmed != name;) {
    trimmed = name;
    name = name.replaceAll(RegExp(r'(\.lock|[./])$'), '');
  }
  return name == '@' ? '' : name;
}

/// A name Git accepts for a new branch, checked before Git is asked.
bool plausibleBranchName(String name) =>
    name.isNotEmpty &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    !RegExp(r'[\x00-\x20\x7f~^:?*\[\\]').hasMatch(name);

bool validGitPath(String path) =>
    p.isAbsolute(path) &&
    path.length <= 4096 &&
    !RegExp(r'[\x00-\x1f\x7f]').hasMatch(path);

bool validGitRef(String ref) =>
    ref.length <= 1024 &&
    RegExp(r'^refs/(heads|remotes)/[^\s\x00-\x1f\x7f]+$').hasMatch(ref);
