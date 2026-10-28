import 'dart:io';

import 'package:file_selector/file_selector.dart' show openFiles;
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'swarm_outgoing_files.dart';

/// Where the attach sheet of a phone Swarm chat takes files from.
enum SwarmPickSource { library, camera, files }

/// What one pick did to a chat's files.
sealed class SwarmPickOutcome {
  const SwarmPickOutcome();
}

/// The files picked were taken, or nothing was picked. [note] says what was left out, if anything.
class SwarmPicked extends SwarmPickOutcome {
  const SwarmPicked(this.note);
  final String? note;
}

/// The phone refused the app [source] — the camera, or photos — and only Settings turns it back on.
class SwarmPickDenied extends SwarmPickOutcome {
  const SwarmPickDenied(this.source);
  final SwarmPickSource source;
}

/// The picker could not be opened, or there is no room left for a file.
class SwarmPickFailed extends SwarmPickOutcome {
  const SwarmPickFailed(this.message);
  final String message;
}

/// Photos are scaled to at most this many pixels on their long side and sent as JPEG at
/// [_photoQuality]: a phone's own photo can be past the 10 MB a file may be, and a HEIC one is not
/// a picture Desktop shows. A PNG or a GIF keeps its kind.
const double _photoMaxSide = 4096;
const int _photoQuality = 85;

/// The system's photo picker for up to [limit] photos — PHPicker on iOS, the photo picker on
/// Android. Neither asks for a permission: each hands over only the photos the person chose, and
/// no metadata is asked for, which on iOS would ask for the whole library. Empty is the person
/// backing out. Replaced in tests, where there is no picker to open.
@visibleForTesting
Future<List<XFile>> Function(int limit) pickSwarmPhotos = (limit) =>
    ImagePicker().pickMultiImage(
      limit: limit,
      maxWidth: _photoMaxSide,
      maxHeight: _photoMaxSide,
      imageQuality: _photoQuality,
      requestFullMetadata: false,
    );

/// The camera, for one photo; asks for the camera the first time. Null is the person backing out.
@visibleForTesting
Future<XFile?> Function() takeSwarmPhoto = () => ImagePicker().pickImage(
  source: ImageSource.camera,
  maxWidth: _photoMaxSide,
  maxHeight: _photoMaxSide,
  imageQuality: _photoQuality,
  requestFullMetadata: false,
);

/// The system's document picker for any number of files — Files on iOS, the Storage Access
/// Framework on Android — with no storage permission. Empty is the person backing out.
@visibleForTesting
Future<List<XFile>> Function() pickSwarmFiles = () => openFiles();

/// The app's own temporary folders, where the pickers leave their copies: Dart's temporary folder
/// (the app's `tmp/` on iOS, where image_picker and the document picker copy to) and the one
/// path_provider names (the cache folder on Android, where both copy to). Replaced in tests.
@visibleForTesting
Future<List<String>> Function() swarmPickerCopyFolders = () async => [
  Directory.systemTemp.path,
  (await getTemporaryDirectory()).path,
];

/// Opens [source] and adds what the person picks to [files], by Desktop's limits: ten files a
/// message, 10 MB each — reading no more files than there is room for, and naming any left out,
/// over the size or empty. Photos are named `photo.jpg`, `photo-2.jpg`… since a picker names them by
/// no name a person would know; other files keep their own.
///
/// Each picker hands over its own copy of the file in the app's private temporary folder; it is
/// read into memory and deleted at once, kept or not, so no photo stays on the phone. A file
/// outside those folders is read and left where it is. Nothing is
/// added once [stillWanted] fails: the chat closed while its picker was up.
Future<SwarmPickOutcome> addSwarmPicked(
  SwarmOutgoingFiles files,
  SwarmPickSource source, {
  bool Function() stillWanted = _always,
}) async {
  final room = files.room;
  if (room <= 0) {
    return const SwarmPickFailed(
      'Attach at most $swarmAttachmentMaxFiles files.',
    );
  }
  final List<XFile> picked;
  try {
    picked = switch (source) {
      SwarmPickSource.library => await pickSwarmPhotos(room),
      SwarmPickSource.camera => [?await takeSwarmPhoto()],
      SwarmPickSource.files => await pickSwarmFiles(),
    };
  } on PlatformException catch (error) {
    // A refusal arrives as one rather than as a cancel, and it is the one failure the person can
    // do something about.
    if (error.code == 'camera_access_denied') {
      return const SwarmPickDenied(SwarmPickSource.camera);
    }
    if (error.code == 'photo_access_denied') {
      return const SwarmPickDenied(SwarmPickSource.library);
    }
    return SwarmPickFailed(
      source == SwarmPickSource.camera
          ? 'Could not open the camera.'
          : 'Could not open the picker.',
    );
  }
  final copies = await _copyFolders();
  void delete(XFile file) => _delete(file, copies);
  // The chat can have closed while the picker was up — signed out, say: nothing goes into it.
  if (!stillWanted()) {
    for (final file in picked) {
      delete(file);
    }
    return const SwarmPicked(null);
  }
  final photos = source != SwarmPickSource.files;
  final taken = {for (final file in files.files) file.name};
  final read = <SwarmOutgoingFile>[];
  final oversized = <String>[], empty = <String>[];
  var surplus = 0;
  String? unreadable;
  for (final file in picked) {
    // Past the room left, a file is counted, never read: forty 9 MB files
    // picked at once would otherwise all be held in memory to be refused.
    if (read.length >= room) {
      surplus++;
      delete(file);
      continue;
    }
    final own = file.name.isEmpty ? 'file' : file.name;
    final name = photos ? swarmFreeName(_photoName(own), taken) : own;
    try {
      final bytes = await _read(file);
      if (bytes == null) {
        oversized.add(name);
      } else if (bytes.isEmpty) {
        empty.add(name);
      } else {
        read.add(SwarmOutgoingFile(name, bytes));
      }
    } catch (_) {
      unreadable ??= name;
    } finally {
      delete(file);
    }
  }
  final notes = [
    ?files.add(read, oversized: oversized, surplus: surplus),
    if (empty.length == 1) '${empty.single} is empty.',
    if (empty.length > 1) '${empty.length} files are empty.',
    if (unreadable != null) 'Could not read $unreadable.',
  ];
  return SwarmPicked(notes.isEmpty ? null : notes.join(' '));
}

bool _always() => true;

/// [file]'s bytes, or null when it is past the limit, which is measured before it is read so a
/// large file is never held whole.
Future<Uint8List?> _read(XFile file) async {
  int? size;
  try {
    size = await file.length();
  } catch (_) {
    // No size to read is no reason to refuse yet: the read says whether the file is there.
  }
  if (size != null && size > swarmAttachmentMaxBytes) return null;
  final bytes = await file.readAsBytes();
  return bytes.length > swarmAttachmentMaxBytes ? null : bytes;
}

/// [swarmPickerCopyFolders], each as its real path; none when they cannot be read, and then
/// nothing is deleted.
Future<List<String>> _copyFolders() async {
  try {
    return [for (final folder in await swarmPickerCopyFolders()) _real(folder)];
  } catch (_) {
    return const [];
  }
}

/// [path] with its links resolved (iOS reaches the app's folders through `/private`), or as given
/// when it is not there to resolve.
String _real(String path) {
  try {
    return File(path).resolveSymbolicLinksSync();
  } catch (_) {
    return p.normalize(p.absolute(path));
  }
}

/// Deletes the picker's copy of [file] — only when it lies in one of the app's own temporary
/// [folders], where image_picker and file_selector put the copies they hand over. A file anywhere
/// else could be the person's original, and is never touched. At once rather than awaited: one
/// small file, gone before anything else runs.
void _delete(XFile file, List<String> folders) {
  if (kIsWeb || file.path.isEmpty) return;
  final path = _real(file.path);
  if (!folders.any((folder) => p.isWithin(folder, path))) return;
  try {
    File(path).deleteSync();
  } catch (_) {
    // Already gone, or never written: nothing of it is left to keep.
  }
}

/// `photo` with the kind of the picker's file: `.jpg` unless it kept a PNG or a GIF.
String _photoName(String picked) {
  final dot = picked.lastIndexOf('.');
  final extension = dot < 0 ? '' : picked.substring(dot + 1).toLowerCase();
  return switch (extension) {
    'png' || 'gif' || 'webp' => 'photo.$extension',
    _ => 'photo.jpg',
  };
}
