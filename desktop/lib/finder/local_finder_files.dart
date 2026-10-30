import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import '../core/reveal_folder.dart' as system;
import 'finder_file_kind.dart';
import 'finder_files.dart';
import 'finder_models.dart';
import 'finder_watch.dart';

/// [FinderFiles] over this computer's own disk.
class LocalFinderFiles implements FinderFiles {
  const LocalFinderFiles();

  @override
  Future<List<FinderEntry>> list(String directory) async {
    final entries = <FinderEntry>[];
    try {
      await for (final entity in Directory(directory).list(followLinks: true)) {
        final name = p.basename(entity.path);
        if (kFinderHiddenNames.contains(name)) continue;
        entries.add(
          FinderEntry(
            name: name,
            path: entity.path,
            isDirectory: entity is Directory,
          ),
        );
        if (entries.length >= kFinderListLimit) break;
      }
    } on FileSystemException catch (error) {
      throw FinderException(_failure(error, 'read this folder'));
    }
    return entries..sort(_foldersFirst);
  }

  @override
  Future<FinderContent> read(String path) async {
    final file = File(path);
    final stat = await _guard(file.stat, 'read this file');
    if (stat.type == FileSystemEntityType.notFound) {
      throw const FinderException('This file no longer exists.');
    }
    final kind = finderFileKind(path);
    if (kind == FinderFileKind.image || kind == FinderFileKind.svg) {
      if (stat.size > kFinderImageLimit) {
        return const FinderBinary('This image is too large to show here.');
      }
      final bytes = await _guard(file.readAsBytes, 'read this file');
      return FinderImage(bytes, svg: kind == FinderFileKind.svg);
    }
    if (stat.size > kFinderEditLimit) {
      return const FinderBinary('This file is too large to open here.');
    }
    final bytes = await _guard(file.readAsBytes, 'read this file');
    final head = Uint8List.sublistView(bytes, 0, bytes.length.clamp(0, 8192));
    if (kind == FinderFileKind.other && !looksLikeText(head)) {
      return const FinderBinary('Binary file — it can’t be shown here.');
    }
    return FinderText(
      utf8.decode(bytes, allowMalformed: true),
      DiskStamp(stat.modified, stat.size),
    );
  }

  @override
  Future<DiskStamp?> stamp(String path) async {
    final stat = await File(path).stat();
    if (stat.type == FileSystemEntityType.notFound) return null;
    return DiskStamp(stat.modified, stat.size);
  }

  @override
  Future<DiskStamp> write(String path, String text) async {
    final file = File(path);
    await _guard(() => file.writeAsString(text, flush: true), 'save this file');
    final stat = await file.stat();
    return DiskStamp(stat.modified, stat.size);
  }

  @override
  Future<void> createFile(String path) =>
      _guard(() => File(path).create(exclusive: true), 'create this file');

  @override
  Future<void> createFolder(String path) =>
      _guard(() => Directory(path).create(), 'create this folder');

  @override
  Future<void> rename(String from, String to) async {
    if (await FileSystemEntity.type(to) != FileSystemEntityType.notFound) {
      throw FinderException('“${p.basename(to)}” already exists here.');
    }
    await _guard(
      () => FileSystemEntity.isDirectory(from).then(
        (folder) => folder ? Directory(from).rename(to) : File(from).rename(to),
      ),
      'rename this item',
    );
  }

  @override
  Future<void> trash(String path) async {
    // macOS's own `trash` (macOS 14+) and freedesktop's `gio trash`: both put
    // the item where the person's Trash can give it back.
    final command = Platform.isMacOS
        ? ('/usr/bin/trash', [path])
        : ('gio', ['trash', path]);
    try {
      final result = await Process.run(command.$1, command.$2);
      if (result.exitCode == 0) return;
    } on ProcessException {
      // Reported below, as for a failed run.
    }
    throw const FinderException('Couldn’t move this item to the Trash.');
  }

  @override
  Future<bool> open(String path) => system.openFile(path);

  @override
  Future<bool> reveal(String path) => system.revealFile(path);

  @override
  Stream<Set<String>> watch(String root) => watchFolder(root);
}

int _foldersFirst(FinderEntry a, FinderEntry b) {
  if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name.toLowerCase().compareTo(b.name.toLowerCase());
}

Future<T> _guard<T>(Future<T> Function() action, String what) async {
  try {
    return await action();
  } on FileSystemException catch (error) {
    throw FinderException(_failure(error, what));
  }
}

String _failure(FileSystemException error, String what) =>
    switch (error.osError?.errorCode) {
      1 || 13 => 'Harness isn’t allowed to $what.',
      2 => 'This item no longer exists. It may have moved or been deleted.',
      17 => 'An item with this name already exists.',
      28 => 'There isn’t enough disk space to $what.',
      _ => 'Couldn’t $what.',
    };
