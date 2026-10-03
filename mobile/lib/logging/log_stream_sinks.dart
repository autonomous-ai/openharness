/// The sinks that put the app's log in two places at once: the daily files, and
/// the in-memory [LogStream] the Debug screen reads.
///
/// A mirror rather than a second stream. Every call site keeps writing to the
/// one `appLog` it already writes to, so a line cannot reach the
/// screen without reaching the file — which is what makes "read it in Settings
/// ▸ Debug" and "send us the log" the same evidence.
library;

import 'app_log.dart';
import 'log_stream.dart';

/// Writes one event to each of [sinks], in order.
class FanoutAppLog implements AppLog {
  const FanoutAppLog(this.sinks);

  final List<AppLog> sinks;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    for (final sink in sinks) {
      sink.record(
        level,
        category,
        message,
        error: error,
        stackTrace: stackTrace,
      );
    }
  }
}

/// [AppLog] that appends to a [LogStream].
///
/// No burst filter, unlike [FileAppLog]: this costs no fsync, and an error
/// repeating every frame is itself the thing a developer opened this screen to
/// see. The ring bounds what it can cost.
class StreamAppLog implements AppLog {
  const StreamAppLog(this._stream);

  final LogStream _stream;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    _stream.add(
      level,
      category,
      message,
      error: error?.toString(),
      stackTrace: stackTrace?.toString(),
    );
  }
}
