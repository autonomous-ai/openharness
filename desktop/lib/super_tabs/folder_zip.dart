import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;

/// What a folder dropped into a chat is called: its own name, as its zip and
/// the hint name it.
String folderName(String path) {
  final name = p.basename(path);
  return name.isEmpty ? 'folder' : name;
}

/// [folder] as a zip whose entries sit under the folder's own name, worked on
/// a background isolate. Null when its files weigh more than [limitBytes]
/// together: they are counted before any is read, so a large folder is never
/// held in memory. Links are left out rather than followed, so nothing from
/// outside the folder goes into it.
Future<Uint8List?> zipFolder(String folder, {required int limitBytes}) =>
    Isolate.run(() => _zip(folder, limitBytes));

Uint8List? _zip(String folder, int limitBytes) {
  final root = Directory(folder);
  final name = folderName(folder);
  final files = <File>[];
  var total = 0;
  for (final entity in root.listSync(recursive: true, followLinks: false)) {
    if (entity is! File) continue;
    total += entity.lengthSync();
    if (total > limitBytes) return null;
    files.add(entity);
  }
  final archive = Archive();
  for (final file in files) {
    final inside = p.split(p.relative(file.path, from: root.path));
    archive.addFile(
      ArchiveFile.bytes(
        p.posix.joinAll([name, ...inside]),
        file.readAsBytesSync(),
      ),
    );
  }
  return ZipEncoder().encodeBytes(archive);
}
