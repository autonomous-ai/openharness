import 'dart:io';

import 'package:path/path.dart' as p;

import '../logging/cli_transcript.dart';
import 'hidden_process.dart';
import 'home_dir.dart';
import 'test_run.dart';
import 'windows_layout.dart';

/// Runs the Harness CLI owned by this desktop app without depending on a
/// terminal shell, its rc files, or Finder's inherited PATH.
///
/// The normal path is the managed tier: `~/.harness/runtime/current-node` — a
/// private, checksum-verified Node that the `harness` installer provisions and
/// records — paired with the `~/.harness/cli/cli.js` bundle,
/// invoked as `<node> <cli.js> …` with no shell in between. Because both are
/// absolute paths beneath [harnessHome], launching Harness from Finder and from
/// Terminal have identical runtime behavior; PATH never enters into it.
///
/// Behind that come the installed `~/.local/bin/harness` launcher and finally
/// bare `harness` on PATH, which cover a developer-managed install and the
/// window before the first provisioning run has finished.
///
/// Windows has three tiers of its own, over the layout `install.ps1` writes
/// (B §1, "Layout"):
/// 1. `runtime\current-node` with `cli\current`, run as
///    `<node.exe> cli\<version>\cli.js …` ([managedWindowsCli], B's rules);
/// 2. `bin\harness.exe`, B's console launcher, which reads the same pointers;
/// 3. a `harness.exe` in one of PATH's folders, looked up here because
///    `CreateProcessW` would try the working folder first.
/// Every path is handed over as one argument and never re-parsed by a shell, so
/// a profile such as `C:\Users\Nguyễn Văn A'` reaches the child unchanged.
class HarnessCliRunner {
  final Directory harnessHome;
  final Map<String, String> environment;

  /// Which tiers [resolve] tries. Windows has its own install layout.
  final bool _isWindows;

  /// How long one CLI command may take before the app stops waiting on it. Every command this app
  /// runs answers in well under a second (`auth status`, `link list`) or a few seconds (`start`
  /// spawning the daemon and waiting for its port). A `start` that had to reach a black-holed
  /// backend used to sit here for good — and the app sat on "Starting local service…" with it.
  final Duration runTimeout;
  static const defaultRunTimeout = Duration(seconds: 30);
  final Future<ProcessResult> Function(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  })
  _runProcess;
  final Future<Process> Function(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  })
  _startProcess;

  HarnessCliRunner({
    Directory? harnessHome,
    Map<String, String>? environment,
    bool? isWindows,
    this.runTimeout = defaultRunTimeout,
    Future<ProcessResult> Function(
      String executable,
      List<String> arguments, {
      Map<String, String>? environment,
    })?
    runProcess,
    Future<Process> Function(
      String executable,
      List<String> arguments, {
      Map<String, String>? environment,
    })?
    startProcess,
  }) : environment = environment ?? Platform.environment,
       _isWindows = isWindows ?? Platform.isWindows,
       // homeDir, not HOME: Windows sets only USERPROFILE, so a launch from Explorer threw here
       // before any UI existed to report it, and Git Bash's HOME is not where the CLI lives.
       harnessHome =
           harnessHome ??
           Directory(
             p.join(
               homeDir(environment: environment, isWindows: isWindows),
               '.harness',
             ),
           ),
       _runProcess = runProcess ?? runHidden,
       _startProcess = startProcess ?? startHidden,
       _realRun = runProcess == null,
       _realStart = startProcess == null;

  /// Whether [run] and [start] would spawn the real CLI: no process functions were given. Under
  /// flutter test they refuse instead ([_refuseUnderTest]).
  final bool _realRun, _realStart;

  /// 10-27: a test reached this computer's real CLI, and its `harness logout` signed the whole
  /// computer out. A test supplies its own process functions, or gets what a computer without the
  /// CLI gives (CI): a [ProcessException].
  void _refuseUnderTest(bool real, List<String> arguments) {
    if (!real || !kUnderTest) return;
    throw ProcessException(
      'harness',
      arguments,
      'The real Harness CLI is never run under flutter test: give the runner its own process '
          'functions.',
    );
  }

  Directory get _runtimeDirectory =>
      Directory('${harnessHome.path}${Platform.pathSeparator}runtime');

  File get _currentNodeFile =>
      File('${_runtimeDirectory.path}${Platform.pathSeparator}current-node');

  File get _cliFile => File(
    '${harnessHome.path}${Platform.pathSeparator}cli${Platform.pathSeparator}cli.js',
  );

  /// Builds the direct invocation used by [run] and [start]. Public for
  /// focused tests and diagnostics; callers should generally call [run].
  Future<HarnessCliInvocation> resolve(List<String> arguments) async {
    if (_isWindows) return _resolveWindows(arguments);
    final node = await _managedNode();
    if (node != null && await _cliFile.exists()) {
      return HarnessCliInvocation(
        executable: node.path,
        arguments: [_cliFile.path, ...arguments],
        environment: _commandEnvironment(),
        source: HarnessCliSource.managed,
      );
    }

    final home = _home();
    if (home != null && home.isNotEmpty) {
      final launcher = File(
        '$home${Platform.pathSeparator}.local${Platform.pathSeparator}bin${Platform.pathSeparator}harness',
      );
      if (await launcher.exists()) {
        return HarnessCliInvocation(
          executable: launcher.path,
          arguments: arguments,
          environment: _commandEnvironment(),
          source: HarnessCliSource.launcher,
        );
      }
    }

    return HarnessCliInvocation(
      executable: 'harness',
      arguments: arguments,
      environment: _commandEnvironment(),
      source: HarnessCliSource.path,
    );
  }

  /// [resolve] on Windows: B's pointers, then its `bin\harness.exe`, then a
  /// `harness.exe` in one of PATH's folders.
  Future<HarnessCliInvocation> _resolveWindows(List<String> arguments) async {
    final managed = await managedWindowsCli(harnessHome);
    if (managed != null) {
      return HarnessCliInvocation(
        executable: managed.node,
        arguments: [managed.cliJs, ...arguments],
        environment: _commandEnvironment(),
        source: HarnessCliSource.managed,
      );
    }
    final launcher = File(p.join(harnessHome.path, 'bin', 'harness.exe'));
    if (await launcher.exists()) {
      return HarnessCliInvocation(
        executable: launcher.path,
        arguments: arguments,
        environment: _commandEnvironment(),
        source: HarnessCliSource.launcher,
      );
    }
    return HarnessCliInvocation(
      executable: _onPath('harness.exe') ?? 'harness.exe',
      arguments: arguments,
      environment: _commandEnvironment(),
      source: HarnessCliSource.path,
    );
  }

  /// The first [name] in one of PATH's absolute folders. `CreateProcessW`
  /// would search the app's folder and the working folder before PATH, so a
  /// `harness.exe` left in Downloads would win there.
  String? _onPath(String name) {
    final path = environment[_pathKey(environment)] ?? '';
    for (final entry in path.split(';')) {
      final folder = entry.trim().replaceAll('"', '');
      if (folder.isEmpty || !p.isAbsolute(folder)) continue;
      final candidate = p.join(folder, name);
      if (File(candidate).existsSync()) return candidate;
    }
    return null;
  }

  /// PATH's own key. Windows names it `Path`, and a variable's name is
  /// case-insensitive there: writing `PATH` beside an inherited `Path` would
  /// hand the child two of them.
  String _pathKey(Map<String, String> variables) {
    if (!_isWindows) return 'PATH';
    for (final key in variables.keys) {
      if (key.toUpperCase() == 'PATH') return key;
    }
    return 'PATH';
  }

  Future<ProcessResult> run(List<String> arguments) async {
    _refuseUnderTest(_realRun, arguments);
    final invocation = await resolve(arguments);
    return logProcessRun(
      _displayLine(arguments),
      () =>
          _runProcess(
            invocation.executable,
            invocation.arguments,
            environment: invocation.environment,
          ).timeout(
            runTimeout,
            // The child is not killed — `Process.run` gives no handle to it, and a stuck `start` is the
            // CLI's own lock's business. What ends here is the app's wait, as an error it can show.
            onTimeout: () => throw ProcessException(
              'harness',
              arguments,
              'did not finish within ${runTimeout.inSeconds}s',
            ),
          ),
    );
  }

  Future<Process> start(List<String> arguments) async {
    _refuseUnderTest(_realStart, arguments);
    final invocation = await resolve(arguments);
    return logProcessStart(
      _displayLine(arguments),
      () => _startProcess(
        invocation.executable,
        invocation.arguments,
        environment: invocation.environment,
      ),
    );
  }

  /// The invocation as a person reads it — `harness auth status --json`.
  ///
  /// The [arguments] this was asked for, never [HarnessCliInvocation.arguments]:
  /// on the managed tier the real argv is `<node> <cli.js> …`, two absolute
  /// paths of noise in front of the only part that says what ran.
  static String _displayLine(List<String> arguments) =>
      'harness ${arguments.join(' ')}';

  Future<File?> _managedNode() async {
    try {
      final raw = (await _currentNodeFile.readAsString()).trim();
      if (raw.isEmpty) return null;
      final runtimeRoot =
          '${_runtimeDirectory.absolute.path}${Platform.pathSeparator}';
      if (!raw.startsWith(runtimeRoot)) return null;
      final node = File(raw);
      return await node.exists() ? node : null;
    } on FileSystemException {
      return null;
    }
  }

  String? _home() =>
      maybeHomeDir(environment: environment, isWindows: _isWindows);

  /// The folder the CLI's own launcher is in, put first on the child's PATH so
  /// that `harness` names it: `~/.local/bin`, or on Windows `bin` in
  /// [harnessHome], where install.ps1 writes `harness.exe`.
  String? _launcherDirectory() {
    if (_isWindows) return p.join(harnessHome.path, 'bin');
    final home = _home();
    return home == null || home.isEmpty
        ? null
        : '$home${Platform.pathSeparator}.local${Platform.pathSeparator}bin';
  }

  Map<String, String> _commandEnvironment() {
    final commandEnvironment = <String, String>{...environment};
    final launcherDirectory = _launcherDirectory();
    if (launcherDirectory != null) {
      final key = _pathKey(commandEnvironment);
      final path = commandEnvironment[key] ?? '';
      // PATH is ';'-separated on Windows. Joining with ':' there does not just fail to prepend the
      // launcher directory — it welds it onto the first real entry and destroys that one too.
      final separator = _isWindows ? ';' : ':';
      commandEnvironment[key] = path.isEmpty
          ? launcherDirectory
          : '$launcherDirectory$separator$path';
    }
    final configuredLocale =
        commandEnvironment['LC_ALL'] ??
        commandEnvironment['LC_CTYPE'] ??
        commandEnvironment['LANG'];
    if (!_isWindows &&
        (Platform.isMacOS || Platform.isLinux) &&
        (configuredLocale == null ||
            !RegExp(
              r'utf-?8',
              caseSensitive: false,
            ).hasMatch(configuredLocale))) {
      commandEnvironment['LC_ALL'] = 'C.UTF-8';
    }
    return commandEnvironment;
  }
}

enum HarnessCliSource { managed, launcher, path }

class HarnessCliInvocation {
  final String executable;
  final List<String> arguments;
  final Map<String, String> environment;
  final HarnessCliSource source;

  const HarnessCliInvocation({
    required this.executable,
    required this.arguments,
    required this.environment,
    required this.source,
  });
}
