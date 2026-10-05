import 'dart:async';
import 'dart:developer' as developer;
import 'dart:io';

import '../core/harness_file_store.dart';

/// Best-effort append-only diagnostic log split into one file per calendar day
/// (`<base>-YYYYMMDD.log`) inside a directory.
///
/// Ported from Grid (`autonomous-grid-app/lib/infrastructure/logging/`) rather
/// than reinvented — same rotation rules, same swallow-everything discipline,
/// so a log line means the same thing in both products. Keep the two in step.
///
/// Why per-day: a single ever-growing file eventually becomes too big to open or
/// send us, and a size-based `.old` rotation keeps only the last slice. Dating
/// the file caps each day's size on its own and lets anything past
/// [retentionDays] be pruned automatically, so the directory stays bounded
/// without ever discarding the current session.
///
/// Writes are synchronous and flushed so a line survives even if the app is
/// force-quit mid-write, and every IO error is swallowed — diagnostic logging
/// must never break the flow it only observes.
///
/// ⚠️ **Unless [batch] is set, which the app's own log does** (`installFileLogs`).
/// A write and an fsync PER LINE is milliseconds on a phone's flash, on the UI
/// isolate, and a machine reconciling its agents is a burst of lines: frames
/// dropped, under somebody typing. Batched, lines wait up to [batch] and go
/// out in one write, without the fsync — a write that has reached the kernel
/// survives the app being killed, which is the loss the fsync was there for;
/// what it adds is surviving the PHONE going down. [flush] puts them out at
/// once, durably when asked: an error does, and so does the app on its way to
/// the background.
class DailyLogFile {
  DailyLogFile(
    this.directory,
    this.base, {
    this.retentionDays = 14,
    this.batch,
    DateTime Function() clock = DateTime.now,
    // The field is private, so an initialising formal would name the
    // PARAMETER `_clock` — which no caller outside this library could pass.
    // The clock is injected by tests.
    // ignore: prefer_initializing_formals
  }) : _clock = clock;

  /// How long a line may wait to go out with the ones after it. Null — the
  /// default — writes and flushes every line as it comes.
  final Duration? batch;

  /// The lines waiting for [batch], and the moment the first of them was
  /// appended — which names the day's file they go to.
  final StringBuffer _pending = StringBuffer();
  DateTime? _pendingSince;
  Timer? _batchTimer;

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
  /// failure is swallowed. With [batch] set the line waits for the next [flush].
  void append(String block) {
    final now = _clock();
    final wait = batch;
    if (wait == null) {
      _write(now, '$block\n', durable: true);
      return;
    }
    // A line of a new day: what is waiting belongs to the day before, and its file.
    final since = _pendingSince;
    if (since != null && _ymd(since) != _ymd(now)) flush();
    _pendingSince ??= now;
    _pending
      ..write(block)
      ..write('\n');
    _batchTimer ??= Timer(wait, flush);
  }

  /// Writes every line [batch] is holding, now, in one write — and to disk
  /// before returning when [durable]. Nothing to do without [batch].
  void flush({bool durable = false}) {
    _batchTimer?.cancel();
    _batchTimer = null;
    final since = _pendingSince;
    if (since == null) return;
    final text = _pending.toString();
    _pending.clear();
    _pendingSince = null;
    _write(since, text, durable: durable);
  }

  void _write(DateTime at, String text, {required bool durable}) {
    try {
      final day = _ymd(at);
      final file = _fileFor(at);
      file.parent.createSync(recursive: true);
      if (day != _activeDay) {
        _activeDay = day;
        _pruneOlderThan(at);
      }
      file.writeAsStringSync(text, mode: FileMode.append, flush: durable);
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
