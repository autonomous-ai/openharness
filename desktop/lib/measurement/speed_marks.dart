import 'package:flutter/foundation.dart' show visibleForTesting;

import '../logging/app_log.dart';

/// Where Desktop's speed is read (task #3176): how long opening the app takes
/// to reach a painted chat, how long a large chat takes to load and page
/// back, and what each picture costs. One line per mark goes to the app log
/// (`~/.harness/logs/app-YYYYMMDD.log`, category `speed`) and `speed_report.dart`
/// turns those lines into a table.
///
/// A line carries a step name from a fixed vocabulary, a kind, counts,
/// milliseconds and bytes — never a name, id, path or address — and nothing
/// here can throw into the code it observes.
class SpeedMarks {
  SpeedMarks({void Function(String line)? sink, Duration Function()? elapsed})
    : _sink = sink ?? _toAppLog,
      _injected = elapsed;

  // DEBUG goes through the log's batched path (one write a second or 256
  // lines), so a mark on the UI isolate is a buffer append, not a file write.
  static void _toAppLog(String line) => appLog.debug('speed', line);

  final void Function(String line) _sink;
  // A test reads its own clock; the app reads [_watch].
  final Duration Function()? _injected;
  final _watch = Stopwatch();
  final _steps = <String>{};

  /// Marks the launch at zero. Called once, first thing in [startHarness].
  void start() {
    if (!_watch.isRunning) _watch.start();
    _begin();
  }

  /// Begins the launch steps again from zero. The app starts once per process,
  /// so only tests call this.
  @visibleForTesting
  void restart() {
    _watch
      ..reset()
      ..start();
    _begin();
  }

  void _begin() {
    _steps
      ..clear()
      ..add('started');
    _write('launch step=started ms=0');
  }

  /// A launch step reached, once, in milliseconds since [start].
  void launch(String step) {
    final name = _clean(step);
    if (!_steps.add(name)) return;
    _write('launch step=$name ms=${_now()}');
  }

  /// False once the first chat has been marked, so a row's build can skip
  /// asking for another frame callback.
  bool get awaitingFirstChat => !_steps.contains('first_chat_painted');

  /// The first chat row built on screen. Once per launch.
  void firstChat() => launch('first chat painted');

  /// A page of messages read: [kind] is `latest` (a chat opening) or `older`
  /// (scrolling back); [requestMs] is the wait for the page, [totalMs] the
  /// read through merging its rows.
  void messages({
    required String kind,
    required int rows,
    required int requestMs,
    required int totalMs,
  }) => _write(
    'messages kind=${_clean(kind)} rows=$rows '
    'request_ms=$requestMs total_ms=$totalMs',
  );

  /// A picture fetched: [bytes] is what arrived; null bytes is a failure.
  void image({required int ms, int? bytes}) =>
      _write('image ok=${bytes == null ? 0 : 1} bytes=${bytes ?? 0} ms=$ms');

  int _now() => (_injected?.call() ?? _watch.elapsed).inMilliseconds;

  void _write(String line) {
    try {
      _sink(line);
    } catch (_) {
      // Measurement never breaks what it measures.
    }
  }

  /// Letters, digits, `-` and `_` only, so no address or path can ride a line.
  static String _clean(String text) {
    final cleaned = text
        .toLowerCase()
        .replaceAll(RegExp(r'\s+'), '_')
        .replaceAll(RegExp(r'[^a-z0-9_-]'), '');
    return cleaned.length > 32 ? cleaned.substring(0, 32) : cleaned;
  }
}

/// The app's one recorder.
final SpeedMarks speedMarks = SpeedMarks();
