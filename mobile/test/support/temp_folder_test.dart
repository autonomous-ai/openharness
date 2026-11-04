import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';

import 'temp_folder.dart';

/// A teardown's delete while something the test started is still writing into the folder (batch #2952: a Swarm
/// Home save landing as `memoryHomeCache`'s folder went, 'Directory not empty').
void main() {
  test('a folder something still writes into is deleted, whatever lands while it goes', () async {
    for (var round = 0; round < 20; round++) {
      final dir = Directory.systemTemp.createTempSync('temp-folder-race');
      final path = dir.path;
      // Another thread writes files into it as fast as it can for a moment, as a save on its way does, and stops once
      // the folder is gone.
      final writer = Isolate.run(() {
        final end = DateTime.now().add(const Duration(milliseconds: 300));
        var i = 0;
        while (DateTime.now().isBefore(end)) {
          try {
            File('$path/late-$i.next').writeAsStringSync('x' * 512);
            i++;
          } on FileSystemException {
            return i;
          }
        }
        return i;
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(() => deleteTempFolder(dir), returnsNormally, reason: 'round $round');
      await writer;
      expect(dir.existsSync(), isFalse, reason: 'round $round');
    }
  });

  test('a folder already gone is no failure', () {
    final dir = Directory.systemTemp.createTempSync('temp-folder-gone')..deleteSync();
    expect(() => deleteTempFolder(dir), returnsNormally);
  });
}
