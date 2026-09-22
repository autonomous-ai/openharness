import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'models.dart';

/// Compatibility for this computer's older daemon. Reads only Git metadata;
/// directory watches invalidate the cache when a checkout or remote changes.
/// No Git processes, network calls, terminal reads, or work on the render path.
class LocalGitProjects {
  LocalGitProjects({required this.onChanged, DateTime Function()? now})
    : _now = now ?? DateTime.now;
  final void Function() onChanged;
  final DateTime Function() _now;
  static const _cacheAge = Duration(minutes: 1);
  final _entries = <String, _LocalGitEntry>{};
  bool _disposed = false;

  AgentProject? cached(String cwd) => _entries[cwd]?.project;

  Future<void> read(String cwd) {
    if (_disposed || !p.isAbsolute(cwd)) return Future.value();
    final existing = _entries[cwd];
    if (existing != null) {
      if (existing.pending != null) return existing.pending!;
      // Even a live watcher can miss a rename or a coalesced OS event. Check
      // again on ordinary discovery after the TTL; there is no polling timer.
      if (_now().difference(existing.checkedAt) < _cacheAge) {
        return Future.value();
      }
      return _refresh(cwd, existing);
    }
    if (_entries.length >= 256) {
      _entries.remove(_entries.keys.first)?.dispose();
    }
    final entry = _LocalGitEntry();
    _entries[cwd] = entry;
    return _refresh(cwd, entry);
  }

  Future<void> _refresh(String cwd, _LocalGitEntry entry) {
    if (_disposed || entry.disposed) return Future.value();
    if (entry.pending != null) {
      entry.dirty = true;
      return entry.pending!;
    }
    return entry.pending = _refreshEntry(cwd, entry);
  }

  Future<void> _refreshEntry(String cwd, _LocalGitEntry entry) async {
    try {
      do {
        entry.dirty = false;
        await _resolve(cwd, entry);
      } while (entry.dirty && !_disposed && !entry.disposed);
    } finally {
      entry.checkedAt = _now();
      entry.pending = null;
    }
  }

  Future<void> _resolve(String cwd, _LocalGitEntry entry) async {
    final targets = <String, Set<String>>{};
    void watch(String directory, Set<String> names) =>
        (targets[directory] ??= {}).addAll(names);
    try {
      if (!await Directory(cwd).exists()) {
        _publish(entry, null);
        return;
      }
      watch(p.normalize(cwd), {'.git'});
      var root = p.normalize(cwd);
      String? gitDir;
      for (var depth = 0; depth < 32; depth++) {
        final marker = p.join(root, '.git');
        final type = await FileSystemEntity.type(marker);
        if (type == FileSystemEntityType.directory) {
          gitDir = marker;
          break;
        }
        if (type == FileSystemEntityType.file) {
          targets.clear();
          watch(root, {'.git'});
          final pointer = await _text(marker);
          if (pointer?.startsWith('gitdir: ') == true) {
            final path = pointer!.substring(8).trim();
            if (path.isNotEmpty) gitDir = p.normalize(p.join(root, path));
          }
          break;
        }
        final parent = p.dirname(root);
        if (parent == root) break;
        root = parent;
      }
      if (gitDir == null) {
        _publish(entry, null);
        return;
      }
      // The working tree owns the .git pointer (and directory replacement),
      // while HEAD/config may live elsewhere. Keep watching that connection.
      targets.clear();
      watch(root, {'.git'});
      if (!await Directory(gitDir).exists()) {
        _publish(entry, null);
        return;
      }
      watch(gitDir, {'HEAD', 'commondir'});
      final shared = await _text(p.join(gitDir, 'commondir'));
      final common = shared == null
          ? gitDir
          : p.normalize(p.join(gitDir, shared.trim()));
      watch(common, {'config'});
      final head = (await _text(p.join(gitDir, 'HEAD')))?.trim();
      final config = await _text(p.join(common, 'config'));
      if (_disposed || entry.disposed) return;
      final branch = head?.startsWith('ref: refs/heads/') == true
          ? head!.substring(16)
          : head != null && RegExp(r'^[a-fA-F0-9]{40,64}$').hasMatch(head)
          ? 'Detached ${head.substring(0, 7)}'
          : null;
      final project = AgentProject.fromJson({
        // A linked worktree is named for its repository, not its folder.
        'name': p.basename(common) == '.git'
            ? p.basename(p.dirname(common))
            : p.basename(root),
        'cwd': cwd,
        'root': root,
        'remote': _origin(config),
        'branch': branch,
        'worktree': shared != null,
        'branchPending':
            branch != null && _placeholder(config, branch) == 'placeholder',
      });
      _publish(entry, project);
    } on FileSystemException {
      // A removed/unreadable working folder must not interfere with discovery.
      _publish(entry, null);
    } finally {
      if (!_disposed && !entry.disposed) _syncWatches(cwd, entry, targets);
    }
  }

  void _publish(_LocalGitEntry entry, AgentProject? project) {
    if (_disposed || entry.disposed || entry.project == project) return;
    entry.project = project;
    onChanged();
  }

  void _invalidate(String cwd, _LocalGitEntry entry) {
    if (_disposed || entry.disposed) return;
    entry.debounce?.cancel();
    entry.debounce = Timer(const Duration(milliseconds: 100), () {
      entry.debounce = null;
      unawaited(_refresh(cwd, entry));
    });
  }

  void _syncWatches(
    String cwd,
    _LocalGitEntry entry,
    Map<String, Set<String>> targets,
  ) {
    entry.watchTargets = targets;
    for (final directory in entry.watchers.keys.toList()) {
      if (!targets.containsKey(directory)) {
        unawaited(entry.watchers.remove(directory)!.cancel());
      }
    }
    entry.retryWatchAt.removeWhere((path, _) => !targets.containsKey(path));
    for (final directory in targets.keys) {
      if (entry.watchers.containsKey(directory) ||
          entry.retryWatchAt[directory]?.isAfter(_now()) == true) {
        continue;
      }
      late StreamSubscription<FileSystemEvent> subscription;
      void lost() {
        if (_disposed ||
            entry.disposed ||
            entry.watchers[directory] != subscription) {
          return;
        }
        entry.watchers.remove(directory);
        unawaited(subscription.cancel());
        // Refresh the data once, but wait for later discovery to retry a
        // failed watch. A permanently unavailable watcher must not loop.
        entry.retryWatchAt[directory] = _now().add(_cacheAge);
        _invalidate(cwd, entry);
      }

      bool related(String path) =>
          p.normalize(path) == directory ||
          entry.watchTargets[directory]?.contains(p.basename(path)) == true;
      try {
        subscription = Directory(directory).watch().listen(
          (event) {
            if (_disposed ||
                entry.disposed ||
                entry.watchers[directory] != subscription) {
              return;
            }
            if (related(event.path) ||
                event is FileSystemMoveEvent &&
                    event.destination != null &&
                    related(event.destination!)) {
              if (event.isDirectory &&
                  (event is FileSystemCreateEvent ||
                      event is FileSystemDeleteEvent ||
                      event is FileSystemMoveEvent)) {
                // A replacement can reuse the path while the OS watch still
                // follows the old directory. Rebind those subscriptions.
                final changed = {
                  p.normalize(event.path),
                  if (event is FileSystemMoveEvent && event.destination != null)
                    p.normalize(event.destination!),
                };
                for (final watched in entry.watchers.keys.toList()) {
                  if (changed.any(
                    (path) => path == watched || p.isWithin(path, watched),
                  )) {
                    unawaited(entry.watchers.remove(watched)!.cancel());
                    entry.retryWatchAt.remove(watched);
                  }
                }
              }
              _invalidate(cwd, entry);
            }
          },
          onError: (Object _) => lost(),
          onDone: lost,
          cancelOnError: true,
        );
        entry.watchers[directory] = subscription;
        entry.retryWatchAt.remove(directory);
      } on FileSystemException {
        entry.retryWatchAt[directory] = _now().add(_cacheAge);
      } on UnsupportedError {
        entry.retryWatchAt[directory] = _now().add(_cacheAge);
      }
    }
  }

  Future<String?> _text(String path) async {
    try {
      final file = await File(path).open();
      try {
        // Bound the read itself, including a file growing during discovery.
        final bytes = await file.read(64 * 1024 + 1);
        return bytes.length <= 64 * 1024 ? utf8.decode(bytes) : null;
      } finally {
        await file.close();
      }
    } on FileSystemException {
      return null;
    } on FormatException {
      return null;
    }
  }

  /// `branch.<name>.harness` from the repository's config: `placeholder`
  /// while Harness's made-up name waits for the session's.
  String? _placeholder(String? config, String branch) {
    if (config == null) return null;
    var inBranch = false;
    for (final line in config.split('\n')) {
      final text = line.trim();
      if (text.startsWith('[')) {
        inBranch = text == '[branch "$branch"]';
      } else if (inBranch) {
        final match = RegExp(
          r'^harness\s*=\s*(\S+)$',
          caseSensitive: false,
        ).firstMatch(text);
        if (match != null) return match.group(1);
      }
    }
    return null;
  }

  String? _origin(String? config) {
    if (config == null) return null;
    var origin = false;
    for (final line in config.split('\n')) {
      final text = line.trim();
      if (text.startsWith('[')) {
        origin = RegExp(
          r'^\[remote\s+"origin"\]$',
          caseSensitive: false,
        ).hasMatch(text);
      } else if (origin) {
        final match = RegExp(
          r'^url\s*=\s*(.+)$',
          caseSensitive: false,
        ).firstMatch(text);
        if (match != null) return canonicalGitRemote(match.group(1)!);
      }
    }
    return null;
  }

  void dispose() {
    _disposed = true;
    for (final entry in _entries.values) {
      entry.dispose();
    }
    _entries.clear();
  }
}

String? canonicalGitRemote(String raw) {
  raw = raw.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.substring(1, raw.length - 1);
  }
  final scp = RegExp(r'^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$').firstMatch(raw);
  final uri = Uri.tryParse(
    scp != null && !raw.contains('://')
        ? 'ssh://${scp.group(1)}/${scp.group(2)}'
        : raw,
  );
  if (uri == null ||
      !{'ssh', 'https', 'http', 'git'}.contains(uri.scheme) ||
      uri.host.isEmpty) {
    return null;
  }
  var path = uri.path
      .replaceAll(RegExp(r'^/+|/+$'), '')
      .replaceFirst(RegExp(r'\.git$', caseSensitive: false), '');
  if (path.isEmpty || RegExp(r'[\x00-\x20]').hasMatch(path)) return null;
  final host = uri.host.toLowerCase();
  if (host == 'github.com' || host == 'bitbucket.org') {
    path = path.toLowerCase();
  }
  final defaultPort = switch (uri.scheme) {
    'ssh' => 22,
    'git' => 9418,
    'https' => 443,
    _ => 80,
  };
  final port = uri.hasPort && uri.port != defaultPort ? ':${uri.port}' : '';
  return '$host$port/$path';
}

class _LocalGitEntry {
  DateTime checkedAt = DateTime.fromMillisecondsSinceEpoch(0);
  AgentProject? project;
  Future<void>? pending;
  bool dirty = false;
  final watchers = <String, StreamSubscription<FileSystemEvent>>{};
  Map<String, Set<String>> watchTargets = {};
  final retryWatchAt = <String, DateTime>{};
  Timer? debounce;
  bool disposed = false;
  void dispose() {
    disposed = true;
    debounce?.cancel();
    for (final watcher in watchers.values) {
      unawaited(watcher.cancel());
    }
    watchers.clear();
  }
}
