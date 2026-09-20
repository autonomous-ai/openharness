import 'dart:io';

import 'package:path/path.dart' as p;

import 'repository_clone.dart';

/// Folder preparation is explicit and runs only when New Agent is submitted.
/// Existing folders continue to use the ordinary agent_create cwd payload.
class ProjectFolderRequest {
  const ProjectFolderRequest.newProject() : repository = null;
  const ProjectFolderRequest.remote(GitHubRepository value)
    : repository = value;

  final GitHubRepository? repository;

  Map<String, String> get payload => {
    'projectSource': repository == null ? 'new' : 'remote',
    if (repository != null) 'repositoryUrl': repository!.url,
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
      await root.create(recursive: true);
      if (repository case final repo?) {
        return await (createClone?.call() ?? RepositoryClone()).run(
          repo,
          root.path,
        );
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
        if (await _createExclusiveDirectory(folder)) return folder;
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

Future<bool> _createExclusiveDirectory(String folder) async {
  if (!Platform.isWindows) {
    // Directory.create accepts existing directories; mkdir reserves exclusively.
    return (await Process.run('mkdir', [folder])).exitCode == 0;
  }
  // Windows has no mkdir executable. Renaming a private, empty sibling uses
  // MoveFileEx without REPLACE_EXISTING, so it cannot reuse even an empty folder.
  // Keep this Windows-only: POSIX rename can replace an empty destination.
  final staging = await Directory(p.dirname(folder))
      .createTemp('.harness-project-');
  var moved = false;
  try {
    await staging.rename(folder);
    moved = true;
    return true;
  } on FileSystemException {
    return false;
  } finally {
    if (!moved) await staging.delete();
  }
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
