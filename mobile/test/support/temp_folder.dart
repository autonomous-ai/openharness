import 'dart:io';

/// Deletes [dir] and everything in it, for a test's teardown (task #2759). Plain for now.
void deleteTempFolder(Directory dir) {
  if (dir.existsSync()) dir.deleteSync(recursive: true);
}
