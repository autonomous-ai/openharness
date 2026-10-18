import 'dart:io';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import 'product_measurement.dart';

/// One local preference, without identifiers or activity. Unlike a disposable
/// cache, an unreadable file must throw so the collector can keep sharing off.
class SetupPreferenceStore implements LocalKeyValueStore {
  SetupPreferenceStore({Directory? directory})
    : file = File(
        '${(directory ?? Directory(HarnessFileStore.defaultDirectoryPath())).path}/setup-sharing.json',
      );

  final File file;

  @override
  Future<String?> read(String key) async {
    try {
      return (await file.readAsString()).trim();
    } on FileSystemException catch (error) {
      if (error.osError?.errorCode == 2) {
        return null; // Only a missing file is a default.
      }
      rethrow;
    }
  }

  @override
  Future<void> write(String key, String value) async {
    if (value != 'true' &&
        value != 'false' &&
        value != ProductMeasurement.pendingSetupOptOut) {
      throw const FormatException('Invalid setup sharing preference');
    }
    await file.parent.create(recursive: true);
    final temporary = File(
      '${file.path}.${pid}_${DateTime.now().microsecondsSinceEpoch}.tmp',
    );
    try {
      await temporary.writeAsString(value, flush: true);
      await temporary.rename(file.path);
    } finally {
      if (await temporary.exists()) await temporary.delete();
    }
  }

  @override
  Future<void> delete(String key) async {
    // Forgetting a privacy choice must not silently restore default-on sharing.
    await write(key, 'false');
  }
}
