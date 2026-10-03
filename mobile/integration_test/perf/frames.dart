import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// Wall-clock microseconds, the clock every dispatch time here is taken on.
///
/// FrameTiming carries its phases on the engine's monotonic clock plus ONE
/// wall-clock stamp (raster finish), which is what lets a dispatch taken here be
/// placed against them — see [FrameClock.wall].
int wallMicros() => DateTime.now().microsecondsSinceEpoch;

/// Asks for a frame and waits for it; answers the engine's number for it, the
/// key its [ui.FrameTiming] arrives under.
///
/// The desktop benchmark's `_frame()`: a post-frame callback reads the number
/// of the frame it runs in, and a forced schedule makes sure there is one even
/// when nothing is dirty. The zero delay lets a focus or setState requested
/// from a post-frame callback land before the caller acts again.
Future<int> nextFrame() async {
  final done = Completer<int>();
  SchedulerBinding.instance.addPostFrameCallback((_) {
    done.complete(ui.PlatformDispatcher.instance.frameData.frameNumber);
  });
  SchedulerBinding.instance.scheduleFrame();
  final number = await done.future;
  await Future<void>.delayed(Duration.zero);
  return number;
}

/// The frame number of the frame currently being produced, read inside a
/// post-frame callback — for observers that must not force a frame themselves.
int currentFrameNumber() =>
    ui.PlatformDispatcher.instance.frameData.frameNumber;

/// Every [ui.FrameTiming] the engine reports, by frame number, for the life of
/// the run.
class FrameClock {
  FrameClock() {
    SchedulerBinding.instance.addTimingsCallback(_take);
  }

  final Map<int, ui.FrameTiming> byNumber = {};
  final List<ui.FrameTiming> all = [];

  void _take(List<ui.FrameTiming> timings) {
    for (final timing in timings) {
      byNumber[timing.frameNumber] = timing;
      all.add(timing);
    }
  }

  void dispose() => SchedulerBinding.instance.removeTimingsCallback(_take);

  /// A phase of [timing] on the wall clock — the desktop benchmark's join: the
  /// engine stamps raster finish on both clocks, so their difference moves any
  /// other phase onto the wall clock.
  static int wall(ui.FrameTiming timing, ui.FramePhase phase) =>
      timing.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime) -
      timing.timestampInMicroseconds(ui.FramePhase.rasterFinish) +
      timing.timestampInMicroseconds(phase);

  /// Waits until every frame in [numbers] has its timing. The engine batches
  /// its reports (every 100 ms or 100 frames outside release), so the last
  /// frames of a series need a nudge and a moment.
  Future<void> waitFor(Iterable<int> numbers) async {
    final wanted = numbers.toSet();
    for (var attempt = 0; attempt < 40; attempt++) {
      if (wanted.every(byNumber.containsKey)) return;
      await nextFrame();
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    final missing = wanted.where((n) => !byNumber.containsKey(n)).toList();
    throw StateError('No FrameTiming for frames $missing');
  }

  /// Waits for timings to cover everything up to [untilWall] (wall micros).
  Future<void> settleUntil(int untilWall) async {
    for (var attempt = 0; attempt < 40; attempt++) {
      if (all.isNotEmpty &&
          wall(all.last, ui.FramePhase.rasterFinish) >= untilWall) {
        return;
      }
      await nextFrame();
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
  }

  /// Frames whose build began inside [startWall, endWall).
  List<ui.FrameTiming> between(int startWall, int endWall) => [
    for (final timing in all)
      if (wall(timing, ui.FramePhase.buildStart) >= startWall &&
          wall(timing, ui.FramePhase.buildStart) < endWall)
        timing,
  ];
}

/// Nearest-rank percentiles over individual observations, in milliseconds —
/// the same rule as `desktop/tool/native_benchmark/summarize_results.py`.
Map<String, num> distribution(List<int> micros) {
  if (micros.isEmpty) return {'samples': 0};
  final values = [...micros]..sort();
  double at(double q) => values[(values.length * q).ceil() - 1] / 1000;
  return {
    'samples': values.length,
    'p50Ms': at(.5),
    'p95Ms': at(.95),
    'p99Ms': at(.99),
    'maxMs': values.last / 1000,
  };
}

/// One refresh at the iPhone 14's 60 Hz — the budget a frame has to fit.
const int frameBudgetMicros = 16667;

/// Per-frame statistics for a window of frames: build (UI thread), raster,
/// vsync overhead and total span, as the engine reports them.
Map<String, Object?> frameStats(
  List<ui.FrameTiming> frames, {
  required int windowMicros,
}) {
  List<int> pick(int Function(ui.FrameTiming) f) => [
    for (final t in frames) f(t),
  ];
  final build = pick((t) => t.buildDuration.inMicroseconds);
  final raster = pick((t) => t.rasterDuration.inMicroseconds);
  final vsync = pick((t) => t.vsyncOverhead.inMicroseconds);
  final total = pick((t) => t.totalSpan.inMicroseconds);
  int over(List<int> values) =>
      values.where((v) => v > frameBudgetMicros).length;
  return {
    'frames': frames.length,
    'windowMs': windowMicros / 1000,
    'framesPerSecond': frames.length / (windowMicros / 1e6),
    'buildMs': distribution(build),
    'rasterMs': distribution(raster),
    'vsyncOverheadMs': distribution(vsync),
    'totalSpanMs': distribution(total),
    'framesOverBudget': {
      'budgetMs': frameBudgetMicros / 1000,
      'build': over(build),
      'raster': over(raster),
      'totalSpan': over(total),
    },
    'uiBusyShare': build.fold<int>(0, (a, b) => a + b) / windowMicros,
    'rasterBusyShare': raster.fold<int>(0, (a, b) => a + b) / windowMicros,
    // Every frame, so runs can be pooled observation by observation rather
    // than by averaging percentiles: [frame number, build, raster, vsync
    // overhead, total span] in microseconds.
    'rawColumns': [
      'frame',
      'buildUs',
      'rasterUs',
      'vsyncOverheadUs',
      'totalSpanUs',
    ],
    'raw': [
      for (final t in frames)
        [
          t.frameNumber,
          t.buildDuration.inMicroseconds,
          t.rasterDuration.inMicroseconds,
          t.vsyncOverhead.inMicroseconds,
          t.totalSpan.inMicroseconds,
        ],
    ],
  };
}

/// Every element under the root whose widget matches, skipping offstage
/// subtrees — the desktop benchmark's `_find`, but collecting.
List<Element> findElements(bool Function(Widget) matches) {
  final found = <Element>[];
  void visit(Element element) {
    if (element.widget case Offstage(offstage: true)) return;
    if (matches(element.widget)) found.add(element);
    element.visitChildElements(visit);
  }

  WidgetsBinding.instance.rootElement?.visitChildElements(visit);
  return found;
}

Element? findElement(bool Function(Widget) matches) {
  final all = findElements(matches);
  return all.isEmpty ? null : all.first;
}
