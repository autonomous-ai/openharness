import 'dart:io';

import 'package:path/path.dart' as p;

import '../core/hidden_process.dart';
import '../core/home_dir.dart';
import '../core/runtime_platform.dart';
import '../core/test_run.dart';

/// Git for Windows, put in place beside setup so nobody has to know they need
/// it: Swarm agents' git, a Buddy's guard and setup scripts all run in its
/// bash. For this user alone, so Windows asks nothing, and hidden. Tried once:
/// without it Harness still works, and whatever needs it says so.
class WindowsGitSetup {
  WindowsGitSetup({
    Map<String, String>? environment,
    bool Function(String path)? isFile,
    Future<int> Function(String executable, List<String> arguments)? run,
    bool? isWindows,
    void Function(String line)? log,
  }) : _environment = environment ?? Platform.environment,
       _isFile = isFile ?? ((path) => File(path).existsSync()),
       _run = run ?? _runWinget,
       _isWindows = isWindows ?? (RuntimePlatform.isWindows && !kUnderTest),
       _log = log ?? ((_) {});

  final Map<String, String> _environment;
  final bool Function(String path) _isFile;
  final Future<int> Function(String executable, List<String> arguments) _run;
  final bool _isWindows;
  final void Function(String line) _log;

  static const arguments = [
    'install',
    '--id',
    'Git.Git',
    '-e',
    '--silent',
    '--scope',
    'user',
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--disable-interactivity',
  ];

  static Future<int> _runWinget(
    String executable,
    List<String> arguments,
  ) async {
    final result = await runHidden(executable, arguments);
    return result.exitCode;
  }

  /// Where the CLI looks (cli lib/windows/gitBash.ts): a `git` on PATH, then
  /// where its installer puts it, for everyone or for this user.
  bool get gitIsThere {
    final path = _environment['PATH'] ?? _environment['Path'] ?? '';
    if (path
        .split(';')
        .any(
          (dir) => dir.isNotEmpty && _isFile(p.windows.join(dir, 'git.exe')),
        )) {
      return true;
    }
    final roots = [
      _environment['ProgramFiles'],
      _environment['ProgramW6432'],
      _environment['ProgramFiles(x86)'],
      if (_environment['LOCALAPPDATA'] case final local?)
        p.windows.join(local, 'Programs'),
    ];
    return roots.whereType<String>().any(
      (root) => _isFile(p.windows.join(root, 'Git', 'bin', 'bash.exe')),
    );
  }

  String? get _marker {
    final home = maybeHomeDir(environment: _environment, isWindows: true);
    return home == null
        ? null
        : p.windows.join(home, '.harness', 'run', 'git-install-tried');
  }

  /// Never throws, and nothing waits for it.
  Future<void> start() async {
    if (!_isWindows || gitIsThere) return;
    final marker = _marker;
    if (marker == null || _isFile(marker)) return;
    try {
      await File(marker).create(recursive: true);
      final code = await _run('winget', arguments);
      _log(
        code == 0
            ? 'Git for Windows installed'
            : 'Git for Windows was not installed: winget exited $code',
      );
    } catch (error) {
      _log('Git for Windows was not installed: $error');
    }
  }
}
