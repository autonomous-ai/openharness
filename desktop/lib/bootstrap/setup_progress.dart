import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'environment_provisioner.dart';

/// What the setup tour shows of a fresh computer's install: one bar, the time
/// left, and whether Harness can open.
///
/// The tour reads nothing else, so the estimate behind it can change (or a
/// test can hand in fixed values) without touching the screen.
@immutable
class SetupProgress {
  const SetupProgress({
    required this.fraction,
    this.left,
    this.done = false,
    this.failed = false,
    this.failure,
  });

  static const starting = SetupProgress(fraction: 0);

  /// 0..1. Stays below 1 until [done], however long setup overruns its
  /// estimate — a full bar that keeps the window shut reads as a hang.
  final double fraction;

  /// About how long is left. Null once the estimate has run out: a guess past
  /// its own deadline is worse than none.
  final Duration? left;

  /// Setup, the app's own start and every pending download are finished:
  /// Harness can open.
  final bool done;

  /// Setup stopped and needs Retry.
  final bool failed;

  /// What stopped it, in the provisioner's words.
  final String? failure;

  @override
  bool operator ==(Object other) =>
      other is SetupProgress &&
      other.fraction == fraction &&
      other.left == left &&
      other.done == done &&
      other.failed == failed &&
      other.failure == failure;

  @override
  int get hashCode => Object.hash(fraction, left, done, failed, failure);

  @override
  String toString() =>
      'SetupProgress(${(fraction * 100).toStringAsFixed(1)}%, left: $left, '
      'done: $done, failed: $failed${failure == null ? '' : ', $failure'})';
}

/// What is still downloading beside setup — the agents a new person starts
/// on — as `AppNotifier.setupDownloads` reports it.
///
/// The download code owns this value; the tour only reads it. Harness opens
/// only once it says [done], so whoever starts a download must publish a
/// pending value before setup itself can finish (in practice: when the
/// install starts), or the window may open first.
@immutable
class SetupDownloads {
  const SetupDownloads({
    this.done = true,
    this.fraction,
    this.left,
    this.lines = const [],
  });

  /// Something is still downloading.
  const SetupDownloads.pending({
    this.fraction,
    this.left,
    this.lines = const [],
  }) : done = false;

  /// Nothing to wait for: the default, and what a computer that already has
  /// its agents reports throughout.
  static const none = SetupDownloads();

  /// True when nothing is left to wait for, including a download that failed
  /// and was given up on (the first harness installs it instead).
  final bool done;

  /// 0..1 of the bytes, when the downloader knows them.
  final double? fraction;

  /// The downloader's own estimate, when it has one.
  final Duration? left;

  /// One line per download for the tour's Details, e.g.
  /// `Agents: OpenCode ✓, Codex 61 of 137 MB`.
  final List<String> lines;

  @override
  bool operator ==(Object other) =>
      other is SetupDownloads &&
      other.done == done &&
      other.fraction == fraction &&
      other.left == left &&
      listEquals(other.lines, lines);

  @override
  int get hashCode => Object.hash(done, fraction, left, Object.hashAll(lines));
}

/// Turns the provisioner's steps, the clock and [SetupDownloads] into one
/// [SetupProgress], the way an OS installer does: time-based, steady, never
/// at 100% before it is.
///
/// The provisioner reports steps, not bytes, so the bar runs on how long each
/// step usually takes on a fresh computer and jumps ahead when a step
/// finishes early. It only ever moves forward.
class SetupProgressTracker extends ChangeNotifier
    implements ValueListenable<SetupProgress> {
  SetupProgressTracker({
    required this.setup,
    required this.readiness,
    required this.appReady,
    required this.downloads,
    DateTime Function()? now,
    Duration tick = const Duration(seconds: 1),
  }) : _now = now ?? DateTime.now {
    _start = _segmentStart = _now();
    setup.addListener(update);
    downloads.addListener(update);
    _ticker = Timer.periodic(tick, (_) => update());
    update();
  }

  /// How long each step usually takes when it has work to do, from fresh
  /// macOS VMs (2026-10-08: the whole first-run setup took 45–65 s).
  @visibleForTesting
  static const expected = <EnvironmentStep, Duration>{
    EnvironmentStep.tmux: Duration(seconds: 12),
    EnvironmentStep.clipboard: Duration(seconds: 6),
    EnvironmentStep.harness: Duration(seconds: 35),
  };

  /// After the last install step: the final check, the daemon's first start
  /// and the sign-in check, before the workspace can be shown.
  @visibleForTesting
  static const expectedStart = Duration(seconds: 6);

  /// Notifies when [readiness] or [appReady] may have changed.
  final Listenable setup;

  /// The provisioner's latest report.
  final EnvironmentReadiness Function() readiness;

  /// The app is past its own start (daemon, sign-in check) and can show its
  /// workspace. Waited for so the tour never hands over to a boot spinner.
  final bool Function() appReady;

  /// See [SetupDownloads].
  final ValueListenable<SetupDownloads> downloads;

  final DateTime Function() _now;
  late final Timer _ticker;

  late DateTime _start;
  late DateTime _segmentStart;

  /// Steps that had work to do at some point in this run, and when each was
  /// first seen done.
  final _work = <EnvironmentStep, DateTime?>{};
  DateTime? _appReadyAt;
  bool _wasFailed = false;
  double _highWater = 0;

  SetupProgress _value = SetupProgress.starting;

  @override
  SetupProgress get value => _value;

  /// Re-reads every input. Called on each change and once a second, so the
  /// time left counts down between provisioner updates.
  @visibleForTesting
  void update() {
    final next = _compute();
    if (next == _value) return;
    _value = next;
    notifyListeners();
  }

  SetupProgress _compute() {
    final now = _now();
    final readiness = this.readiness();
    final downloads = this.downloads.value;
    final failed = readiness.phase == EnvironmentSetupPhase.failed;
    if (failed) {
      _wasFailed = true;
      return SetupProgress(
        fraction: _highWater,
        failed: true,
        failure:
            readiness.failure?.title ??
            readiness.message ??
            'Setup could not finish',
      );
    }
    if (_wasFailed) {
      // Retry starts the clock again; the bar keeps what it had shown.
      _wasFailed = false;
      _start = _segmentStart = now;
    }

    for (final entry in readiness.steps.entries) {
      final settled =
          entry.value == EnvironmentStepStatus.ready ||
          entry.value == EnvironmentStepStatus.notApplicable;
      if (!settled) {
        _work[entry.key] = null;
      } else if (_work.containsKey(entry.key) && _work[entry.key] == null) {
        _work[entry.key] = now;
        _segmentStart = now;
      }
    }
    final installed = readiness.isReady;
    final appReady = installed && this.appReady();
    if (appReady && _appReadyAt == null) {
      _appReadyAt = now;
      _segmentStart = now;
    }

    final setupDone = installed && appReady;
    final done = setupDone && downloads.done;
    if (done) {
      _highWater = 1;
      return const SetupProgress(fraction: 1, left: Duration.zero, done: true);
    }

    // Remaining expected work, counted from the last time something finished.
    var remaining = Duration.zero;
    var total = Duration.zero;
    for (final entry in _work.entries) {
      final step = expected[entry.key] ?? const Duration(seconds: 10);
      total += step;
      if (entry.value == null) remaining += step;
    }
    total += expectedStart;
    if (!appReady) remaining += expectedStart;
    final setupLeft = setupDone
        ? Duration.zero
        : remaining - now.difference(_segmentStart);

    Duration? left;
    if (!setupDone && setupLeft > Duration.zero) left = setupLeft;
    if (!downloads.done) {
      final downloadLeft = downloads.left;
      left = downloadLeft == null
          ? (setupDone ? null : left)
          : (left == null || downloadLeft > left ? downloadLeft : left);
    }

    final elapsed = now.difference(_start);
    double fraction;
    if (left != null && left > Duration.zero) {
      fraction =
          0.9 *
          elapsed.inMilliseconds /
          (elapsed.inMilliseconds + left.inMilliseconds);
    } else {
      // Past the estimate: creep from 90% towards 99%, slower the longer the
      // whole was expected to take, and never to the end.
      final over = (elapsed - total).inMilliseconds.clamp(0, 1 << 40);
      final scale = math.max(total.inMilliseconds, 1);
      fraction = 0.9 + 0.09 * (1 - math.exp(-over / scale));
    }
    final downloadFraction = downloads.done ? null : downloads.fraction;
    if (downloadFraction != null) {
      fraction = math.min(fraction, 0.99 * downloadFraction.clamp(0.0, 1.0));
    }
    _highWater = math.max(_highWater, fraction.clamp(0.0, 0.99));
    return SetupProgress(fraction: _highWater, left: left);
  }

  @override
  void dispose() {
    _ticker.cancel();
    setup.removeListener(update);
    downloads.removeListener(update);
    super.dispose();
  }
}
