import 'dart:io';

import 'harness_home.dart';

/// This computer's look, read at each call so a move is seen at the next one.
HomeLook platformHomeLook() => HomeLook(
  linux: Platform.isLinux,
  environment: Platform.environment,
  exists: (path) =>
      FileSystemEntity.typeSync(path) != FileSystemEntityType.notFound,
);
