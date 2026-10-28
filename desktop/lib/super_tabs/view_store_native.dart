import 'dart:convert';
import 'dart:io';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../core/snapshot_store.dart';
import '../logging/app_log.dart';
import 'saved_view.dart';

/// Where Desktop keeps each Swarm's saved view, given the app's settings store
/// [beside]: never in it. A store of another kind is a test's, which keeps
/// views with everything else.
LocalKeyValueStore swarmViewStore({LocalKeyValueStore? beside}) =>
    switch (beside) {
      null => SwarmViewFiles(HarnessFileStore.shared),
      final HarnessFileStore settings => SwarmViewFiles(settings),
      final other => other,
    };

/// Desktop's saved Swarm views ([SuperTabSavedViews]): each in a private file
/// of its own in `swarm-views/` beside the settings `state.json`, so keeping
/// one rewrites that view alone, and no setting, pane or theme write carries
/// any. Which Swarms an account keeps, and whose device this is, are a few
/// bytes in that folder's own `state.json`.
///
/// Desktop builds from 1.3.27 on wrote all of it into the settings document;
/// the first operation moves it out, once ([_moveOut]).
class SwarmViewFiles implements LocalKeyValueStore {
  SwarmViewFiles(this.settings)
    : directory = Directory(
        '${settings.directory.path}${Platform.pathSeparator}swarm-views',
      ) {
    _small = HarnessFileStore(directory: directory);
  }

  /// The app's settings document, which keeps no view.
  final HarnessFileStore settings;
  final Directory directory;
  late final HarnessFileStore _small;

  static bool _isView(String key) =>
      key.startsWith(SuperTabSavedViews.viewPrefix);

  static bool _isSaved(String key) =>
      _isView(key) ||
      key.startsWith(SuperTabSavedViews.indexKey('')) ||
      key == SuperTabSavedViews.ownerKey;

  /// One file per account and Swarm, named so no id can leave the folder.
  SnapshotStore _file(String key) {
    final id = key.substring(SuperTabSavedViews.viewPrefix.length);
    final name = base64Url.encode(utf8.encode(id)).replaceAll('=', '');
    return FileSnapshotStore('view.$name', directory: directory, private: true);
  }

  Future<void>? _moved;
  Future<void> _ready() => _moved ??= _moveOut();

  @override
  Future<String?> read(String key) async {
    await _ready();
    return _isView(key) ? _file(key).read() : _small.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    await _ready();
    return _isView(key) ? _file(key).write(value) : _small.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    await _ready();
    return _isView(key) ? _file(key).clear() : _small.delete(key);
  }

  /// Moves the views kept in a document into their files: first those in this
  /// folder's own, then those in the settings document. A failure leaves the
  /// rest where it was for the next launch.
  Future<void> _moveOut() async {
    try {
      await _moveFrom(_small);
      await _moveFrom(settings);
    } catch (error) {
      appLog.warn(
        'swarm',
        'saved views not moved out yet: ${error.runtimeType}',
      );
    }
  }

  /// Only the views of the account whose device this is, and only those its
  /// index lists, move; any other goes. An old key stays until its file is
  /// written, and a file already there (newer, or written before a stop) is
  /// kept. Then the old keys go.
  Future<void> _moveFrom(HarnessFileStore source) async {
    final own = identical(source, _small);
    final saved = (await source.keys()).where(own ? _isView : _isSaved).toList()
      // The views first: the document shrinks at the first rewrite.
      ..sort((a, b) => (_isView(a) ? 0 : 1) - (_isView(b) ? 0 : 1));
    if (saved.isEmpty) return;
    final values = await source.readMany(saved);
    final ownerKey = SuperTabSavedViews.ownerKey;
    final owner = await _small.read(ownerKey) ?? values[ownerKey];
    final indexKey = owner == null ? null : SuperTabSavedViews.indexKey(owner);
    final index = indexKey == null
        ? null
        : await _small.read(indexKey) ?? values[indexKey];
    final kept = {
      for (final tab in _tabs(index))
        '${SuperTabSavedViews.viewPrefix}$owner.$tab',
    };
    for (final key in saved.where(_isView)) {
      final value = values[key];
      if (value == null || !kept.contains(key)) continue;
      final file = _file(key);
      if (await file.read() != null) continue;
      await file.write(value);
      if (await file.read() != value) {
        throw FileSystemException('saved view not written', directory.path);
      }
    }
    if (!own && owner != null) {
      if (await _small.read(ownerKey) == null) {
        await _small.write(ownerKey, owner);
      }
      if (index != null && await _small.read(indexKey!) == null) {
        await _small.write(indexKey, index);
      }
    }
    for (final key in saved) {
      await source.delete(key);
    }
  }

  static List<String> _tabs(String? index) {
    if (index == null) return const [];
    try {
      return (jsonDecode(index) as List).whereType<String>().toList();
    } catch (_) {
      return const [];
    }
  }
}
