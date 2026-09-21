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
