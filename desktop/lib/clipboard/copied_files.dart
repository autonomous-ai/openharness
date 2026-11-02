import 'dart:io';

import 'package:path/path.dart' as p;

import 'pasted_files.dart';

/// Files copied in a file manager, read off this computer's disk: those that
/// fit, the names of those that did not, and those left on disk to be read as
/// they are sent.
typedef CopiedFiles = ({
  List<PastedFile> files,
  List<String> tooLarge,
  List<CopiedFileOnDisk> onDisk,
});

/// A copied file too heavy to read now, weighed when it was pasted.
typedef CopiedFileOnDisk = ({String name, String path, int size});

/// Reads the files at [paths], which a clipboard named
/// ([NativeClipboard.readFilePaths]). A folder is left out, as is a file that
/// is gone or cannot be read. One over [maxBytes] is never read: a copied
/// video is not pulled into memory to be refused. It is named in `tooLarge`,
/// or with [keepOnDisk] listed in `onDisk` by its path and size, for a box
/// that sends large files from disk and refuses by size what it cannot take.
Future<CopiedFiles> readCopiedFiles(
  Iterable<String> paths, {
  required int maxBytes,
  bool keepOnDisk = false,
}) async {
  final files = <PastedFile>[];
  final tooLarge = <String>[];
  final onDisk = <CopiedFileOnDisk>[];
  for (final path in paths) {
    final name = p.basename(path);
    try {
      if (!await FileSystemEntity.isFile(path)) continue;
      final file = File(path);
      final size = await file.length();
      if (size > maxBytes) {
        keepOnDisk
            ? onDisk.add((name: name, path: path, size: size))
            : tooLarge.add(name);
        continue;
      }
      files.add((name: name, bytes: await file.readAsBytes()));
    } on FileSystemException {
      continue;
    }
  }
  return (files: files, tooLarge: tooLarge, onDisk: onDisk);
}
