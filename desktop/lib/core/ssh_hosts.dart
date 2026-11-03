import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'github_repository.dart';
import 'home_dir.dart';

/// `ssh -G <alias>`'s output, or null when ssh could not say.
typedef SshRunner = Future<String?> Function(List<String> arguments);

/// `ssh -G` prints a few KiB; more is not a configuration to trust.
const _maxOutputBytes = 64 * 1024;

/// The most of one config file read: a config is a few KiB, and a refused
/// clone must not stall on a file somebody pointed at something huge. The
/// daemon's sshHosts.ts reads the same.
const _maxConfigBytes = 256 * 1024;

/// The most host names asked about: each is an `ssh -G` run, as in the
/// daemon's sshHosts.ts.
const _maxAsked = 20;

/// The SSH host aliases of the computer this app runs on, read only when a
/// clone needs them. Mirrors cli/src/lib/sshHosts.ts, which answers the same
/// for the daemon's computer.
class SshHosts {
  SshHosts({String? home, SshRunner? runSsh})
    : _home = home ?? maybeHomeDir(),
      _runSsh = runSsh ?? _sshG;
  final String? _home;
  final SshRunner _runSsh;

  /// `ssh -G` prints the configuration an alias resolves to without
  /// connecting, so reading it costs no network and asks for nothing.
  static Future<String?> _sshG(List<String> arguments) async {
    final Process process;
    try {
      process = await Process.start('ssh', arguments);
    } on ProcessException {
      return null;
    }
    unawaited(process.stdin.close());
    unawaited(process.stderr.drain<void>());
    final output = process.stdout
        .transform(const Utf8Decoder(allowMalformed: true))
        .join();
    try {
      final code = await process.exitCode.timeout(const Duration(seconds: 4));
      final text = await output;
      return code == 0 && text.length <= _maxOutputBytes ? text : null;
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      return null;
    }
  }

  /// The host name [alias] stands for, or null. A name that could be read as
  /// an option never reaches ssh.
  Future<String?> resolveHost(String alias) async {
    if (!isSafeSshAlias(alias)) return null;
    final output = await _runSsh(['-G', alias]);
    if (output == null) return null;
    for (final line in const LineSplitter().convert(output)) {
      if (line.startsWith('hostname ')) {
        return line.substring('hostname '.length).trim().toLowerCase();
      }
    }
    return null;
  }

  /// The config's own host names that lead to github.com, in the order
  /// written, at most [maxCloneAliases]: a second GitHub account on one
  /// computer is reachable only through one of these.
  Future<List<String>> githubAliases() async {
    final home = _home;
    if (home == null) return const [];
    final found = <String>[];
    final names = (await _hostNames(p.join(home, '.ssh', 'config'), 0))
        .where((name) => name != 'github.com' && isSafeSshAlias(name))
        .toSet()
        .take(_maxAsked);
    for (final alias in names) {
      if (found.length == maxCloneAliases) break;
      if (isGitHubHost(await resolveHost(alias))) found.add(alias);
    }
    return found;
  }

  /// The `Host` names in [file], with each `Include` read in place, one
  /// level deep. Patterns (`*`, `?`, `!`) name no single host.
  Future<List<String>> _hostNames(String file, int depth) async {
    final String text;
    try {
      final handle = File(file);
      if (await handle.length() > _maxConfigBytes) return const [];
      text = await handle.readAsString();
    } on FileSystemException {
      return const [];
    }
    final names = <String>[];
    for (final raw in const LineSplitter().convert(text)) {
      final line = raw.trim();
      final match = RegExp(
        r'^(host|include)\s*(?:=\s*|\s)\s*(.+)$',
        caseSensitive: false,
      ).firstMatch(line);
      if (match == null) continue;
      // `Host "gh-personal"`: ssh takes a quoted name as the name.
      final values = [
        for (final value in match.group(2)!.split(RegExp(r'\s+')))
          value.replaceAll('"', ''),
      ];
      if (match.group(1)!.toLowerCase() == 'host') {
        names.addAll(values.where((v) => !RegExp(r'[*?!]').hasMatch(v)));
      } else if (depth == 0) {
        for (final pattern in values) {
          for (final included in await _expand(pattern)) {
            names.addAll(await _hostNames(included, depth + 1));
          }
        }
      }
    }
    return names;
  }

  /// An `Include` argument as ssh reads it: `~` is home, a relative path is
  /// under `~/.ssh`, and `*` or `?` in the last segment match its folder's
  /// files.
  Future<List<String>> _expand(String pattern) async {
    final home = _home!;
    final path = pattern.startsWith('~/')
        ? p.join(home, pattern.substring(2))
        : p.isAbsolute(pattern)
        ? pattern
        : p.join(home, '.ssh', pattern);
    final name = p.basename(path);
    if (!name.contains('*') && !name.contains('?')) return [path];
    final glob = RegExp.escape(name)
        .replaceAll(r'\*', '.*')
        .replaceAll(r'\?', '.');
    final matcher = RegExp('^$glob\$');
    try {
      final entries = await Directory(p.dirname(path)).list().toList();
      return [
        for (final entry in entries)
          if (entry is File && matcher.hasMatch(p.basename(entry.path)))
            entry.path,
      ]..sort();
    } on FileSystemException {
      return const [];
    }
  }
}
