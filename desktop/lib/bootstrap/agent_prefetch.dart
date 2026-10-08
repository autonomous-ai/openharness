import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

/// Where the downloads beside setup stand, for the setup tour's bottom line.
@immutable
class AgentDownloads {
  const AgentDownloads({this.total = 0, this.done = 0, this.finished = false});

  /// Agents being downloaded (0 when nothing was started: the computer already has an agent).
  final int total;
  final int done;

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
    void Function(String line)? log,
    DateTime Function()? now,
    Duration nodePoll = const Duration(seconds: 1),
    Duration nodeWait = const Duration(minutes: 5),
  }) : _start =
           start ??
           ((executable, arguments) => Process.start(executable, arguments)),
       _skip = skip ?? (() => alreadyHasAnAgent(_home)),
       _installed = installed ?? _agentInPlace,
       _managedNode = managedNode ?? _managedNodePath,
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
  final void Function(String line) _log;
  final DateTime Function() _now;
  final Duration _nodePoll;
  final Duration _nodeWait;

  final Map<String, Future<void>> _downloads = {};
  final Map<String, DateTime> _startedAt = {};
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
      _progress.value = const AgentDownloads(total: 3, done: 3, finished: true);
    });
  }

  Future<void> _track(String engine, Future<void> work) {
    _startedAt[engine] = _now();
    final future = work.whenComplete(() {
      _settled.add(engine);
      if (!_progress.value.finished) {
        _progress.value = AgentDownloads(total: 3, done: _settled.length);
      }
    });
    _downloads[engine] = future;
    return future;
  }

  /// What a create of [engine] waits for: its download, for whatever is left of [budget] since that
  /// download started. Null when there is nothing to wait for — none started, it settled, the agent
  /// is in place, or the budget is spent — so a slow download costs the first create at most
  /// [budget] and every later one nothing.
  Future<void>? waitFor(String engine, Duration budget) {
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
    return running.timeout(left, onTimeout: () {});
  }

  Future<void> _runOpenCode() => _run('OpenCode', '/bin/bash', [
    '-c',
    command,
  ], () => _installed('opencode'));

  /// Codex and Claude Code, once setup has put Harness's Node in place: one npm, so the two never
  /// write the same global prefix at once.
  Future<void> _npmWhenNodeIsThere() async {
    final deadline = _now().add(_nodeWait);
    String? node = _managedNode();
    while (node == null && _now().isBefore(deadline)) {
      await Future<void>.delayed(_nodePoll);
      node = _managedNode();
    }
    if (node == null) {
      _log(
        'Codex and Claude Code were not downloaded during setup: Harness\'s Node never arrived',
      );
      return;
    }
    final bin = File(node).parent.path;
    final script = [
      'set -o pipefail',
      'export PATH=${_quote(bin)}:"\$PATH"',
      'export npm_config_prefix="\$HOME/.local" NPM_CONFIG_PREFIX="\$HOME/.local"',
      'npm install -g ${npmPackages.join(' ')}',
    ].join('; ');
    await _run('Codex and Claude Code', '/bin/bash', [
      '-c',
      script,
    ], () => _installed('codex') && _installed('claude'));
  }

  Future<void> _run(
    String what,
    String executable,
    List<String> arguments,
    bool Function() inPlace,
  ) async {
    final started = _now();
    try {
      final process = await _start(executable, arguments);
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
    }
  }

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
