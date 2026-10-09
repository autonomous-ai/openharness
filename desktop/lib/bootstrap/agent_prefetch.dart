import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/test_run.dart';

/// Where the downloads beside setup stand, for the setup tour's bottom line.
@immutable
class AgentDownloads {
  const AgentDownloads({
    this.total = 0,
    this.done = 0,
    this.finished = false,
    this.settled = const {},
  });

  /// Agents being downloaded (0 when nothing was started: the computer already has an agent).
  final int total;
  final int done;

  /// The engines whose download has settled, for the tour's Details.
  final Set<String> settled;

  /// Every download has settled, whether it put its agent in place or not.
  final bool finished;
}

/// Downloads OpenCode, Codex and Claude Code while a fresh computer is being prepared, so the first
/// tab opens on all three running instead of installing them in their panes.
///
/// The owner's onboarding (2026-10-08): someone with no agent at all gets OpenCode, Codex and Claude
/// Code side by side on first launch, and "we should download during the first onboarding … here we
/// just open them". OpenCode's installer needs only `curl`, so it starts at once; Codex and Claude Code
/// are npm packages, installed the way the CLI's recipes install them (`npm install -g` into
/// `~/.local`, `cli/src/lib/engineInstall.ts`) as soon as setup has put Harness's own Node in place.
/// Measured downloads (macOS arm64): OpenCode 45 MB, Claude Code 105 MB, Codex 137 MB. The setup tour
/// waits for [everything]; an agent create waits for its own download ([waitFor]) in case one is
/// still going, so a pane never installs an agent a second time beside it.
///
/// OpenCode runs the CLI recipe with `--no-modify-path`: Harness finds `~/.opencode/bin` itself, and
/// a background download must not put a second OpenCode ahead of one the person already runs.
class AgentPrefetch {
  AgentPrefetch({
    Future<Process> Function(String executable, List<String> arguments)? start,
    bool Function()? skip,
    bool Function(String engine)? installed,
    String? Function()? managedNode,
    bool Function()? curl,
    void Function(String line)? log,
    DateTime Function()? now,
    Duration nodePoll = const Duration(seconds: 1),
    Duration nodeWait = const Duration(minutes: 5),
    String? Function()? markerDir,
    bool? warmOpenCode,
    String shell = '/bin/bash',
  }) : _warm = warmOpenCode ?? !kUnderTest,
       _shell = shell,
       _markerDir =
           markerDir ??
           (() => kUnderTest || _home == null ? null : '$_home/.harness/run'),
       _start =
           start ??
           ((executable, arguments) => Process.start(executable, arguments)),
       _skip = skip ?? (() => alreadyHasAnAgent(_home)),
       _installed = installed ?? _agentInPlace,
       _managedNode = managedNode ?? _managedNodePath,
       _curl = curl ?? (kUnderTest ? (() => true) : _hasCurl),
       _log = log ?? ((_) {}),
       _now = now ?? DateTime.now,
       _nodePoll = nodePoll,
       _nodeWait = nodeWait;

  /// The CLI's OpenCode recipe line, and what this adds to it.
  static const recipe = 'curl -fsSL https://opencode.ai/install | bash';
  static const command = 'set -o pipefail; $recipe -s -- --no-modify-path';

  /// The npm packages the CLI's recipes install for Codex and Claude Code.
  static const npmPackages = ['@openai/codex', '@anthropic-ai/claude-code'];

  final Future<Process> Function(String executable, List<String> arguments)
  _start;
  final bool Function() _skip;
  final bool Function(String engine) _installed;
  final String? Function() _managedNode;
  final bool Function() _curl;
  final void Function(String line) _log;
  final DateTime Function() _now;
  final Duration _nodePoll;
  final Duration _nodeWait;

  /// Where a download names its process while it runs (`downloading-<engine>`), so a pane that opens
  /// meanwhile waits for it rather than installing the engine again (the CLI's
  /// `harness_wait_download`). Null writes none (tests).
  final String? Function() _markerDir;

  /// Runs OpenCode once after its download ([_warmOpenCode]). Off under test unless asked for.
  final bool _warm;

  /// What runs a download's script; the specs try each shell a computer may have.
  final String _shell;

  /// The download's own name for itself on its command line, which is how a pane tells it from a
  /// process that took over a stale marker's pid.
  static const downloadName = 'harness-download';

  final Map<String, Future<void>> _downloads = {};
  final Map<String, DateTime> _startedAt = {};

  /// Completes once the engine's download runs under its marker, which is when a pane can wait
  /// for it itself.
  final Map<String, Completer<void>> _marked = {};
  Completer<void> _markedFor(String engine) =>
      _marked.putIfAbsent(engine, Completer<void>.new);
  final Set<String> _settled = {};
  Future<void>? _everything;
  final ValueNotifier<AgentDownloads> _progress = ValueNotifier(
    const AgentDownloads(),
  );

  /// Where the downloads stand, for the setup tour.
  ValueListenable<AgentDownloads> get progress => _progress;

  /// Settles when every download has settled; null when none was started.
  Future<void>? get everything => _everything;

  /// Downloads were started: this computer had no agent engine when setup began.
  bool get started => _everything != null;

  /// Starts the downloads on a computer new to Harness and its agents. Once per app run.
  void start() {
    if (_everything != null || _skip()) return;
    // OpenCode first: it is the one the first tab cannot do without, and its installer needs nothing
    // setup is still putting in place.
    final opencode = _track('opencode', _runOpenCode());
    final npm = _npmWhenNodeIsThere();
    final codex = _track('codex', npm);
    final claude = _track('claude', npm);
    _progress.value = const AgentDownloads(total: 3);
    _everything = Future.wait([opencode, codex, claude]).then((_) {
      _progress.value = AgentDownloads(
        total: 3,
        done: 3,
        finished: true,
        settled: Set.unmodifiable(_settled),
      );
    });
  }

  Future<void> _track(String engine, Future<void> work) {
    _startedAt[engine] = _now();
    final future = work.whenComplete(() {
      _settled.add(engine);
      if (!_progress.value.finished) {
        _progress.value = AgentDownloads(
          total: 3,
          done: _settled.length,
          settled: Set.unmodifiable(_settled),
        );
      }
    });
    _downloads[engine] = future;
    return future;
  }

  /// What a create of [engine] waits for: its download, for whatever is left of [budget] since that
  /// download started. Null when there is nothing to wait for — none started, it settled, the agent
  /// is in place, or the budget is spent — so a slow download costs the first create at most
  /// [budget] and every later one nothing.
  ///
  /// When the pane waits for the download itself ([paneWaits], the CLI's `waitsForDownload`), only
  /// until the download runs under its marker: before that (Codex and Claude Code wait for setup's
  /// Node first) or without one (a marker that could not be written) the pane could not see it and
  /// would install a second time.
  Future<void>? waitFor(
    String engine,
    Duration budget, {
    bool paneWaits = false,
  }) {
    final running = _downloads[engine];
    final since = _startedAt[engine];
    if (running == null ||
        since == null ||
        _settled.contains(engine) ||
        _installed(engine)) {
      return null;
    }
    final left = budget - _now().difference(since);
    if (left <= Duration.zero) return null;
    if (!paneWaits) return running.timeout(left, onTimeout: () {});
    final marked = _markedFor(engine);
    if (marked.isCompleted) return null;
    return Future.any([running, marked.future]).timeout(left, onTimeout: () {});
  }

  Future<void> _runOpenCode() async {
    // A fresh Ubuntu has no curl until setup's apt step installs it (`environment_provisioner.dart`).
    if (!await _until(_curl)) {
      _log('OpenCode was not downloaded during setup: curl never arrived');
      return;
    }
    // A create's wait counts from the download itself, not from the wait for curl before it.
    _startedAt['opencode'] = _now();
    await _run(
      'OpenCode',
      const ['opencode'],
      command,
      () => _installed('opencode'),
    );
    await _warmOpenCode();
  }

  /// Runs the downloaded OpenCode once (`--version`, nothing else), while setup is still busy: macOS
  /// checks a new binary on its first run, 3.9 s against 0.4 s afterwards on a fresh VM (2026-10-09),
  /// and that first run would otherwise be the first pane's, in front of the person. Only the version:
  /// a warm-up that started OpenCode's server once stalled its first harness for 51 s.
  Future<void> _warmOpenCode() async {
    final home = _home;
    if (!_warm || home == null || !_installed('opencode')) return;
    final started = _now();
    try {
      final process = await _start('$home/.opencode/bin/opencode', [
        '--version',
      ]);
      unawaited(process.stdout.drain<void>().catchError((_) {}));
      unawaited(process.stderr.drain<void>().catchError((_) {}));
      final code = await process.exitCode.timeout(
        const Duration(seconds: 20),
        onTimeout: () {
          process.kill();
          return -1;
        },
      );
      _log(
        'OpenCode first run during setup: exit $code in '
        '${(_now().difference(started).inMilliseconds / 1000).toStringAsFixed(1)}s',
      );
    } catch (error) {
      _log('OpenCode first run during setup did not start: $error');
    }
  }

  /// Codex and Claude Code, once setup has put Harness's Node in place: one npm, so the two never
  /// write the same global prefix at once.
  Future<void> _npmWhenNodeIsThere() async {
    String? node;
    await _until(() => (node = _managedNode()) != null);
    if (node == null) {
      _log(
        'Codex and Claude Code were not downloaded during setup: Harness\'s Node never arrived',
      );
      return;
    }
    // A create's wait counts from the download itself, not from the wait for Node before it.
    _startedAt['codex'] = _startedAt['claude'] = _now();
    final bin = File(node!).parent.path;
    final script = [
      'set -o pipefail',
      'export PATH=${_quote(bin)}:"\$PATH"',
      'export npm_config_prefix="\$HOME/.local" NPM_CONFIG_PREFIX="\$HOME/.local"',
      'npm install -g ${npmPackages.join(' ')}',
    ].join('; ');
    await _run(
      'Codex and Claude Code',
      const ['codex', 'claude'],
      script,
      () => _installed('codex') && _installed('claude'),
    );
  }

  /// Runs [script] as the download named [downloadName]. It ends on `exit`: bash 5.1 and later (Linux),
  /// dash and zsh run a script's last command in place of the shell, and npm under the shell's pid no
  /// longer carries the name a pane checks the marker's pid against (measured with zsh and dash,
  /// 2026-10-09), so the pane took the download for something else and installed a second time.
  Future<void> _run(
    String what,
    List<String> engines,
    String script,
    bool Function() inPlace,
  ) async {
    final started = _now();
    final markers = <File>[];
    try {
      final process = await _start(_shell, [
        '-c',
        '$script; exit \$?',
        downloadName,
      ]);
      final dir = _markerDir();
      if (dir != null) {
        try {
          Directory(dir).createSync(recursive: true);
          for (final engine in engines) {
            markers.add(
              File('$dir/downloading-$engine')
                ..writeAsStringSync('${process.pid}'),
            );
          }
          for (final engine in engines) {
            if (!_markedFor(engine).isCompleted) _markedFor(engine).complete();
          }
        } on FileSystemException {
          // Without a marker a pane cannot see the download, so a create waits for it instead.
        }
      }
      // Drained so a full pipe never stalls the installer; only the tail is kept for the log.
      final tail = <String>[];
      void keep(String line) {
        tail.add(line);
        if (tail.length > 5) tail.removeAt(0);
      }

      // Listened to from the start, so output that ends before the exit code is still counted.
      final drained = Future.wait([
        process.stdout
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .forEach(keep),
        process.stderr
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .forEach(keep),
      ]).catchError((_) => <void>[]);
      final code = await process.exitCode;
      await drained;
      final seconds = _now().difference(started).inMilliseconds / 1000;
      // Judged by the binary, as the CLI judges an install: an exit code alone says nothing about
      // which half of a pipeline failed.
      _log(
        code == 0 && inPlace()
            ? '$what downloaded during setup in ${seconds.toStringAsFixed(1)}s'
            : '$what download during setup did not finish (exit $code, '
                  '${seconds.toStringAsFixed(1)}s); the pane installs it instead: '
                  '${tail.join(' | ')}',
      );
    } catch (error) {
      _log('$what download during setup did not start: $error');
    } finally {
      for (final marker in markers) {
        try {
          marker.deleteSync();
        } on FileSystemException {
          // Gone already; a pane ignores a marker whose process has ended anyway.
        }
      }
    }
  }

  /// Setup is still putting in place what the downloads need (curl, Harness's Node): they wait for it
  /// as long as it runs, and [_nodeWait] more once it is over. On Linux setup waits for a password in
  /// Terminal, and on a first boot its apt queues behind Ubuntu's own updates; a wait that ran out
  /// meanwhile left the first tab to install Codex and Claude Code in two panes at once, two npm in
  /// one prefix.
  bool setupRunning = false;

  /// Stops every wait: the app is going away.
  void close() => _closed = true;
  bool _closed = false;

  /// Whether [there] holds, asked every [_nodePoll] while setup runs and until [_nodeWait] after.
  Future<bool> _until(bool Function() there) async {
    var deadline = _now().add(_nodeWait);
    var found = there();
    while (!found && !_closed) {
      if (setupRunning) deadline = _now().add(_nodeWait);
      if (!_now().isBefore(deadline)) break;
      await Future<void>.delayed(_nodePoll);
      found = there();
    }
    return found;
  }

  /// curl on the PATH the app runs downloads with.
  static bool _hasCurl() => (Platform.environment['PATH'] ?? '/usr/bin:/bin')
      .split(':')
      .any((dir) => dir.isNotEmpty && File('$dir/curl').existsSync());

  static String _quote(String text) => "'${text.replaceAll("'", "'\\''")}'";

  static String? get _home => Platform.environment['HOME'];

  static bool _agentInPlace(String engine) {
    final home = _home;
    if (home == null) return false;
    final path = switch (engine) {
      'opencode' => '$home/.opencode/bin/opencode',
      'codex' => '$home/.local/bin/codex',
      'claude' => '$home/.local/bin/claude',
      _ => null,
    };
    return path != null && File(path).existsSync();
  }

  /// The Node `install.sh` records in `~/.harness/runtime/current-node`, once it exists.
  static String? _managedNodePath() {
    final home = _home;
    if (home == null) return null;
    try {
      final node = File('$home/.harness/runtime/current-node')
          .readAsStringSync()
          .trim();
      return node.isNotEmpty && File(node).existsSync() ? node : null;
    } on FileSystemException {
      return null;
    }
  }

  /// Nothing to download for: Harness has run here before (its CLI folder), or the person already
  /// has an agent engine. The owner's rule (2026-10-08): only download when there is no agent engine
  /// yet. So Claude Code or Codex installed counts even if never signed in or run: their folders,
  /// their programs where their installers and Homebrew put them, and npm installs under nvm.
  /// OpenCode counts anywhere it installs to or has kept its data in. A false "new" costs a download,
  /// so this errs towards skipping.
  static bool alreadyHasAnAgent(
    String? home, {
    List<String> prefixes = const ['/opt/homebrew/bin', '/usr/local/bin'],
  }) {
    if (home == null) return true;
    final programs = [
      for (final name in const ['claude', 'codex', 'opencode']) ...[
        '$home/.local/bin/$name',
        for (final prefix in prefixes) '$prefix/$name',
        ..._nvmBins(home).map((bin) => '$bin/$name'),
      ],
    ];
    return [
      '$home/.harness/cli',
      '$home/.claude',
      '$home/.codex',
      '$home/.claude/local/claude',
      '$home/.opencode/bin/opencode',
      '$home/.bun/bin/opencode',
      '$home/.config/opencode',
      '$home/.local/share/opencode',
      ...programs,
    ].any(
      (path) =>
          FileSystemEntity.typeSync(path) != FileSystemEntityType.notFound,
    );
  }

  /// `~/.nvm/versions/node/<version>/bin`: where `npm install -g` puts Claude Code and Codex for
  /// someone on nvm, whose login shell Harness does not run here.
  static Iterable<String> _nvmBins(String home) {
    final versions = Directory('$home/.nvm/versions/node');
    try {
      return versions
          .listSync(followLinks: false)
          .whereType<Directory>()
          .map((version) => '${version.path}/bin');
    } on FileSystemException {
      return const [];
    }
  }
}
