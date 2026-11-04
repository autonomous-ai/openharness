import 'dart:io';

/// Deletes a test's temp [folder] and everything in it. What the test started
/// can still be writing there (a Home kept, a picture fetched): a file landing
/// mid-delete fails it with 'Directory not empty' (task #2759), so it tries
/// again, for a second or more, until that writing stops, and fails as before
/// if it never does.
Future<void> deleteTempFolder(Directory folder) async {
  for (var attempt = 1; ; attempt++) {
    try {
      folder.deleteSync(recursive: true);
      return;
    } on FileSystemException {
      if (!folder.existsSync()) return;
      if (attempt == 50) rethrow;
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
  }
}
