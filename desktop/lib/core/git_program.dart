import 'dart:io';

import 'package:path/path.dart' as p;

import 'runtime_platform.dart';

/// The git to run, by its absolute path: PATH's absolute folders only, never
/// the working folder; on Windows git.exe alone, then Git for Windows' folders.
///
/// A bare `git` is looked up by the operating system, and on Windows
/// `CreateProcessW` searches the working folder before PATH: a `git.exe`
/// committed to a repository would run from it. A `git.cmd` would need
/// `cmd.exe` to run it, so it is never taken.
class GitProgram {
  GitProgram({
    Map<String, String>? environment,
    bool? isWindows,
    bool Function(String path)? isFile,
  }) : _environment = environment ?? RuntimePlatform.environment,
       _isWindows = isWindows ?? RuntimePlatform.isWindows,
       _isFile = isFile ?? FileSystemEntity.isFileSync;

  final Map<String, String> _environment;
  final bool _isWindows;
  final bool Function(String path) _isFile;
  String? _found;

  /// Found once and kept; a miss looks again next time, so a Git installed
  /// meanwhile (WindowsGitSetup) is found. None: throws what
  /// `Process.start('git')` throws for a missing git, which every caller
  /// already handles.
  String resolve() {
    if (_found case final found?) return found;
    for (final candidate in _candidates()) {
      if (_isFile(candidate)) return _found = candidate;
    }
    throw const ProcessException('git', [], 'git was not found', 2);
  }

  Iterable<String> _candidates() {
    final path = _isWindows ? p.windows : p.posix;
    final folders = [
      ...(_environment['PATH'] ?? '').split(_isWindows ? ';' : ':'),
      if (_isWindows) ..._gitForWindows(),
    ];
    return folders
        .map((folder) => path.join(folder, _isWindows ? 'git.exe' : 'git'))
        // An empty or relative folder is the working folder's, and `\tools`,
        // absolute to the path package, is on the working folder's drive.
        .where((git) => path.isAbsolute(git) && !path.isRootRelative(git));
  }

  /// Where Git for Windows puts its git.exe: its installer's `cmd`, then
  /// Scoop's shims for this user. Never Scoop's root for everyone
  /// (SCOOP_GLOBAL, %ProgramData%\scoop): any member of Users can make it.
  List<String> _gitForWindows() {
    final env = _environment;
    final scoops = [
      env['SCOOP'],
      if (env['USERPROFILE'] case final home?) p.windows.join(home, 'scoop'),
    ];
    return [
      for (final root in gitForWindowsRoots(env)) p.windows.join(root, 'cmd'),
      for (final root in scoops.nonNulls) p.windows.join(root, 'shims'),
    ];
  }
}

/// Where Git for Windows' installer puts it, for everyone or for this user
/// alone (cli lib/windows/gitBash.ts's gitForWindowsRoots).
List<String> gitForWindowsRoots(Map<String, String> environment) => [
  for (final root in [
    environment['ProgramFiles'],
    environment['ProgramW6432'],
    environment['ProgramFiles(x86)'],
  ].nonNulls)
    p.windows.join(root, 'Git'),
  if (environment['LOCALAPPDATA'] case final local?)
    p.windows.join(local, 'Programs', 'Git'),
];

final _processGit = GitProgram();

/// This process's git, found in its own environment.
String gitProgram() => _processGit.resolve();
