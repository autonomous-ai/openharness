/// An error that knows what of itself a log may show.
///
/// Some errors carry content in their `toString` (a daemon's refusal can quote
/// a prompt or a name) that the person should see but the logs must not keep.
/// The sinks render every error through [logErrorText], so such an error
/// implements this instead of each call site remembering to strip it.
abstract interface class LogSafeError {
  /// The text a log may show for this error.
  String get logText;
}

/// What the logs write for [error].
String logErrorText(Object error) =>
    error is LogSafeError ? error.logText : '$error';
