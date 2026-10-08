import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Downloads OpenCode while a fresh computer is being prepared, so the first harness does not
/// install it in its pane.
///
/// OpenCode is the agent a new person without Claude Code or Codex starts on, and on a fresh Mac
/// its install in the first pane took 11.6 s of the first result's ~47 s (macOS VM, 2026-10-08).
/// Its installer needs only `curl`, not the Node and Harness CLI that setup is installing, so it
/// runs beside them. An OpenCode create waits for it, for at most the rest of a budget counted
/// from the download's start ([waitFor]); a second run of the same installer after that is
/// harmless (each run unpacks into a temp folder of its own and renames the whole binary into
/// `~/.opencode/bin`). The command is the CLI's recipe (`cli/src/lib/engineInstall.ts`, held to it
/// by `test/agent_prefetch_test.dart`) with `--no-modify-path`: Harness finds `~/.opencode/bin`
/// itself, and a background download must not put a second OpenCode ahead of one the person
/// already runs from their shell.
class AgentPrefetch {
  AgentPrefetch({
    Future<Process> Function(String executable, List<String> arguments)? start,
    bool Function()? skip,
    bool Function()? installed,
    void Function(String line)? log,
    DateTime Function()? now,
  }) : _start =
           start ??
           ((executable, arguments) => Process.start(executable, arguments)),
       _skip = skip ?? _alreadyHasAnAgent,
       _installed = installed ?? _openCodeDownloaded,
       _log = log ?? ((_) {}),
       _now = now ?? DateTime.now;

  /// The CLI's recipe line, and what this adds to it.
  static const recipe = 'curl -fsSL https://opencode.ai/install | bash';
  static const command = 'set -o pipefail; $recipe -s -- --no-modify-path';

  final Future<Process> Function(String executable, List<String> arguments)
  _start;
  final bool Function() _skip;
  final bool Function() _installed;
  final void Function(String line) _log;
  final DateTime Function() _now;
  Future<void>? _running;
  DateTime? _startedAt;
  bool _settled = false;

  /// Starts the download on a computer new to Harness and its agents. Once per app run.
  void start() {
    if (_running != null || _skip()) return;
    final started = _startedAt = _now();
    _running = () async {
      try {
        final process = await _start('/bin/bash', ['-c', command]);
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
        // Judged by the binary, as the CLI judges an install: an exit code alone says nothing
        // about which half of a pipeline failed.
        _log(
          code == 0 && _installed()
              ? 'OpenCode downloaded during setup in ${seconds.toStringAsFixed(1)}s'
              : 'OpenCode download during setup did not finish (exit $code, '
                    '${seconds.toStringAsFixed(1)}s); the first harness installs it instead: '
                    '${tail.join(' | ')}',
        );
      } catch (error) {
        _log('OpenCode download during setup did not start: $error');
      } finally {
        _settled = true;
      }
    }();
  }

  /// What an OpenCode create waits for: the download, for whatever is left of [budget] since it
  /// started. Null when there is nothing to wait for — none started, it finished, OpenCode is in
  /// place, or the budget is spent — so a slow download costs the first create at most [budget]
  /// and every later one nothing.
  Future<void>? waitFor(Duration budget) {
    final running = _running;
    final since = _startedAt;
    if (running == null || since == null || _settled || _installed()) {
      return null;
    }
    final left = budget - _now().difference(since);
    if (left <= Duration.zero) return null;
    return running.timeout(left, onTimeout: () {});
  }

  static String? get _home => Platform.environment['HOME'];

  static bool _openCodeDownloaded() {
    final home = _home;
    return home != null && File('$home/.opencode/bin/opencode').existsSync();
  }

  /// Nothing to download for: Harness has run here before (its CLI folder), or the person already
  /// has an agent. Claude Code or Codex (their folders, which any use of them leaves), or OpenCode
  /// in any place it installs to or has kept its data in. A false "new" costs a download, so this
  /// errs towards skipping.
  static bool _alreadyHasAnAgent() {
    final home = _home;
    if (home == null) return true;
    return [
      '$home/.harness/cli',
      '$home/.claude',
      '$home/.codex',
      '$home/.opencode/bin/opencode',
      '$home/.local/bin/opencode',
      '$home/.bun/bin/opencode',
      '$home/.config/opencode',
      '$home/.local/share/opencode',
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
    ].any(
      (path) =>
          FileSystemEntity.typeSync(path) != FileSystemEntityType.notFound,
    );
  }
}
