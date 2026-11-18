import 'dart:io';

import 'harness_home.dart';

/// This computer's look, read at each call so a move is seen at the next one.
/// [environment] is the caller's when it has one: the XDG variables the rule
/// reads are its, not this process's.
HomeLook platformHomeLook({Map<String, String>? environment}) => HomeLook(
  linux: Platform.isLinux,
  environment: environment ?? Platform.environment,
  exists: (path) =>
      FileSystemEntity.typeSync(path) != FileSystemEntityType.notFound,
  isFile: FileSystemEntity.isFileSync,
);
