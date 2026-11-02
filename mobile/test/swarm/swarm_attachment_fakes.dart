import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import 'package:file/file.dart' hide FileSystem;
import 'package:file/local.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';

/// A one-pixel PNG, as Harness's file storage would serve a picture.
final pixelPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAD'
  'hgGAWjR9awAAAABJRU5ErkJggg==',
);

/// Harness's file storage as the phone reaches it: what was asked, with which
/// headers, and an answer the test can hold back or fail.
class FakeFileStorage implements FileService {
  @override
  int concurrentFetches = 10;

  final asked = <({String url, Map<String, String>? headers})>[];

  /// Set to hold every answer until it completes.
  Completer<void>? hold;

  /// The status every answer carries.
  int status = 200;

  /// What every answer carries.
  List<int> bytes = pixelPng;

  @override
  Future<FileServiceResponse> get(
    String url, {
    Map<String, String>? headers,
  }) async {
    asked.add((url: url, headers: headers));
    await hold?.future;
    return _Answer(status, bytes);
  }
}

class _Answer implements FileServiceResponse {
  _Answer(this.statusCode, this._bytes);

  final List<int> _bytes;

  @override
  final int statusCode;

  @override
  Stream<List<int>> get content => Stream.value(_bytes);

  @override
  int? get contentLength => _bytes.length;

  @override
  DateTime get validTill => DateTime.now().add(const Duration(days: 365));

  @override
  String? get eTag => null;

  @override
  String get fileExtension => '.png';
}

/// Files under [folder], where the app keeps them under its temporary folder.
class _Folder implements FileSystem {
  _Folder(this.folder);

  final io.Directory folder;

  @override
  Future<File> createFile(String name) async {
    final directory = const LocalFileSystem().directory(folder.path);
    await directory.create(recursive: true);
    return directory.childFile(name);
  }
}

/// A store over [root] and [storage], as the app's is over its temporary
/// folder and the network.
SwarmAttachmentStore storeIn(io.Directory root, FileService storage) =>
    SwarmAttachmentStore(
      root: () async => root,
      fileService: storage,
      files: (folder) => _Folder(folder),
    );

/// The files kept under [root], by their path below it.
List<String> keptUnder(io.Directory root) {
  if (!root.existsSync()) return const [];

  final pending = <io.Directory>[root];
  final files = <String>[];
  while (pending.isNotEmpty) {
    final directory = pending.removeLast();
    late final List<io.FileSystemEntity> entries;
    try {
      entries = directory.listSync();
    } on io.PathNotFoundException {
      // The keeper deletes asynchronously. One subtree may disappear after its
      // parent was listed; ignore only that vanished subtree and keep scanning.
      continue;
    }
    for (final entry in entries) {
      if (entry is io.Directory) {
        pending.add(entry);
      } else if (entry is io.File) {
        files.add(entry.path.substring(root.path.length + 1));
      }
    }
  }
  return files;
}

/// The one account folder under [root] made read-only, so what is in it
/// cannot be deleted, as a phone can refuse; returns the undo, which the
/// caller also runs in its tear-down so the folder can be cleaned up.
void Function() denyDeletes(io.Directory root) {
  final folders = root.listSync().whereType<io.Directory>().toList();
  if (folders.length != 1) {
    throw StateError('Expected one account folder, found ${folders.length}.');
  }
  void mode(String bits) =>
      io.Process.runSync('chmod', [bits, folders.single.path]);
  mode('500');
  return () => mode('700');
}
