import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Downloads OpenCode while a fresh computer is being prepared, so the first harness does not
/// install it in its pane.
///
/// OpenCode is the agent a new person without Claude Code or Codex starts on, and on a fresh Mac
/// its install in the first pane took 11.6 s of the first result's ~47 s (macOS VM, 2026-10-08).
/// Its installer needs only `curl`, not the Node and Harness CLI that setup is installing, so it
/// runs beside them. The desktop holds an OpenCode create until it settles
/// ([AppNotifier.createAgent]); a second run of the same installer is harmless if the wait gives
/// up (each run unpacks into a temp folder of its own and renames the whole binary into
/// `~/.opencode/bin`). The command is the CLI's own recipe (`cli/src/lib/engineInstall.ts`).
class AgentPrefetch {
  AgentPrefetch({
    Future<Process> Function(String executable, List<String> arguments)? start,
    bool Function()? installed,
    void Function(String line)? log,
  }) : _start =
           start ??
           ((executable, arguments) => Process.start(executable, arguments)),
       _installed = installed ?? _openCodeInstalled,
       _log = log ?? ((_) {});

  static const command = 'curl -fsSL https://opencode.ai/install | bash';

  final Future<Process> Function(String executable, List<String> arguments)
  _start;
  final bool Function() _installed;
  final void Function(String line) _log;
  Future<void>? _running;

  /// Settles when the download has finished either way; null when none was started.
  Future<void>? get pending => _running;

  /// Starts the download unless OpenCode is already where Harness looks for it. Once per app run.
  void start() {
    if (_running != null || _installed()) return;
    final started = DateTime.now();
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
        final seconds =
            DateTime.now().difference(started).inMilliseconds / 1000;
        _log(
          code == 0
              ? 'OpenCode downloaded during setup in ${seconds.toStringAsFixed(1)}s'
              : 'OpenCode download during setup exited $code after ${seconds.toStringAsFixed(1)}s '
                    '(the first harness installs it instead): ${tail.join(' | ')}',
        );
      } catch (error) {
        _log('OpenCode download during setup did not start: $error');
      }
    }();
  }

  /// Where the CLI's recipe finds OpenCode without a login shell: its installer's folder and the two
  /// Homebrew prefixes. An npm or nvm install elsewhere is found by the daemon's probe instead, and
  /// downloading a second copy there costs disk, not correctness.
  static bool _openCodeInstalled() {
    final home = Platform.environment['HOME'];
    return [
      if (home != null) '$home/.opencode/bin/opencode',
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
    ].any((path) => File(path).existsSync());
  }
}
