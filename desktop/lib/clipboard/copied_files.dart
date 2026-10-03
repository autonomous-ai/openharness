import 'dart:io';

import 'package:path/path.dart' as p;

import 'pasted_files.dart';

/// Files copied in a file manager, read off this computer's disk: those that
/// fit, and the names of those that did not.
typedef CopiedFiles = ({List<PastedFile> files, List<String> tooLarge});

/// Reads the files at [paths], which a clipboard named
/// ([NativeClipboard.readFilePaths]). A folder is left out, as is a file that
/// is gone or cannot be read. One over [maxBytes] is named in `tooLarge` and
/// never read: a copied video is not pulled into memory to be refused.
Future<CopiedFiles> readCopiedFiles(
  Iterable<String> paths, {
  required int maxBytes,
}) async {
  final files = <PastedFile>[];
  final tooLarge = <String>[];
  for (final path in paths) {
    final name = p.basename(path);
    try {
      if (!await FileSystemEntity.isFile(path)) continue;
      final file = File(path);
      if (await file.length() > maxBytes) {
        tooLarge.add(name);
        continue;
      }
      files.add((name: name, bytes: await file.readAsBytes()));
    } on FileSystemException {
      continue;
    }
  }
  return (files: files, tooLarge: tooLarge);
}
