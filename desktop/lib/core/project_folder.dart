import 'dart:io';

import 'package:path/path.dart' as p;

import 'repository_clone.dart';
import 'git_worktree.dart';

/// Folder preparation is explicit and runs only when New Agent is submitted.
/// Existing folders continue to use the ordinary agent_create cwd payload.
class ProjectFolderRequest {
  const ProjectFolderRequest.newProject({this.name})
    : gitSource = null,
      branchRef = null,
      branchName = null,
      existingBranch = false,
      createsWorktree = false,
      repository = null,
      generatedLabel = null,
      generatedAt = null;
  ProjectFolderRequest.generated({
    required String label,
    required DateTime at,
    String? name,
  }) : gitSource = null,
       branchRef = null,
       branchName = null,
       existingBranch = false,
       createsWorktree = false,
       repository = null,
       generatedLabel = label,
       generatedAt = at,
       name = name ?? _suggestedFolderName(label, at);
  const ProjectFolderRequest.remote(GitHubRepository value)
    : gitSource = null,
      branchRef = null,
      branchName = null,
      existingBranch = false,
      createsWorktree = false,
      repository = value,
      name = null,
      generatedLabel = null,
      generatedAt = null;

  /// A new worktree on [branchName]: created from [branchRef], or with
  /// [existingBranch] that local branch checked out as it is. Without a name
  /// the machine makes one up.
  const ProjectFolderRequest.worktree(
    String source, {
    this.branchRef,
    this.branchName,
    this.existingBranch = false,
  }) : gitSource = source,
      createsWorktree = true,
      repository = null,
      name = null,
      generatedLabel = null,
      generatedAt = null;

  const ProjectFolderRequest.branch(String source, String ref)
    : gitSource = source,
      branchRef = ref,
      branchName = null,
      existingBranch = false,
      createsWorktree = false,
      repository = null,
      name = null,
      generatedLabel = null,
      generatedAt = null;

  final String? gitSource, branchRef, branchName;
  final bool createsWorktree, existingBranch;

  final GitHubRepository? repository;

  /// What the person called the new project, or null to name it after the
  /// harness and the time. The folder is [projectFolderSlug] of it.
  final String? name;
  final String? generatedLabel;
  final DateTime? generatedAt;
  bool get isGenerated => generatedAt != null;

  /// The preview and Start share a frozen timestamp. Only an untouched
  /// suggestion can advance to another name if its folder is taken.
  String nextGeneratedName(String taken) {
    final precise = _suggestedFolderName(
      generatedLabel!,
      generatedAt!,
      withSeconds: true,
    );
    String numbered(int suffix) => _suggestedFolderName(
      generatedLabel!,
      generatedAt!,
      withSeconds: true,
      suffix: suffix,
    );
    if (taken == precise) return numbered(2);
    final suffix = int.tryParse(taken.split('-').last);
    if (suffix != null && suffix >= 2 && taken == numbered(suffix)) {
      return numbered(suffix + 1);
    }
    return precise;
  }

  String availableGeneratedName(Iterable<String> names) {
    final occupied = names.map((name) => name.toLowerCase()).toSet();
    var candidate = folderName!;
    while (occupied.contains(candidate.toLowerCase())) {
      candidate = nextGeneratedName(candidate);
    }
    return candidate;
  }

  ProjectFolderRequest withGeneratedName(String name) =>
      ProjectFolderRequest.generated(
        label: generatedLabel!,
        at: generatedAt!,
        name: name,
      );

  /// The folder a named new project gets, or null when it is left to the clock.
  String? get folderName => name == null ? null : projectFolderSlug(name!);

  Map<String, String> get payload => {
    'projectSource': gitSource != null
        ? (createsWorktree ? 'worktree' : 'branch')
        : repository == null
        ? 'new'
        : 'remote',
    'gitSource': ?gitSource,
    'branchRef': ?branchRef,
    // A daemon that predates these names the worktree's branch itself.
    'branchName': ?branchName,
    if (existingBranch) 'branchMode': 'existing',
    if (repository != null) 'repositoryUrl': repository!.url,
    // A daemon that predates the field ignores it and names the folder itself.
    if (repository == null && folderName != null) 'projectName': folderName!,
  };

  /// A new project is named after who it is for and when: [label] ("Codex", "Blender") and the
  /// local time, `codex-2026-09-03-09-05`, every part two digits so a folder listing sorts in the
  /// order harnesses were made. Nothing is counted — `harness-N` folders numbered apart from agent
  /// names drifted from them. Two in the same minute take the seconds, then a suffix. The daemon
  /// names remote projects the same way (cli/src/lib/agentNames.ts).
  Future<String> prepareLocal({
    String? projectHome,
    RepositoryClone Function()? createClone,
    String label = 'harness',
    DateTime Function()? now,
  }) async {
    final home =
        Platform.environment['HOME'] ?? Platform.environment['USERPROFILE'];
    if (projectHome == null && (home == null || !p.isAbsolute(home))) {
      throw const RepositoryCloneException(
        'Could not find your home folder. Browse for a folder.',
      );
    }
    final root = Directory(projectHome ?? p.join(home!, 'harnesses'));
    try {
      if (gitSource case final source?) {
        return await prepareGitProject(
          source,
          root.path,
          worktree: createsWorktree,
          branchRef: branchRef,
          branchName: branchName,
          existingBranch: existingBranch,
        );
      }
      await root.create(recursive: true);
      if (repository case final repo?) {
        return await (createClone?.call() ?? RepositoryClone()).run(
          repo,
          root.path,
        );
      }
      if (folderName case final named?) {
        // A name somebody chose is never quietly changed: an existing folder
        // is theirs to pick as an existing project, as a clone's is.
        var candidate = named;
        while (true) {
          final folder = p.join(root.path, candidate);
          final result = await Process.run('mkdir', [folder]);
          if (result.exitCode == 0) return folder;
          if (await FileSystemEntity.type(folder, followLinks: false) !=
              FileSystemEntityType.notFound) {
            if (isGenerated) {
              candidate = nextGeneratedName(candidate);
              continue;
            }
            throw RepositoryCloneException(
              '“$named” already exists. Choose it as an existing project.',
            );
          }
          throw FileSystemException('Could not create folder', folder);
        }
      }
      final at = (now ?? DateTime.now)();
      final base = projectFolderName(label, at);
      final precise = projectFolderName(label, at, withSeconds: true);
      for (var attempt = 0; ; attempt++) {
        final folder = p.join(
          root.path,
          attempt == 0
              ? base
              : attempt == 1
              ? precise
              : '$precise-$attempt',
        );
        // Directory.create accepts an existing directory. The platform mkdir
        // command reserves it exclusively, so concurrent creates never share
        // a workspace. Paths are arguments, never shell text.
        final result = await Process.run('mkdir', [folder]);
        if (result.exitCode == 0) return folder;
        if (await FileSystemEntity.type(folder, followLinks: false) ==
            FileSystemEntityType.notFound) {
          throw FileSystemException('Could not create folder', folder);
        }
      }
    } on FileSystemException {
      throw const RepositoryCloneException(
        'Could not create a project folder. Browse for a folder you can edit.',
      );
    } on ProcessException {
      throw const RepositoryCloneException(
        'Could not create a project folder. Browse for a folder you can edit.',
      );
    }
  }
}

/// Suggested names travel through the daemon's 64-character named-project
/// field. Shorten only a long label, preserving the date and collision suffix.
String _suggestedFolderName(
  String label,
  DateTime at, {
  bool withSeconds = false,
  int? suffix,
}) {
  final name = projectFolderName(label, at, withSeconds: withSeconds);
  final stamp = projectFolderName(
    '',
    at,
    withSeconds: withSeconds,
  ).substring('harness'.length);
  final ending = '$stamp${suffix == null ? '' : '-$suffix'}';
  var prefix = name.substring(0, name.length - stamp.length);
  final room = 64 - ending.length;
  if (prefix.length > room) prefix = prefix.substring(0, room);
  return '$prefix$ending';
}

/// `codex-2026-09-03-09-05`: [label] in lowercase words, then the local date and time.
String projectFolderName(
  String label,
  DateTime at, {
  bool withSeconds = false,
}) {
  String two(int n) => n.toString().padLeft(2, '0');
  final slug = label
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  final time =
      '${two(at.hour)}-${two(at.minute)}${withSeconds ? '-${two(at.second)}' : ''}';
  return '${slug.isEmpty ? 'harness' : slug}-${at.year}-${two(at.month)}-${two(at.day)}-$time';
}

/// The folder for a project somebody named: their words with spaces as dashes
/// and nothing a path or a shell reads specially. Null when nothing usable is
/// left, which callers treat as "not named". Mirrors `projectFolderSlug` in
/// cli/src/lib/agentNames.ts.
String? projectFolderSlug(String name) {
  final slug = name
      .trim()
      .replaceAll(RegExp(r'\s+'), '-')
      .replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '')
      .replaceAll(RegExp(r'^[.-]+|[.-]+$'), '');
  if (slug.isEmpty) return null;
  return slug.length > 64 ? slug.substring(0, 64) : slug;
}
