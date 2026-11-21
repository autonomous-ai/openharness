import 'dart:io';

import 'package:path/path.dart' as p;

import 'runtime_platform.dart';
import 'windows_folder.dart';

/// A program to run, by its absolute path: PATH's absolute folders only, never
/// the working folder; on Windows `<name>.exe` alone, then the folders its
/// installer puts it in.
///
/// A bare name is looked up by the operating system, and on Windows
/// `CreateProcessW` searches the app's own folder, then the app's working
/// folder, before PATH: a `git.exe` put in either would run. A `git.cmd` would
/// need `cmd.exe` to run it, so it is never taken.
class ProgramPath {
  /// git, then Git for Windows' folders.
  ProgramPath.git({
    Map<String, String>? environment,
    bool? isWindows,
    bool Function(String path)? isProgram,
  }) : this._('git', _gitForWindows, environment, isWindows, isProgram);

  /// ssh, then OpenSSH's, which Windows installs in System32.
  ProgramPath.ssh({
    Map<String, String>? environment,
    bool? isWindows,
    bool Function(String path)? isProgram,
  }) : this._('ssh', _openSsh, environment, isWindows, isProgram);

  /// winget, then this user's WindowsApps, where the App Installer puts it.
  ProgramPath.winget({
    Map<String, String>? environment,
    bool? isWindows,
    bool Function(String path)? isProgram,
  }) : this._('winget', _windowsApps, environment, isWindows, isProgram);

  ProgramPath._(
    this._name,
    this._windowsFolders,
    Map<String, String>? environment,
    bool? isWindows,
    bool Function(String path)? isProgram,
  ) : _environment = environment ?? RuntimePlatform.environment,
      _isWindows = isWindows ?? RuntimePlatform.isWindows,
      _isProgram = isProgram ?? _canRun;

  final String _name;
  final List<String> Function(Map<String, String> environment) _windowsFolders;
  final Map<String, String> _environment;
  final bool _isWindows;
  final bool Function(String path) _isProgram;
  String? _found;

  /// Found once and kept; a miss looks again next time, so a Git installed
  /// meanwhile (WindowsGitSetup) is found. None: throws what `Process.start`
  /// of the bare name throws for a missing program, which every caller
  /// already handles.
  String resolve() {
    if (_found case final found?) return found;
    for (final candidate in _candidates()) {
      if (_isProgram(candidate)) return _found = candidate;
    }
    throw ProcessException(_name, const [], '$_name was not found', 2);
  }

  /// A regular file (a link is followed) and, off Windows, one with an execute
  /// bit: exec refuses any other, and the program found is kept, so every run
  /// would fail.
  static bool _canRun(String path) {
    final stat = FileStat.statSync(path);
    // 0x49 is 0o111: the owner's, the group's or anyone's execute bit.
    return stat.type == FileSystemEntityType.file &&
        (RuntimePlatform.isWindows || stat.mode & 0x49 != 0);
  }

  Iterable<String> _candidates() {
    final path = _isWindows ? p.windows : p.posix;
    final folders = [
      ...(_environment['PATH'] ?? '').split(_isWindows ? ';' : ':'),
      if (_isWindows) ..._windowsFolders(_environment),
    ];
    final name = _isWindows ? '$_name.exe' : _name;
    return folders
        .map((folder) => path.join(folder, name))
        // An empty or relative folder is the working folder's, and `\tools`,
        // absolute to the path package, is on the working folder's drive.
        .where(
          (program) =>
              path.isAbsolute(program) && !path.isRootRelative(program),
        );
  }

  /// Where Git for Windows puts its git.exe: its installer's `cmd`, then
  /// Scoop's shims for this user. Never Scoop's root for everyone
  /// (SCOOP_GLOBAL, %ProgramData%\scoop): any member of Users can make it.
  static List<String> _gitForWindows(Map<String, String> env) {
    final scoops = [
      env['SCOOP'],
      if (env['USERPROFILE'] case final home?) p.windows.join(home, 'scoop'),
    ];
    return [
      for (final root in gitForWindowsRoots(env)) p.windows.join(root, 'cmd'),
      for (final root in scoops.nonNulls) p.windows.join(root, 'shims'),
    ];
  }

  static List<String> _openSsh(Map<String, String> _) => [
    p.windows.join(windowsFolder(), 'System32', 'OpenSSH'),
  ];

  static List<String> _windowsApps(Map<String, String> env) => [
    if (env['LOCALAPPDATA'] case final local?)
      p.windows.join(local, 'Microsoft', 'WindowsApps'),
  ];
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

final _processGit = ProgramPath.git();
final _processSsh = ProgramPath.ssh();

/// This process's git, found in its own environment.
String gitProgram() => _processGit.resolve();

/// This process's ssh, found in its own environment.
String sshProgram() => _processSsh.resolve();
