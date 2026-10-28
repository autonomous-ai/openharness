import 'dart:typed_data';

export 'folder_read_io.dart' if (dart.library.ffi) 'folder_read_native.dart';

/// A dropped folder, held open while its files are read, so that nothing
/// outside it is read even when the folder changes underneath.
abstract interface class FolderFiles {
  /// The file reached by the names in [inside], each under the last, read
  /// without following a link. Null when one of them is a link or not a plain
  /// file or folder by now. At most [maxBytes] + 1 bytes are read, so a file
  /// that grew past what is left is never read in full.
  Uint8List? read(List<String> inside, int maxBytes);

  void close();
}
