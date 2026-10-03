import 'dart:async';
import 'dart:developer' as developer;
import 'dart:io';

import '../core/harness_file_store.dart';
import 'log_append.dart';

/// Best-effort append-only diagnostic log split into one file per calendar day
/// (`<base>-YYYYMMDD.log`) inside a directory.
///
/// Ported from Grid (`autonomous-grid-app/lib/infrastructure/logging/`) rather
/// than reinvented — same rotation rules, same swallow-everything discipline,
/// so a log line means the same thing in both products. Keep the two in step.
///
/// Why per-day: a single ever-growing file eventually becomes too big to open or
/// send us, and a size-based `.old` rotation keeps only the last slice. Dated
/// files let anything past [retentionDays] be pruned automatically. This caps
/// retained age, not a busy day's byte count.
///
/// Immediate writes are synchronous and flushed. Routine diagnostics may opt
/// into bounded batches; an immediate write also commits the pending context.
/// Every IO error is swallowed — diagnostics must never break the flow they
/// only observe.
class DailyLogFile {
  DailyLogFile(
    this.directory,
    this.base, {
    this.retentionDays = 14,
    this.bufferInterval = const Duration(seconds: 1),
    this.maxBufferedCharacters = 64 * 1024,
    this.maxBufferedEntries = 256,
    this.appendFile = appendDurableLog,
    DateTime Function() clock = DateTime.now,
    // The field is private, so an initialising formal would name the
    // PARAMETER `_clock` — which no caller outside this library could pass.
    // The clock is injected by tests.
  }) : assert(bufferInterval > Duration.zero),
       assert(maxBufferedCharacters > 0),
       assert(maxBufferedEntries > 0),
       // ignore: prefer_initializing_formals
       _clock = clock;

  /// The app's own log directory, `~/.harness/logs`.
  ///
  /// Through [HarnessFileStore.defaultDirectoryPath] rather than a second path
  /// helper: one place already knows how to find `~/.harness` on every platform
  /// this ships to, including the Windows fallbacks.
  static Directory get defaultDirectory =>
      Directory(HarnessFileStore.defaultDirectoryPath(name: 'logs'));

  /// Directory holding the dated files. Created on demand.
  final Directory directory;

  /// Filename stem shared by every day's file — `app` → `app-YYYYMMDD.log`.
  final String base;

  /// Keep at most this many days of this base's files; older ones are deleted
  /// the first time a new day is written. A value `<= 0` disables pruning.
  final int retentionDays;

  /// A one-shot deadline from the first pending entry, never an idle poll.
  final Duration bufferInterval;

  /// Bound both text and entry overhead during bursts. Oversized entries are
  /// written directly; they cannot remain in the pending buffer.
  final int maxBufferedCharacters;
  final int maxBufferedEntries;

  /// Durable append implementation, injectable for measurements using real IO.
  final void Function(File file, String contents) appendFile;

  final List<String> _pending = [];
  int _pendingCharacters = 0;
  DateTime? _pendingAt;
  Timer? _bufferTimer;

  final DateTime Function() _clock;

  /// `YYYYMMDD` of the file we last wrote, so pruning only runs when the day
  /// actually rolls over — not on every append.
  String? _activeDay;

  /// The file the next [append] would write to, for the current wall-clock day.
  /// Exposed so callers (and tests) can read back what was just written.
  File get currentFile => _fileFor(_clock());

  File _fileFor(DateTime day) =>
      File('${directory.path}/${dailyLogName(base, day)}');

  /// Append [block] followed by a newline to today's file. Creates the directory
  /// on demand and prunes stale days on the first write after midnight; any
  /// failure is swallowed.
  void append(String block, {bool buffered = false}) {
    try {
      final now = _clock();
      if (_pendingAt case final at? when _ymd(at) != _ymd(now)) {
        // A timer firing after midnight must not move yesterday's records into
        // today's file. The same rule handles a wall-clock correction.
        flush();
      }
      if (!buffered || block.length + 1 >= maxBufferedCharacters) {
        if (_pending.isEmpty) {
          _appendNow(block, now);
        } else {
          // The diagnostic and the lines leading to it share one durable write.
          _pending.add(block);
          flush();
        }
        return;
      }
      if (_pendingCharacters + block.length + 1 > maxBufferedCharacters) {
        flush();
      }
      _pendingAt ??= now;
      _pending.add(block);
      _pendingCharacters += block.length + 1;
      if (_pending.length >= maxBufferedEntries ||
          _pendingCharacters >= maxBufferedCharacters) {
        flush();
      } else {
        _bufferTimer ??= Timer(bufferInterval, flush);
      }
    } catch (e) {
      _debugLog('DailyLogFile.append failed: $e');
    }
  }

  /// Commit any pending batch and cancel its timer. Empty flushes do no IO.
  /// Called on errors, export, backgrounding, normal quit and updater handoff.
  void flush() {
    _bufferTimer?.cancel();
    _bufferTimer = null;
    if (_pending.isEmpty) return;
    final block = _pending.join('\n');
    final at = _pendingAt!;
    // Release the batch even on disk failure, matching append's best-effort
    // behavior without retaining an unbounded retry queue.
    _pending.clear();
    _pendingCharacters = 0;
    _pendingAt = null;
    _appendNow(block, at);
  }

  void _appendNow(String block, DateTime now) {
    try {
      final day = _ymd(now);
      final file = _fileFor(now);
      file.parent.createSync(recursive: true);
      if (day != _activeDay) {
        _activeDay = day;
        _pruneOlderThan(now);
      }
      appendFile(file, '$block\n');
    } catch (e) {
      // Best-effort: never surface an IO failure into the caller's flow.
      _debugLog('DailyLogFile.append failed: $e');
    }
  }

  /// Delete this base's dated files older than [retentionDays] before [now].
  void _pruneOlderThan(DateTime now) {
    if (retentionDays <= 0) return;
    try {
      final cutoff = _ymd(now.subtract(Duration(days: retentionDays)));
      final prefix = '$base-';
      for (final entry in directory.listSync()) {
        if (entry is! File) continue;
        final name = entry.uri.pathSegments.last;
        if (!name.startsWith(prefix) || !name.endsWith('.log')) continue;
        final day = name.substring(prefix.length, name.length - 4);
        if (day.length == 8 &&
            int.tryParse(day) != null &&
            day.compareTo(cutoff) < 0) {
          entry.deleteSync();
        }
      }
    } catch (e) {
      // Pruning is best-effort; on failure the old files simply stay put.
      _debugLog('DailyLogFile._pruneOlderThan failed: $e');
    }
  }
}

/// Debug-only diagnostic for a swallowed log-sink IO failure. A log sink cannot
/// route its own failure through the app's log stack without recursing, so this
/// uses `dart:developer` directly — the one deliberate exception. `assert`
/// strips it from release builds, so it never adds noise to a shipped app.
void _debugLog(String message) {
  assert(() {
    developer.log(message);
    return true;
  }());
}

/// The dated filename for [base] on [day]: `app` → `app-20260907.log`.
String dailyLogName(String base, DateTime day) => '$base-${_ymd(day)}.log';

/// `YYYY-MM-DD HH:MM:SS` — a full wall-clock stamp for section headers.
String logStamp(DateTime t) =>
    '${t.year}-${_pad2(t.month)}-${_pad2(t.day)} ${logClock(t)}';

/// `HH:MM:SS` — a compact clock stamp for per-line entries.
String logClock(DateTime t) =>
    '${_pad2(t.hour)}:${_pad2(t.minute)}:${_pad2(t.second)}';

/// A short human duration: `${m}m${s}s` past a minute, else `${s}s`.
String logDuration(Duration d) {
  final s = d.inSeconds;
  return s >= 60 ? '${s ~/ 60}m${s % 60}s' : '${s}s';
}

/// `YYYYMMDD` — the compact calendar-day stamp used in daily log filenames.
String _ymd(DateTime t) =>
    '${t.year.toString().padLeft(4, '0')}${_pad2(t.month)}${_pad2(t.day)}';

String _pad2(int n) => n.toString().padLeft(2, '0');
