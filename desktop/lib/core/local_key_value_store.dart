abstract interface class LocalKeyValueStore {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

/// Stores that can read a group in one operation, preserving a single snapshot.
abstract interface class BatchLocalKeyValueStore implements LocalKeyValueStore {
  /// Returns only the requested keys. Missing values are represented by null.
  Future<Map<String, String?>> readMany(Iterable<String> keys);
}

/// A store shared by independent runtimes, such as browser tabs.
abstract interface class SynchronizedLocalKeyValueStore
    implements LocalKeyValueStore {
  Future<T> synchronized<T>(String scope, Future<T> Function() action);
}

extension LocalKeyValueStoreSynchronization on LocalKeyValueStore {
  Future<T> synchronized<T>(String scope, Future<T> Function() action) {
    final store = this;
    return store is SynchronizedLocalKeyValueStore
        ? store.synchronized(scope, action)
        : action();
  }
}

extension LocalKeyValueStoreBatchRead on LocalKeyValueStore {
  /// Falls back to ordinary reads for stores without a batch operation.
  Future<Map<String, String?>> readMany(Iterable<String> keys) async {
    final store = this;
    if (store is BatchLocalKeyValueStore) return store.readMany(keys);
    final values = <String, String?>{};
    for (final key in keys.toSet()) {
      values[key] = await read(key);
    }
    return values;
  }
}
