import 'package:flutter/widgets.dart';

import 'app_log.dart';
import 'debug_surface.dart';
import 'log_file.dart';
import 'log_stream.dart';
import 'log_stream_sinks.dart';

/// Base name of the per-day file under `~/.harness/logs`.
const String kAppLogBase = 'app';

/// How long a line of the app log may wait to be written with the ones after it — see
/// [DailyLogFile.batch].
const Duration kAppLogBatch = Duration(milliseconds: 250);

/// Point [appLog] at real files under `~/.harness/logs`, and — in
/// a build that has the Debug screen — at the in-memory [logStream] as well.
///
/// Called once from `main()`. Nothing else calls it, which is what keeps the
/// suite honest: the app log defaults to a no-op, so `flutter test` cannot
/// write into a real Harness home no matter which code path it exercises.
///
/// Deliberately not `async`: the first lines this app writes are the ones about
/// starting up, and awaiting a directory probe here would lose them.
void installFileLogs() {
  final directory = DailyLogFile.defaultDirectory;
  final daily = DailyLogFile(directory, kAppLogBase, batch: kAppLogBatch);
  // The lines held for a batch go out the moment the app leaves the screen: the switcher is where
  // an app is closed, and a closed app never sees the batch's timer fire. Never disposed — it lives
  // as long as the log does, held by the binding it registers with.
  AppLifecycleListener(
    onInactive: daily.flush,
    onHide: daily.flush,
    onPause: daily.flush,
    onDetach: () => daily.flush(durable: true),
  );
  final file = FileAppLog(daily);
  if (!kDebugSurfaceEnabled) {
    appLog = file;
    return;
  }
  // The file first in the fan-out: if the mirror ever throws, the durable
  // copy is already written.
  appLog = FanoutAppLog([file, StreamAppLog(logStream)]);
}
