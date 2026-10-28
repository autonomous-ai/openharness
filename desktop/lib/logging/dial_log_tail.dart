import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'app_log.dart';
import 'log_file.dart';
import 'log_stream.dart';

/// Base name of the dial's per-day files under `~/.harness/logs`, written by the
/// CLI daemon (`cli/src/cable/dialLog.ts`), never by this app.
const String kDialLogBase = 'dial';

/// Prefix of one device's log folder under `~/.harness/logs`: the daemon
/// writes each dial and Pro to `usb-<id>/dial-YYYYMMDD.log`
/// (`cli/src/cable/cableFleet.ts` `logFolder`).
const String kDialDeviceFolderPrefix = 'usb-';

/// Follows the dial logs into the in-memory [LogStream], so the dials are a
/// source in Settings ▸ Debug beside the app's own.
///
/// The other sources are *mirrors* — the app writes the file and the ring at
/// once. This one cannot be: the daemon writes the dial's files, and the app
/// only reads them. So it tails: every second it reads whatever bytes were
/// appended since last time, one entry per line, category `dial`.
///
/// Each plugged-in device has its own folder, `usb-<id>/dial-YYYYMMDD.log`,
/// and its lines are tagged `[<id>]` so two dials stay apart (the Debug
/// search finds one by its id). A folder is followed while it has a file for
/// today, at most [maxDevices] of them; one that appears later is picked up on
/// the next poll, and one that goes, or has no file for the new day, is
/// dropped. A daemon older than the per-device folders wrote one top-level
/// `dial-YYYYMMDD.log`, still read, untagged.
///
/// Levels come from the line itself: the firmware's `W (ticks)` / `E (ticks)`
/// prefixes, and a `[daemon]` line is the daemon speaking. The file is the
/// truth; a parse that fails still shows the raw line.
class DialLogTail {
  DialLogTail(
    this.directory,
    this.stream, {
    DateTime Function()? clock,
    this.interval = const Duration(seconds: 1),
    this.maxDevices = 16,
  }) : _clock = clock ?? DateTime.now;

  final Directory directory;
  final LogStream stream;
  final Duration interval;

  /// How many device folders are tailed at once. Folders past it are said
  /// once in the stream rather than silently left out.
  final int maxDevices;

  final DateTime Function() _clock;

  Timer? _timer;
  Future<void>? _polling;
  late final _DayFileTail _topLevel = _DayFileTail(directory, null, stream);
  final Map<String, _DayFileTail> _devices = {};
  bool _saidOverCap = false;

  /// The device ids whose folders are followed now, sorted.
  List<String> get devices => _devices.keys.toList()..sort();

  void start() {
    _timer ??= Timer.periodic(interval, (_) => unawaited(poll()));
    unawaited(poll());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// One read of whatever is new. Public so a test can drive it without a
  /// timer; safe to call when nothing changed. A call made while one is still
  /// reading joins it, so the timer never reads the same bytes twice.
  Future<void> poll() =>
      _polling ??= _pollOnce().whenComplete(() => _polling = null);

  Future<void> _pollOnce() async {
    final name = dailyLogName(kDialLogBase, _clock());
    await _topLevel.poll(name);
    final present = await _deviceIdsWithFile(name);
    _devices.removeWhere((id, _) => !present.contains(id));
    final waiting = present.where((id) => !_devices.containsKey(id)).toList()
      ..sort();
    for (final id in waiting) {
      if (_devices.length >= maxDevices) break;
      _devices[id] = _DayFileTail(
        Directory('${directory.path}/$kDialDeviceFolderPrefix$id'),
        id,
        stream,
      );
    }
    final left = present.length - _devices.length;
    if (left > 0 && !_saidOverCap) {
      stream.add(
        AppLogLevel.warn,
        'dial',
        '$left more dial log${left == 1 ? '' : 's'} not followed '
            '(limit $maxDevices)',
      );
    }
    _saidOverCap = left > 0;
    for (final id in devices) {
      await _devices[id]!.poll(name);
    }
  }

  /// Ids of the `usb-<id>` folders holding a [name] file; empty when the logs
  /// folder cannot be read.
  Future<Set<String>> _deviceIdsWithFile(String name) async {
    final ids = <String>{};
    try {
      await for (final entity in directory.list()) {
        if (entity is! Directory) continue;
        final folder = entity.uri.pathSegments.lastWhere((s) => s.isNotEmpty);
        if (!folder.startsWith(kDialDeviceFolderPrefix)) continue;
        if (!await File('${entity.path}/$name').exists()) continue;
        ids.add(folder.substring(kDialDeviceFolderPrefix.length));
      }
    } on Object {
      // No logs folder yet, or one being removed: nothing to follow.
    }
    return ids;
  }
}

/// Follows one folder's day file: on a new day (or the first poll) it starts
/// from the last [_catchUpBytes], enough for the recent context without
/// replaying a whole day into a 500-entry ring.
class _DayFileTail {
  _DayFileTail(this.folder, this.device, this.stream);

  final Directory folder;

  /// The `[id]` each line is tagged with; null for the untagged top-level file.
  final String? device;
  final LogStream stream;

  static const int _catchUpBytes = 16 * 1024;

  String? _day;
  int _offset = 0;
  String _partial = '';
  // Set when the catch-up window opened mid-line: the first "line" read is a
  // fragment and is dropped rather than shown as a half sentence.
  bool _dropFirst = false;

  Future<void> poll(String day) async {
    try {
      final file = File('${folder.path}/$day');
      if (day != _day) {
        _day = day;
        _partial = '';
        _offset = 0;
        _dropFirst = false;
        if (await file.exists()) {
          final length = await file.length();
          if (length > _catchUpBytes) {
            _offset = length - _catchUpBytes;
            _dropFirst = true;
          }
        }
      }
      if (!await file.exists()) return;
      final length = await file.length();
      if (length < _offset) _offset = 0; // truncated or replaced — start over
      if (length == _offset) return;
      final handle = await file.open();
      try {
        await handle.setPosition(_offset);
        final bytes = await handle.read(length - _offset);
        _offset = length;
        _ingest(const Utf8Decoder(allowMalformed: true).convert(bytes));
      } finally {
        await handle.close();
      }
    } on Object {
      // A log reader must never become a source of log noise about itself.
    }
  }

  void _ingest(String chunk) {
    final text = _partial + chunk;
    final lines = text.split('\n');
    _partial = lines
        .removeLast(); // '' after a trailing newline, else a fragment
    for (final line in lines) {
      if (_dropFirst) {
        _dropFirst = false;
        continue;
      }
      if (line.isEmpty) continue;
      final parsed = parseDialLine(line);
      final tag = device;
      stream.add(
        parsed.level,
        'dial',
        tag == null ? parsed.message : '[$tag] ${parsed.message}',
      );
    }
  }
}

/// One dial log line, minus its wall-clock stamp, with a level read off it.
typedef ParsedDialLine = ({AppLogLevel level, String message});

/// `2026-09-15T03:53:52.001Z W (27793) touch: …` → warn, `W (27793) touch: …`.
/// `2026-09-15T03:56:22.418Z [daemon] following …` → info, `[daemon] following …`.
ParsedDialLine parseDialLine(String line) {
  final space = line.indexOf(' ');
  final message = space > 0 && line[space - 1] == 'Z'
      ? line.substring(space + 1)
      : line;
  final level = message.startsWith('E (')
      ? AppLogLevel.error
      : message.startsWith('W (')
      ? AppLogLevel.warn
      : message.startsWith('D (') || message.startsWith('V (')
      ? AppLogLevel.debug
      : AppLogLevel.info;
  return (level: level, message: message);
}
