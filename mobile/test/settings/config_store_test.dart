import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/settings/config_store.dart';

/// The connection settings the phone reads once, at the top of every launch
/// (`AppNotifier.bootstrap`), before it knows which backend to sign in to.
///
/// Persistence and reset contracts are exercised against an isolated in-memory store.
void main() {
  test('before anything is read it points at production', () {
    // Touches the shared file store's constructor only — no read, no IO.
    final config = ConfigStore().config;
    expect(config.apiBaseUrl, ConfigStore.defaultBaseUrl);
    expect(config.autonomousEnv, 'prod');
  });

  test('nothing saved: production', () async {
    final store = ConfigStore(storage: _Store({}));
    final config = await store.load();
    expect(config.apiBaseUrl, ConfigStore.defaultBaseUrl);
    expect(config.autonomousEnv, 'prod');
  });

  test('what was saved comes back, in one batched read', () async {
    final storage = _Store({
      'app_api_base_url': 'https://staging.example',
      'app_autonomous_environment': 'stag',
    });
    final store = ConfigStore(storage: storage);
    final config = await store.load();
    expect(config.apiBaseUrl, 'https://staging.example');
    expect(config.autonomousEnv, 'stag');
    expect(store.config.apiBaseUrl, 'https://staging.example');
    // `readMany`, never two reads: each read on the real store takes the
    // file lock and re-parses `state.json` on the launch path.
    expect(storage.batches, 1);
    expect(storage.reads, 0);
  });

  test('saved connection choices survive a fresh store', () async {
    final storage = _Store({});
    final store = ConfigStore(storage: storage);
    await store.save('https://private-backend.example');
    await store.saveEnvironment('stag');
    final restored = await ConfigStore(storage: storage).load();
    expect(restored.apiBaseUrl, 'https://private-backend.example');
    expect(restored.autonomousEnv, 'stag');
    await store.saveEnvironment('unknown');
    expect((await ConfigStore(storage: storage).load()).autonomousEnv, 'prod');
  });

  test('reset removes connection and legacy settings, preserving other preferences', () async {
    final storage = _Store({
      'terminal_font_size': '18',
      'app_api_base_url': 'https://staging.example',
      'app_autonomous_environment': 'stag',
      'skipped_desktop_update_version': 'old',
      'environment_setup_version': 'old',
    });
    final store = ConfigStore(storage: storage);
    await store.load();
    await store.reset();
    expect(storage.values, {'terminal_font_size': '18'});
    expect(store.config.apiBaseUrl, ConfigStore.defaultBaseUrl);
    expect(store.config.autonomousEnv, 'prod');
  });

  test('an environment that is not staging is production', () async {
    final store = ConfigStore(
      storage: _Store({'app_autonomous_environment': 'Stag '}),
    );
    final config = await store.load();
    expect(config.autonomousEnv, 'prod');
  });
}

/// An in-memory `state.json` that counts how it was asked.
class _Store implements BatchLocalKeyValueStore {
  _Store(this.values);

  final Map<String, String> values;
  int batches = 0;
  int reads = 0;

  @override
  Future<Map<String, String?>> readMany(Iterable<String> keys) async {
    batches++;
    return {for (final key in keys) key: values[key]};
  }

  @override
  Future<String?> read(String key) async {
    reads++;
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
