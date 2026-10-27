// A folder zipped for a Swarm chat holds only what is inside it, even when
// the folder changes between being listed and being read.
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/folder_read_io.dart';
import 'package:harness/super_tabs/folder_zip.dart';

void main() {
  late Directory root, src, outside;
  setUp(() {
    root = Directory.systemTemp.createTempSync('swarm-folder-zip');
    src = Directory('${root.path}/src')..createSync();
    outside = Directory('${root.path}/outside')..createSync();
  });
  tearDown(() => root.deleteSync(recursive: true));

  Map<String, String> entries(Uint8List zip) => {
    for (final entry in ZipDecoder().decodeBytes(zip).files)
      if (entry.isFile) entry.name: String.fromCharCodes(entry.content),
  };

  test('a file swapped for a link after the listing is left out', () {
    File('${src.path}/notes.txt').writeAsStringSync('mine');
    File('${src.path}/keep.txt').writeAsStringSync('kept');
    File('${outside.path}/secret.txt').writeAsStringSync('secret');

    final zip = zipFolderNow(
      src.path,
      limitBytes: 1 << 20,
      afterScan: () {
        File('${src.path}/notes.txt').deleteSync();
        Link('${src.path}/notes.txt').createSync('${outside.path}/secret.txt');
      },
    );

    expect(entries(zip!), {'src/keep.txt': 'kept'});
  });

  test('a folder swapped for a link after the listing is not read through', () {
    Directory('${src.path}/lib').createSync();
    File('${src.path}/lib/a.dart').writeAsStringSync('// a');
    File('${src.path}/keep.txt').writeAsStringSync('kept');
    File('${outside.path}/a.dart').writeAsStringSync('secret');

    final zip = zipFolderNow(
      src.path,
      limitBytes: 1 << 20,
      afterScan: () {
        Directory('${src.path}/lib').deleteSync(recursive: true);
        Link('${src.path}/lib').createSync(outside.path);
      },
    );

    expect(entries(zip!), {'src/keep.txt': 'kept'});
  });

  test('a file that grows past the limit after the listing is refused', () {
    File('${src.path}/log.txt').writeAsStringSync('small');

    final zip = zipFolderNow(
      src.path,
      limitBytes: 1024,
      afterScan: () =>
          File('${src.path}/log.txt')
              .writeAsBytesSync(List.filled(4096, 1), mode: FileMode.append),
    );

    expect(zip, isNull);
  });

  test('links already in the folder are left out', () {
    File('${src.path}/keep.txt').writeAsStringSync('kept');
    File('${outside.path}/secret.txt').writeAsStringSync('secret');
    Link('${src.path}/secret.txt').createSync('${outside.path}/secret.txt');
    Link('${src.path}/elsewhere').createSync(outside.path);

    expect(entries(zipFolderNow(src.path, limitBytes: 1 << 20)!), {
      'src/keep.txt': 'kept',
    });
  });

  group('read by path, as on Windows', () {
    test('a link in place of the file is not read', () {
      File('${outside.path}/secret.txt').writeAsStringSync('secret');
      Link('${src.path}/notes.txt').createSync('${outside.path}/secret.txt');

      expect(IoFolderFiles(src.path).read(['notes.txt'], 100), isNull);
    });

    test('a link in place of a folder on the way is not read through', () {
      File('${outside.path}/a.dart').writeAsStringSync('secret');
      Link('${src.path}/lib').createSync(outside.path);

      expect(IoFolderFiles(src.path).read(['lib', 'a.dart'], 100), isNull);
    });

    test('reads one byte past what is left, no more', () {
      File('${src.path}/log.txt').writeAsStringSync('0123456789');

      expect(
        String.fromCharCodes(IoFolderFiles(src.path).read(['log.txt'], 3)!),
        '0123',
      );
    });
  });
}
