import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// A browser keeps saved views in its own storage, as it always has.
LocalKeyValueStore swarmViewStore({LocalKeyValueStore? beside}) =>
    beside ?? HarnessFileStore.shared;
