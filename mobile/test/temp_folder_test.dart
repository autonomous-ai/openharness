import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';

import 'temp_folder.dart';

void main() {
  // What a test started can still be writing into its folder when it ends: a
  // recursive delete then meets a file it did not list, and failed the test
  // with 'Directory not empty' (task #2759).
  test(
    'a folder still being written into goes once the writing stops',
    () async {
      final folder = Directory.systemTemp.createTempSync('temp-folder');
      final path = folder.path;
      // Enough already there that the delete is still going when files land.
      for (var i = 0; i < 1000; i++) {
        File('$path/kept-$i').writeAsStringSync('x');
      }
      final writing = Isolate.run(() {
        for (var i = 0; i < 100; i++) {
          try {
            File('$path/$i').writeAsStringSync('x');
          } on FileSystemException {
            return; // The folder went.
          }
        }
      });
      addTearDown(() async {
        await writing;
        if (folder.existsSync()) folder.deleteSync(recursive: true);
      });
      while (!File('$path/0').existsSync()) {
        await Future<void>.delayed(Duration.zero);
      }

      await deleteTempFolder(folder);
      await writing;

      expect(folder.existsSync(), isFalse);
    },
  );
}
