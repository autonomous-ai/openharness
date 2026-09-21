import '../core/host_platform.dart';

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import 'keymap.dart';

/// Owns one dotfile. Invalid edits retain the last working keymap, and file
/// activity never performs work on the keyboard event path.
class KeymapStore extends ChangeNotifier {
  KeymapStore({
    required this.file,
    required Iterable<KeyBinding> defaults,
    required Set<String> commands,
    this.watchFiles = true,
    this.validate,
  }) : _defaults = List.unmodifiable(defaults),
       _commands = Set.unmodifiable(commands) {
    current = ResolvedKeymap(_defaults, const KeymapConfig.empty());
    validate?.call(current);
    _signature = _describe(current);
  }

  static const maximumBytes = 128 * 1024;
  final File file;
  final bool watchFiles;
  final void Function(ResolvedKeymap)? validate;
  final List<KeyBinding> _defaults;
  final Set<String> _commands;
  late ResolvedKeymap current;
  late String _signature;
  int revision = 0;
  String? _readError, _watchError;
  String? get error => _readError ?? _watchError;
  bool _disposed = false;
  int _generation = 0, _watchFailures = 0;
  final _watchers = <String, StreamSubscription<FileSystemEvent>>{};
  Set<String> _targets = {};
  Timer? _debounce;

  static String defaultPath({Map<String, String>? environment}) {
    final env = environment ?? Platform.environment;
    final xdg = env['XDG_CONFIG_HOME'];
    var home = env['HOME'] ?? env['USERPROFILE'];
    if (home == null || home.isEmpty) home = containerHome;
    final String root;
    if (xdg != null && p.isAbsolute(xdg)) {
      root = xdg;
    } else if (home != null && home.isNotEmpty) {
      root = p.join(home, '.config');
    } else {
      throw const FileSystemException(
        'No home directory for keyboard configuration',
      );
    }
    return p.join(root, 'harness', 'keybindings.jsonc');
  }

  Future<void> start() => reload();

  Future<void> reload({bool fromWatcher = false}) async {
    if (_disposed) return;
    if (!fromWatcher) _watchFailures = 0;
    final generation = ++_generation;
    final priorError = error;
    // Establish watches before reading or publishing the new map. Retargeting
    // a dotfile symlink can move it to a directory we do not watch yet; a save
    // between publication and subscription would otherwise be missed. Reading
    // after subscription also includes edits made during target discovery.
    if (watchFiles) await _refreshWatches(generation);
    if (_disposed || generation != _generation) return;
    var changed = false;
    try {
      String source;
      try {
        final bytes = await file
            .openRead(0, maximumBytes + 1)
            .fold(
              BytesBuilder(copy: false),
              (builder, chunk) => builder..add(chunk),
            );
        if (bytes.length > maximumBytes) {
          throw const FormatException('Keyboard config exceeds 128 KiB');
        }
        source = utf8.decode(bytes.takeBytes());
      } on FileSystemException catch (error) {
        if (!const {2, 3}.contains(error.osError?.errorCode)) rethrow;
        source = ''; // A missing file inherits defaults.
      }
      final next = ResolvedKeymap(
        _defaults,
        KeymapConfig.parse(source, commands: _commands),
      );
      validate?.call(next);
      if (_disposed || generation != _generation) return;
      final signature = _describe(next);
      if (_signature != signature) {
        current = next;
        _signature = signature;
        revision++;
        changed = true;
      }
      _readError = null;
    } catch (failure) {
      if (_disposed || generation != _generation) return;
      _readError = 'Keyboard config: $failure';
    }
    if (!_disposed &&
        generation == _generation &&
        (changed || priorError != error)) {
      notifyListeners();
    }
  }

  String _describe(ResolvedKeymap map) => [
    for (final context in KeymapContext.values)
      for (final binding in map.bindingsFor(context))
        '${context.name}:${binding.sequence}:${binding.command}:${binding.custom}',
  ].join('\n');

  Future<void> _refreshWatches(int generation) async {
    try {
      await _updateWatches(generation);
    } catch (failure) {
      if (_disposed || generation != _generation) return;
      _watchError = 'Could not watch keyboard config: $failure';
      if (++_watchFailures <= 3) {
        _scheduleReload(Duration(milliseconds: 200 * _watchFailures));
      }
    }
  }

  Future<void> _updateWatches(int generation) async {
    final targets = {p.normalize(file.absolute.path)};
    var linkPath = targets.first;
    for (var depth = 0; depth < 8; depth++) {
      try {
        if (await FileSystemEntity.type(linkPath, followLinks: false) !=
            FileSystemEntityType.link) {
          break;
        }
        final destination = await Link(linkPath).target();
        final next = p.normalize(
          p.isAbsolute(destination)
              ? destination
              : p.join(p.dirname(linkPath), destination),
        );
        if (!targets.add(next)) break;
        linkPath = next;
      } on FileSystemException {
        break;
      }
    }
    try {
      targets.add(p.normalize(await file.resolveSymbolicLinks()));
    } on FileSystemException {
      /* Missing file or target. */
    }
    final directories = <String>{};
    for (final target in targets.toList()) {
      var directory = Directory(p.dirname(target));
      final original = directory.path;
      while (!await directory.exists()) {
        final parent = directory.parent;
        if (parent.path == directory.path) break;
        directory = parent;
      }
      // Observe creation of missing config directories without watching an
      // entire filesystem root. No recursive subscriptions are needed.
      if (directory.parent.path != directory.path) {
        final canonical = await directory.resolveSymbolicLinks();
        targets.add(
          p.normalize(
            p.join(canonical, p.relative(target, from: directory.path)),
          ),
        );
        directories.add(canonical);
      }
      if (directory.path == original &&
          directory.parent.parent.path != directory.parent.path) {
        directories.add(await directory.parent.resolveSymbolicLinks());
      }
    }
    if (_disposed || generation != _generation) return;
    _targets = targets;
    for (final path
        in _watchers.keys
            .where((path) => !directories.contains(path))
            .toList()) {
      unawaited(_watchers.remove(path)!.cancel());
    }
    _watchError = directories.isEmpty
        ? 'Create the keyboard config directory to enable automatic reload.'
        : null;
    for (final path in directories) {
      if (_watchers.containsKey(path)) continue;
      late StreamSubscription<FileSystemEvent> subscription;
      void lost(Object? failure) {
        if (_disposed || _watchers[path] != subscription) return;
        _watchers.remove(path);
        unawaited(subscription.cancel());
        _watchError =
            'Keyboard config watch stopped. Reload to retry${failure == null ? '.' : ': $failure'}';
        notifyListeners();
        if (++_watchFailures <= 3) {
          _scheduleReload(Duration(milliseconds: 200 * _watchFailures));
        }
      }

      try {
        subscription = Directory(path).watch().listen(
          (event) {
            if (_related(event.path) ||
                event is FileSystemMoveEvent &&
                    event.destination != null &&
                    _related(event.destination!)) {
              if (event.isDirectory) {
                final changed = p.normalize(p.absolute(event.path));
                for (final watched
                    in _watchers.keys
                        .where(
                          (path) =>
                              path == changed || p.isWithin(changed, path),
                        )
                        .toList()) {
                  unawaited(_watchers.remove(watched)!.cancel());
                }
              }
              _watchFailures = 0;
              _scheduleReload(const Duration(milliseconds: 80));
            }
          },
          onError: (Object failure) => lost(failure),
          onDone: () => lost(null),
          cancelOnError: true,
        );
        _watchers[path] = subscription;
      } catch (failure) {
        _watchError = 'Could not watch keyboard config: $failure';
      }
    }
  }

  bool _related(String path) {
    final normalized = p.normalize(p.absolute(path));
    return _targets.any(
      (target) => target == normalized || p.isWithin(normalized, target),
    );
  }

  void _scheduleReload(Duration delay) {
    if (_disposed) return;
    _debounce?.cancel();
    _debounce = Timer(delay, () {
      _debounce = null;
      unawaited(reload(fromWatcher: true));
    });
  }

  /// Invoked only by the explicit Open Keyboard Config action. Starting the
  /// app never creates a dotfile or rewrites existing user configuration.
  Future<File> ensureFile() async {
    await file.parent.create(recursive: true);
    final handle = await file.open(mode: FileMode.append);
    try {
      await handle.lock(FileLock.exclusive);
      if (await handle.length() == 0) {
        await handle.writeString(
          '''// Harness keyboard overrides. Defaults are inherited.
// Save this file to apply changes. Invalid edits keep the last working keys.
// A null command unbinds a key or a sequence prefix.
// "when" can be "workspace" (default), "terminal", "picker", or "project".
// Workspace bindings are inherited by the other contexts.
{
  "version": 1,
  "bindings": [
    // Example: move New Tab from Command-T to Command-O.
    // { "keys": "cmd+t", "command": null },
    // { "keys": "cmd+o", "command": "swarm.new" },
  ],
}

// Available command names:
${(_commands.toList()..sort()).map((id) => '//   $id').join('\n')}
''',
        );
        await handle.flush();
      }
    } finally {
      await handle.close();
    }
    await reload();
    return file;
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _debounce?.cancel();
    for (final watcher in _watchers.values) {
      unawaited(watcher.cancel());
    }
    _watchers.clear();
    super.dispose();
  }
}
