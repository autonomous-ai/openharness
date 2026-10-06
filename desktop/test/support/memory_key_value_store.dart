import 'package:harness/core/local_key_value_store.dart';

/// A [LocalKeyValueStore] that keeps everything in [values], for tests that
/// must not touch `~/.harness` or browser storage.
class MemoryKeyValueStore implements LocalKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
