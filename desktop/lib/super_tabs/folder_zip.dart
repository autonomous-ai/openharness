import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart' as p;

import 'folder_read.dart';

/// What a folder dropped into a chat is called: its own name, as its zip and
/// the hint name it.
String folderName(String path) {
  final name = p.basename(path);
  return name.isEmpty ? 'folder' : name;
}

/// [folder] as a zip whose entries sit under the folder's own name, worked on
/// a background isolate. Null when its files weigh more than [limitBytes]
/// together: they are counted before any is read, so a large folder is never
/// held in memory, and counted again as they are read, so one that grew since
/// is not either. Links are left out rather than followed, also when one takes
/// a file's or folder's place while the zip runs, so nothing from outside the
/// folder goes into it.
Future<Uint8List?> zipFolder(String folder, {required int limitBytes}) =>
    Isolate.run(() => zipFolderNow(folder, limitBytes: limitBytes));

/// [zipFolder] on this isolate. [afterScan] runs between listing the folder
/// and reading its files, where a test changes the folder underneath.
@visibleForTesting
Uint8List? zipFolderNow(
  String folder, {
  required int limitBytes,
  void Function()? afterScan,
}) {
  final name = folderName(folder);
  final opened = openFolder(folder);
  try {
    final files = <List<String>>[];
    var total = 0;
    for (final entity in Directory(
      folder,
    ).listSync(recursive: true, followLinks: false)) {
      if (entity is! File) continue;
      total += entity.lengthSync();
      if (total > limitBytes) return null;
      files.add(p.split(p.relative(entity.path, from: folder)));
    }
    afterScan?.call();
    final archive = Archive();
    var left = limitBytes;
    for (final inside in files) {
      final bytes = opened.read(inside, left);
      if (bytes == null) continue;
      left -= bytes.length;
      if (left < 0) return null;
      archive.addFile(
        ArchiveFile.bytes(p.posix.joinAll([name, ...inside]), bytes),
      );
    }
    return ZipEncoder().encodeBytes(archive);
  } finally {
    opened.close();
  }
}
