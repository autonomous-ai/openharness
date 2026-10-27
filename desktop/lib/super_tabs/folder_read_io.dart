import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'folder_read.dart' show FolderFiles;

FolderFiles openFolder(String path) => IoFolderFiles(path);

/// [FolderFiles] by path, where the platform gives no way to open a file
/// relative to a folder without following links (Windows). Each name on the
/// way is checked not to be a link, and the file once open must still lie in
/// the folder; a link swapped in between that check and the open is not
/// caught.
final class IoFolderFiles implements FolderFiles {
  IoFolderFiles(String path)
    : _root = Directory(path).resolveSymbolicLinksSync();

  final String _root;

  @override
  Uint8List? read(List<String> inside, int maxBytes) {
    var path = _root;
    for (final name in inside) {
      path = p.join(path, name);
      if (FileSystemEntity.isLinkSync(path)) return null;
    }
    final file = File(path).openSync();
    try {
      if (!p.isWithin(_root, File(path).resolveSymbolicLinksSync())) {
        return null;
      }
      final bytes = BytesBuilder(copy: false);
      while (bytes.length <= maxBytes) {
        final chunk = file.readSync(maxBytes + 1 - bytes.length);
        if (chunk.isEmpty) break;
        bytes.add(chunk);
      }
      return bytes.takeBytes();
    } finally {
      file.closeSync();
    }
  }

  @override
  void close() {}
}
