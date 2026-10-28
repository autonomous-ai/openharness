import 'dart:io';

import 'package:file_selector/file_selector.dart' show openFiles;
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

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

/// Opens [source] and adds what the person picks to [files], by Desktop's limits: ten files a
/// message, 10 MB each. Photos are named `photo.jpg`, `photo-2.jpg`… since a picker names them by
/// no name a person would know; other files keep their own.
///
/// Each picker hands over its own copy of the file in the app's private temporary folder; it is
/// read into memory and deleted at once, kept or not, so no photo stays on the phone.
Future<SwarmPickOutcome> addSwarmPicked(
  SwarmOutgoingFiles files,
  SwarmPickSource source,
) async {
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
  final photos = source != SwarmPickSource.files;
  final taken = {for (final file in files.files) file.name};
  final read = <SwarmOutgoingFile>[];
  final oversized = <String>[];
  String? unreadable;
  for (final file in picked) {
    final own = file.name.isEmpty ? 'file' : file.name;
    final name = photos ? swarmFreeName(_photoName(own), taken) : own;
    try {
      final bytes = await _read(file);
      if (bytes == null) {
        oversized.add(name);
      } else {
        read.add(SwarmOutgoingFile(name, bytes));
      }
    } catch (_) {
      unreadable ??= name;
    } finally {
      await _delete(file);
    }
  }
  final note = files.add(read, oversized: oversized);
  return SwarmPicked(
    note ?? (unreadable == null ? null : 'Could not read $unreadable.'),
  );
}

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

/// Deletes the picker's copy of [file]. Every picker here makes one in the app's own temporary
/// folder (image_picker and file_selector alike), never handing over the person's original.
Future<void> _delete(XFile file) async {
  if (kIsWeb || file.path.isEmpty) return;
  try {
    await File(file.path).delete();
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
