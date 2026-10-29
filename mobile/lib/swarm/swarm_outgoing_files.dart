import 'package:flutter/foundation.dart';

/// What the backend allows one message to carry (the desktop's
/// `kSuperTabAttachmentMaxBytes` and `kSuperTabAttachmentMaxFiles`,
/// backend `superTabs/attachments.ts`).
const swarmAttachmentMaxBytes = 10 * 1024 * 1024;
const swarmAttachmentMaxFiles = 10;

/// One file waiting to go with a message: its bytes in memory only, never
/// written anywhere on the phone.
@immutable
class SwarmOutgoingFile {
  const SwarmOutgoingFile(this.name, this.bytes);

  final String name;
  final Uint8List bytes;
}

/// The files waiting to go with the next message in a chat — the desktop's
/// `HarnessAttachments` with a Swarm chat's limits, wording and all. Held in
/// memory until sent, or until the chat closes.
class SwarmOutgoingFiles extends ChangeNotifier {
  final _files = <SwarmOutgoingFile>[];

  List<SwarmOutgoingFile> get files => List.unmodifiable(_files);

  /// How many more files fit.
  int get room => swarmAttachmentMaxFiles - _files.length;

  /// Adds the files that fit, replacing one of the same name. Returns what
  /// to tell the person about any left out — past the count, over the size,
  /// or both — or null when all were taken.
  /// [oversized] names files already known to be over the limit, which were
  /// never read into memory to be refused here; [surplus] counts those the
  /// picker already left out for want of room.
  String? add(
    Iterable<SwarmOutgoingFile> files, {
    Iterable<String> oversized = const [],
    int surplus = 0,
  }) {
    final tooLarge = [...oversized];
    var over = surplus;
    for (final file in files) {
      if (file.bytes.isEmpty) continue;
      if (file.bytes.length > swarmAttachmentMaxBytes) {
        tooLarge.add(file.name);
        continue;
      }
      _files.removeWhere((kept) => kept.name == file.name);
      if (_files.length >= swarmAttachmentMaxFiles) {
        over++;
        continue;
      }
      _files.add(file);
    }
    notifyListeners();
    const limit = '${swarmAttachmentMaxBytes ~/ (1024 * 1024)} MB';
    // Both limits can leave files out at once; each says so.
    final notes = [
      if (over > 0) 'Attach at most $swarmAttachmentMaxFiles files.',
      if (tooLarge.length == 1) '${tooLarge.single} is over $limit.',
      if (tooLarge.length > 1) '${tooLarge.length} files are over $limit.',
    ];
    return notes.isEmpty ? null : notes.join(' ');
  }

  /// Adds photos beside what is there: the camera and the library name every
  /// photo alike, so one whose name is taken is numbered, not swapped in (the
  /// desktop's `addPasted`).
  String? addNumbered(
    Iterable<SwarmOutgoingFile> files, {
    Iterable<String> oversized = const [],
    int surplus = 0,
  }) {
    final taken = {for (final file in _files) file.name};
    return add(
      [
        for (final file in files)
          SwarmOutgoingFile(swarmFreeName(file.name, taken), file.bytes),
      ],
      oversized: oversized,
      surplus: surplus,
    );
  }

  void remove(SwarmOutgoingFile file) {
    if (_files.remove(file)) notifyListeners();
  }

  void clear() {
    if (_files.isEmpty) return;
    _files.clear();
    notifyListeners();
  }
}

/// A composer that sends [files] with its next message — the chat's, or a
/// thread's reply box — and how far each has gone up while it sends.
abstract interface class SwarmFilesBox {
  SwarmOutgoingFiles get files;

  /// Whether [file] is still on its way to the backend in a send.
  bool isUploading(SwarmOutgoingFile file);

  /// How much of [file] has gone up, from 0 to 1, while it is going up.
  double? uploadProgress(SwarmOutgoingFile file);
}

/// [name], or `name-2.ext`, `name-3.ext`… — the first not in [taken], which
/// then holds it.
String swarmFreeName(String name, Set<String> taken) {
  final dot = name.lastIndexOf('.');
  final stem = dot > 0 ? name.substring(0, dot) : name;
  final extension = dot > 0 ? name.substring(dot) : '';
  var candidate = name;
  for (var count = 2; !taken.add(candidate); count++) {
    candidate = '$stem-$count$extension';
  }
  return candidate;
}

/// The content type a file of this [name] is sent as: the kinds a chat shows
/// or opens, and `application/octet-stream` for the rest (the desktop's
/// `mimeForName`).
String swarmMimeForName(String name) {
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return _mimes[extension] ?? 'application/octet-stream';
}

const _mimes = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'pdf': 'application/pdf',
  'json': 'application/json',
  'zip': 'application/zip',
  'txt': 'text/plain',
  'log': 'text/plain',
  'md': 'text/markdown',
  'csv': 'text/csv',
};
