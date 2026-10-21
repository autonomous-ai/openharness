import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../core/runtime_platform.dart';

/// The file Windows' `Harness.exe` looks for in a version folder: this version
/// has drawn a window once (pty/src/desktop/rollback.rs). Without it, two
/// starts in a row that end early send the launcher back to the version before
/// an update.
const startedMarkerName = '.started';

/// `app\<ver>\.started`, beside the running executable; null off Windows.
File? startedMarkerFile({String? executablePath, bool? isWindows}) {
  if (!(isWindows ?? RuntimePlatform.isWindows)) return null;
  final exe = executablePath ?? RuntimePlatform.resolvedExecutable;
  return File(p.join(p.dirname(exe), startedMarkerName));
}

/// Writes the marker once [firstFrame] completes (the engine's first frame,
/// `WidgetsBinding.waitUntilFirstFrameRasterized`). Once per version folder: a
/// marker already there is left as it is. A folder that cannot be written (a
/// copy run from a read-only place) only costs the rollback its signal, so a
/// failure is logged and swallowed.
Future<void> markStartedAfterFirstFrame({
  required Future<void> firstFrame,
  String? executablePath,
  bool? isWindows,
}) async {
  final marker = startedMarkerFile(
    executablePath: executablePath,
    isWindows: isWindows,
  );
  if (marker == null) return;
  await firstFrame;
  try {
    if (await marker.exists()) return;
    await marker.writeAsString(
      '${DateTime.now().toUtc().toIso8601String()}\n',
      flush: true,
    );
  } on FileSystemException catch (error) {
    debugPrint('startedMarker: could not write ${marker.path}: $error');
  }
}
