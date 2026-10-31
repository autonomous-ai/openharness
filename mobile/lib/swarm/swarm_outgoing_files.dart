import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

/// What the backend allows one message to carry (the desktop's
/// `kSuperTabAttachmentMaxBytes` and `kSuperTabAttachmentMaxFiles`,
/// backend `superTabs/attachments.ts`).
const swarmAttachmentMaxBytes = 256 * 1024 * 1024;
const swarmAttachmentMaxFiles = 10;

/// The most one file may be to go up as a form, in one request to the
/// backend (backend `MAX_FORM_ATTACHMENT_BYTES`). A larger one goes straight
/// to storage by a link the backend signs, which no proxy in between caps
/// ([ApiClient.uploadSwarmAttachment]).
const swarmFormAttachmentMaxBytes = 10 * 1024 * 1024;

/// What the person is told of a file past [swarmAttachmentMaxBytes].
const swarmAttachmentMaxLabel =
    '${swarmAttachmentMaxBytes ~/ (1024 * 1024)} MB';

/// One file waiting to go with a message: its [bytes] in memory, never
/// written anywhere on the phone — or, past [swarmFormAttachmentMaxBytes],
/// left where the picker put it at [path] and read from there as it goes up,
/// so a file of hundreds of megabytes is never held whole.
class SwarmOutgoingFile {
  SwarmOutgoingFile(this.name, Uint8List this.bytes)
    : size = bytes.length,
      path = null,
      _open = null;

  /// A file read from [path] as it goes up, [size] bytes long. [temporary]
  /// is the picker's own copy in the app's temporary folder: it is deleted
  /// after nothing holds this file any more — sent, taken off, or its chat
  /// closed — once Dart collects it ([_copies]); one left by an app that was
  /// killed first stays in the temporary folder for the system to clear. A
  /// file anywhere else is never touched.
  SwarmOutgoingFile.onDisk(
    this.name,
    String this.path,
    this.size, {
    bool temporary = false,
  }) : bytes = null,
       _open = null {
    if (temporary) _copies.attach(this, path!);
  }

  /// A file of [size] bytes read by [open], for tests: no bytes held, none
  /// on disk.
  @visibleForTesting
  SwarmOutgoingFile.streamed(
    this.name,
    this.size,
    Stream<List<int>> Function() open,
  ) : bytes = null,
      path = null,
      _open = open;

  final String name;

  /// How many bytes the file is.
  final int size;

  /// Its bytes, when they are held in memory.
  final Uint8List? bytes;

  /// Where it is read from, when it is not held in memory.
  final String? path;

  final Stream<List<int>> Function()? _open;

  /// The same file under [name].
  SwarmOutgoingFile named(String name) {
    if (name == this.name) return this;
    final held = bytes;
    if (held != null) return SwarmOutgoingFile(name, held);
    final at = path;
    // The copy stays with the file that holds it ([_copies]); this one only
    // points at it while both are around.
    if (at != null) return _Renamed(name, this, at);
    return SwarmOutgoingFile.streamed(name, size, _open!);
  }

  /// Its bytes, a part at a time.
  Stream<List<int>> openRead() {
    final held = bytes;
    if (held != null) return Stream.value(held);
    final at = path;
    if (at != null) return File(at).openRead(0, size);
    return _open!();
  }

  /// All its bytes at once: for a file small enough to go as a form.
  Future<Uint8List> readAll() async {
    final held = bytes;
    if (held != null) return held;
    final all = BytesBuilder(copy: false);
    await for (final part in openRead()) {
      all.add(part);
    }
    return all.takeBytes();
  }

  /// Deletes a picker's copy once the file that points at it is gone — never
  /// earlier, so one going up, put back after a refusal, or held by two
  /// boxes at once (New message and its chat) is always there to read. A
  /// box deleting what it lets go would delete a file another still holds.
  static final _copies = Finalizer<String>(_deleteCopy);
}

/// A file under a new name that reads [of]'s copy, and keeps [of] — and so
/// the copy — while it is held.
class _Renamed extends SwarmOutgoingFile {
  _Renamed(String name, this.of, String path)
    : super.onDisk(name, path, of.size);

  final SwarmOutgoingFile of;
}

/// Deletes the picker's copy at [path]; one already gone is nothing to do.
void _deleteCopy(String path) {
  try {
    File(path).deleteSync();
  } catch (_) {
    // Already gone: nothing of it is left to keep.
  }
}

/// The files waiting to go with the next message in a chat — the desktop's
/// `HarnessAttachments` with a Swarm chat's limits, wording and all. Held
/// until sent, or until the chat closes.
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
      if (file.size == 0) continue;
      if (file.size > swarmAttachmentMaxBytes) {
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
    const limit = swarmAttachmentMaxLabel;
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
      [for (final file in files) file.named(swarmFreeName(file.name, taken))],
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
