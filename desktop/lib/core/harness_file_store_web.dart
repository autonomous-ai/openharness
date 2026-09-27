import 'package:web/web.dart' as web;

import 'browser_lock.dart';
import 'local_key_value_store.dart';

/// The browser adapter behind the same state-store entry point as desktop.
/// Sign-in, machine identity, links, and preferences persist on this origin.
/// OAuth transactions stay tab-local in DirectLogin. Storage failures propagate.
class HarnessFileStore
    implements BatchLocalKeyValueStore, SynchronizedLocalKeyValueStore {
  static final HarnessFileStore shared = HarnessFileStore();
  static const _prefix = 'harness.web.v1.';
  static const _migrated = '${_prefix}persistent_credentials';
  static const _credentials = [
    'auth_access_token',
    'auth_refresh_token',
    'auth_autonomous_env',
    'auth_access_token_expires_at',
    'viewer_e2ee_identity_seed',
    'viewer_e2ee_machine_peers',
  ];
  Future<void>? _migration;

  Future<void>
  _ready() => _migration ??= withBrowserLock('migration', () async {
    final local = web.window.localStorage;
    final legacy = web.window.sessionStorage;
    if (local.getItem(_migrated) == null &&
        _credentials.any((key) => legacy.getItem('$_prefix$key') != null)) {
      for (final key in _credentials) {
        final value = legacy.getItem('$_prefix$key');
        if (value != null) local.setItem('$_prefix$key', value);
      }
      local.setItem(_migrated, '1');
    }
    // An old tab must never resurrect credentials after a subsequent sign-out.
    for (final key in _credentials) {
      legacy.removeItem('$_prefix$key');
    }
  });

  @override
  Future<String?> read(String key) async {
    await _ready();
    return web.window.localStorage.getItem('$_prefix$key');
  }

  @override
  Future<Map<String, String?>> readMany(Iterable<String> keys) async {
    await _ready();
    return {
      for (final key in keys)
        key: web.window.localStorage.getItem('$_prefix$key'),
    };
  }

  @override
  Future<void> write(String key, String value) async {
    await _ready();
    void write() {
      if (_credentials.contains(key)) {
        web.window.localStorage.setItem(_migrated, '1');
      }
      web.window.localStorage.setItem('$_prefix$key', value);
    }

    if (_credentials.contains(key)) {
      await withBrowserLock('migration', () async => write());
    } else {
      write();
    }
  }

  @override
  Future<void> delete(String key) async {
    await _ready();
    void remove() {
      if (_credentials.contains(key)) {
        web.window.localStorage.setItem(_migrated, '1');
      }
      web.window.localStorage.removeItem('$_prefix$key');
      web.window.sessionStorage.removeItem('$_prefix$key');
    }

    if (_credentials.contains(key)) {
      await withBrowserLock('migration', () async => remove());
    } else {
      remove();
    }
  }

  @override
  Future<T> synchronized<T>(String scope, Future<T> Function() action) =>
      withBrowserLock(scope, action);

  /// Native-only services must never turn a browser path into a local file.
  static String defaultDirectoryPath({
    Map<String, String>? environment,
    String? name,
  }) => throw UnsupportedError('The browser has no Harness home directory.');
}
