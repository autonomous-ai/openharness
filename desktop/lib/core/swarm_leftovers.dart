import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;

import '../logging/app_log.dart';
import 'harness_file_store.dart';

/// Clears what the Swarm left on this computer once it was removed
/// (2026-11-14): its settings (`super_tab.*` and `swarm_join_seen.*`), and
/// beside the settings file its saved chats (`swarm-views/`) and chat pictures
/// (`image-cache/`). Nothing else is touched: a project it cloned is the
/// person's work, and a link inside these folders is removed, never followed.
///
/// Runs at every launch, after the first frame; a launch with nothing left
/// reads the settings once. A failure is logged and never stops the app.
///
/// Remove on or after 2027-01-14, with [HarnessFileStore.keys] and
/// [HarnessFileStore.deleteAll] if nothing else uses them by then.
Future<void> clearSwarmLeftovers({
  HarnessFileStore? store,
  String? folder,
}) async {
  final settings = store ?? HarnessFileStore.shared;
  try {
    final gone = [
      for (final key in await settings.keys())
        if (key.startsWith('super_tab.') || key.startsWith('swarm_join_seen.'))
          key,
    ];
    if (gone.isNotEmpty) {
      await settings.deleteAll(gone);
      appLog.info('swarm-leftovers', 'removed ${gone.length} settings');
    }
  } on Object catch (error) {
    appLog.warn('swarm-leftovers', 'settings not removed: ${_why(error)}');
  }
  // A browser keeps no folders.
  if (kIsWeb) return;
  final String home;
  try {
    home = folder ?? HarnessFileStore.defaultDirectoryPath();
  } on StateError {
    return;
  }
  for (final name in const ['swarm-views', 'image-cache']) {
    try {
      await Directory('$home${Platform.pathSeparator}$name')
          .delete(recursive: true);
      appLog.info('swarm-leftovers', 'removed $name');
    } on PathNotFoundException {
      // Never made here, or already gone.
    } on FileSystemException catch (error) {
      appLog.warn('swarm-leftovers', '$name not removed: ${_why(error)}');
    }
  }
}

/// The reason alone: an error's path would name the person's home.
String _why(Object error) => switch (error) {
  FileSystemException(:final osError?) => osError.message,
  FileSystemException(:final message) when message.isNotEmpty => message,
  _ => error.runtimeType.toString(),
};
