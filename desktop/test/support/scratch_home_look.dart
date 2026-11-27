import 'dart:io';

import 'package:harness/core/harness_home.dart';
import 'package:path/path.dart' as p;

/// A look for the rule that reads the disk only inside a test's own [root].
///
/// It fails closed, so no test reaches the home of the computer running it:
/// an XDG value the rule refuses (a relative one, or a Windows path) throws
/// here rather than send the rule to `<home>/.local`, and a path outside
/// [root] throws when the rule asks about it rather than being looked at.
HomeLook scratchHomeLook(
  String root, {
  bool linux = true,
  Map<String, String> environment = const {},
}) {
  for (final MapEntry(:key, :value) in environment.entries) {
    if (key.startsWith('XDG_') && !p.posix.isAbsolute(value)) {
      throw ArgumentError.value(
        value,
        key,
        'the rule refuses it and falls back to the home',
      );
    }
  }
  String inside(String path) {
    if (!p.isWithin(root, path)) {
      throw StateError('the rule looked outside the test\'s folder: $path');
    }
    return path;
  }

  return HomeLook(
    linux: linux,
    environment: environment,
    exists: (path) =>
        FileSystemEntity.typeSync(inside(path)) !=
        FileSystemEntityType.notFound,
    isFile: (path) => FileSystemEntity.isFileSync(inside(path)),
  );
}
