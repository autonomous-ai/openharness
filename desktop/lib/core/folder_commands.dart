import 'dart:io';

import 'package:path/path.dart' as p;

import 'runtime_platform.dart';

/// Makes the folder [path] only if nothing is there yet, as the `mkdir`
/// program does, so two callers racing for one name never both get it.
///
/// [Directory.create] accepts a folder that already exists, which is why the
/// project and worktree folders are reserved with `mkdir`. Windows has no such
/// program (`mkdir` is a `cmd.exe` builtin), so there the folder is made under
/// a temporary name beside [path] and renamed onto it, which Windows refuses
/// when [path] exists.
///
/// The answer is `mkdir`'s: exit code 0 when the folder was made, otherwise a
/// non-zero code with the reason in `stderr`, which callers read for a full
/// disk.
Future<ProcessResult> reserveDirectory(String path, {bool? isWindows}) async {
  if (!(isWindows ?? RuntimePlatform.isWindows)) {
    return Process.run('mkdir', [path]);
  }
  // Windows' rename is the guard. This check gives the same answer on a host
  // whose rename replaces an empty folder, which is where the tests run.
  if (FileSystemEntity.typeSync(path, followLinks: false) !=
      FileSystemEntityType.notFound) {
    return ProcessResult(0, 1, '', 'File exists: $path');
  }
  Directory? staging;
  try {
    staging = await Directory(p.dirname(path))
        .createTemp('.${p.basename(path)}-');
    await staging.rename(path);
    staging = null;
    return ProcessResult(0, 0, '', '');
  } on FileSystemException catch (error) {
    return ProcessResult(
      0,
      1,
      '',
      '${error.osError?.message ?? error.message}: $path',
    );
  } finally {
    final left = staging;
    if (left != null) {
      try {
        await left.delete();
      } on FileSystemException {
        // An empty folder with a temporary name; nothing reads it.
      }
    }
  }
}

/// Copies [source] to [target], a file or a folder with everything in it, as
/// `cp -R` does, for Windows, which has no `cp`. Links are neither followed
/// nor copied, and a file already at the target is left as it is.
Future<void> copyTree(String source, String target) async {
  switch (await FileSystemEntity.type(source, followLinks: false)) {
    case FileSystemEntityType.file:
      if (await FileSystemEntity.type(target, followLinks: false) ==
          FileSystemEntityType.notFound) {
        await File(source).copy(target);
      }
    case FileSystemEntityType.directory:
      await Directory(target).create(recursive: true);
      await for (final entry in Directory(source).list(followLinks: false)) {
        await copyTree(entry.path, p.join(target, p.basename(entry.path)));
      }
    default:
      return;
  }
}
