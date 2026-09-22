import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

/// The name the person gave this phone, remembered across launches — what a
/// desktop it takes a terminal from will call it (`core/device_name.dart`).
/// Null means "whatever the OS says": the row in Settings shows that name
/// then, and clearing the field goes back to it. Loaded by
/// `loadPersistedSettings()` before the first frame.
class PhoneNameStore extends ValueNotifier<String?> {
  PhoneNameStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(null);

  static const _key = 'phone_name';

  final LocalKeyValueStore _storage;

  Future<void> load() async {
    try {
      final saved = await _storage.read(_key);
      final clean = saved?.trim();
      if (clean != null && clean.isNotEmpty) value = clean;
    } on Exception {
      // The OS's name still works; only the memory is missing.
    }
  }

  /// Empty or blank forgets the override.
  Future<void> rename(String? name) async {
    final clean = name?.trim();
    final next = clean == null || clean.isEmpty ? null : clean;
    if (next == value) return;
    value = next;
    try {
      if (next == null) {
        await _storage.delete(_key);
      } else {
        await _storage.write(_key, next);
      }
    } on Exception {
      // Kept in memory for this run.
    }
  }
}

final phoneNameStore = PhoneNameStore();
