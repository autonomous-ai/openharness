import 'dart:io';

/// Deletes a test's temp [folder] and everything in it.
Future<void> deleteTempFolder(Directory folder) async =>
    folder.deleteSync(recursive: true);
