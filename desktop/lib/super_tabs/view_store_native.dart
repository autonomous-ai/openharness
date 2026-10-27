import 'dart:io';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// Where Desktop keeps each Swarm's saved view: a file of its own beside the
/// app's `state.json`, which stays small because every setting rewrites it.
LocalKeyValueStore swarmViewStore() => HarnessFileStore(
  directory: Directory(
    '${HarnessFileStore.defaultDirectoryPath()}${Platform.pathSeparator}swarm-views',
  ),
);
