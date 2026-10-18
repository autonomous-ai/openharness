import 'dart:async';
import 'dart:io' show Platform;
import 'dart:ui' show FramePhase, FrameTiming;

import 'package:flutter/scheduler.dart';

import 'app_log.dart';

/// The launch's frames, timed for its first [_span] and written as one `startup frames` line —
/// whether the screen held still while the machines behind it were dialling.
///
/// ⚠️ **Why (owner, 2026-10-02).** A large account dials six to nine machines once the terminal
/// on screen is up, each with a key mint, a decrypt, an agent list to parse and a cache to write,
/// all on the UI thread. Whether that reads as a stutter is a question about frames, and the
/// startup timeline (`startup_trace.dart`) only says when each step ran. Bucketed by two seconds
/// from the first frame, so a burst lines up with the `launch: dialling …` marks around it.
///
/// ```
/// startup frames from the first · 0-2s 61 (2 slow, worst build 31ms raster 9ms) · 2-4s 58 (0 slow…)
/// ```
///
/// A frame is drawn only when something changed: a bucket with few frames is a still screen,
/// not a slow one. Off under `flutter test`, whose widget trees do not outlive the timer.
abstract final class LaunchFrames {
  static const _span = Duration(seconds: 20);
  static const _bucket = Duration(seconds: 2);

  /// A frame slower than this to build or to raster is a dropped one at 60 Hz.
  static const _frameBudget = Duration(microseconds: 16667);

  static bool _watching = false;

  /// Start timing; once per process.
  static void watch() {
    if (_watching || Platform.environment.containsKey('FLUTTER_TEST')) return;
    _watching = true;
    final buckets = <int, _Bucket>{};
    int? firstVsync;
    void onTimings(List<FrameTiming> timings) {
      for (final timing in timings) {
        final vsync = timing.timestampInMicroseconds(FramePhase.vsyncStart);
        final origin = firstVsync ??= vsync;
        final at = vsync - origin;
        if (at > _span.inMicroseconds) continue;
        buckets
            .putIfAbsent(at ~/ _bucket.inMicroseconds, _Bucket.new)
            .add(timing);
      }
    }

    SchedulerBinding.instance.addTimingsCallback(onTimings);
    // The engine reports timings in batches; a little past the span lets the last one in.
    Timer(_span + const Duration(seconds: 2), () {
      SchedulerBinding.instance.removeTimingsCallback(onTimings);
      final seconds = _bucket.inSeconds;
      final parts = [
        for (final index in buckets.keys.toList()..sort())
          '${index * seconds}-${(index + 1) * seconds}s ${buckets[index]}',
      ];
      appLog.info(
        'startup',
        'frames from the first · '
            '${parts.isEmpty ? 'none' : parts.join(' · ')}',
      );
    });
  }
}

class _Bucket {
  int frames = 0;
  int slow = 0;
  Duration worstBuild = Duration.zero;
  Duration worstRaster = Duration.zero;

  void add(FrameTiming timing) {
    frames++;
    final build = timing.buildDuration;
    final raster = timing.rasterDuration;
    if (build > LaunchFrames._frameBudget ||
        raster > LaunchFrames._frameBudget) {
      slow++;
    }
    if (build > worstBuild) worstBuild = build;
    if (raster > worstRaster) worstRaster = raster;
  }

  @override
  String toString() =>
      '$frames ($slow slow, worst build ${worstBuild.inMilliseconds}ms '
      'raster ${worstRaster.inMilliseconds}ms)';
}
