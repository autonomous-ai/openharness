import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:xterm/utils.dart' show xtermInputTrace;

import 'app_log.dart';

/// The typing trace: typing into a terminal on a phone, traced key by key — and the costs around
/// it (Find opening, switching agent). Built in only when asked for:
///
/// ```
/// flutter run --profile --dart-define=HARNESS_TYPING_TRACE=true
/// ```
///
/// Every step a keystroke takes is written to the app log under `type`, stamped with a millisecond
/// clock (`t=`): the keyboard's edit (`ime ←`), what of it reached the terminal (`ime → pty`,
/// `view insert`), what went to the machine (`pty in`, `pty sent`), what came back (`out`), what it
/// cost to draw (`paint`, `frame SLOW`), and everything that can lose or delay a keystroke on the
/// way — a dropped send, a resync, a keyframe swapping the terminal, the keyboard's buffer being
/// reset. How to read it: `.claude/autonomous-harness-mobile-performance.vi.md`.
///
/// ⚠️ **Off unless asked for, and it has to stay that way.** The trace carries the tail of what was
/// typed — passwords typed at a prompt included — so a build that ships must never have it on.
/// `const`, so every call site guarded by it compiles away when it is off.
const bool kTypingTrace = bool.fromEnvironment('HARNESS_TYPING_TRACE');

final Stopwatch _clock = Stopwatch()..start();

/// The trace clock, in milliseconds.
int typingNowMs() => _clock.elapsedMilliseconds;

/// When something was last typed — what [typingNote] and the frame and counter reports stay on
/// for, for [_window] after.
int _lastTypedMs = -1 << 30;
const _window = 3000;

bool get _typing => typingNowMs() - _lastTypedMs < _window;

/// Something typed, or on its way to the machine: always written, and it opens the window.
void typingTrace(String message) {
  if (!kTypingTrace) return;
  _lastTypedMs = typingNowMs();
  _write(message);
}

/// Something that can lose or delay a keystroke — a resync, a keyframe, a reset: always written.
void typingEvent(String message) {
  if (kTypingTrace) _write(message);
}

/// Something that happens all the time — output arriving, a paint: written only while somebody is
/// typing, so an agent streaming on its own does not fill the log.
void typingNote(String message) {
  if (kTypingTrace && _typing) _write(message);
}

void _write(String message) =>
    appLog.debug('type', 't=${typingNowMs()} $message');

final Map<String, int> _counts = {};
Timer? _countsTimer;

/// One more [what] — a notify, a rebuild — reported as a count per second while somebody is
/// typing.
void typingCount(String what) {
  if (!kTypingTrace || !_typing) return;
  _counts.update(what, (count) => count + 1, ifAbsent: () => 1);
  _countsTimer ??= Timer(const Duration(seconds: 1), _flushCounts);
}

void _flushCounts() {
  _countsTimer = null;
  if (_counts.isEmpty) return;
  final counts = _counts.entries
      .map((entry) => '${entry.key}=${entry.value}')
      .join(' ');
  _counts.clear();
  _write('counts/1s $counts');
}

/// Hooks the trace up: xterm's input path, and the frame timings. Called once, from
/// `installFileLogs`.
void installTypingTrace() {
  if (!kTypingTrace) return;
  xtermInputTrace = (message) =>
      message.startsWith('paint') ? typingNote(message) : typingTrace(message);
  SchedulerBinding.instance.addTimingsCallback(_frames);
}

/// Frames slower than one at 60 Hz while somebody types — on which thread the time went.
void _frames(List<FrameTiming> timings) {
  if (!_typing) return;
  for (final timing in timings) {
    final build = timing.buildDuration.inMicroseconds / 1000;
    final raster = timing.rasterDuration.inMicroseconds / 1000;
    if (build < 16 && raster < 16) continue;
    _write(
      'frame SLOW build=${build.toStringAsFixed(1)}ms'
      ' raster=${raster.toStringAsFixed(1)}ms'
      ' total=${(timing.totalSpan.inMicroseconds / 1000).toStringAsFixed(1)}ms',
    );
  }
}
