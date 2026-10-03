import 'dart:async';
import 'dart:math';

/// Deadlines that a closed lid does not spend.
///
/// Dart's timers do not stop while a Mac sleeps: a `Timer(10s)` armed before the lid closed fires on
/// the first event-loop turn after it opens, however long the machine was asleep. Measured
/// 2026-09-29: an `agents_list` asked of this computer's own daemon "timed out" at 19:06:11, the
/// instant the machine woke, and its answer arrived at 19:06:12 — and that false timeout marked the
/// local machine offline over a socket that had never dropped. `cli/src/lib/sleepAware.ts` is the
/// same idea on the daemon's side.
///
/// No clock is read. A periodic timer that comes due late runs its callback ONCE and skips the
/// periods it missed (the VM advances `Timer.tick` instead of replaying them), so counting only the
/// callbacks that arrived on time counts time the process was actually running. Under `fakeAsync`
/// every period runs on time, which is why tests that pump through a timeout still see it fire.
class SleepAwareTimer implements Timer {
  /// Runs [callback] once [duration] of AWAKE time has passed. Counted in at most one-second steps, so
  /// a long deadline is kept to the second and a short one exactly.
  SleepAwareTimer(Duration duration, void Function() callback) {
    if (duration <= Duration.zero) {
      _timer = Timer(Duration.zero, callback);
      return;
    }
    final steps = max(
      1,
      (duration.inMicroseconds / _maxStep.inMicroseconds).ceil(),
    );
    final step = Duration(microseconds: duration.inMicroseconds ~/ steps);
    var lastTick = 0;
    _timer = Timer.periodic(step, (timer) {
      // A step the process slept through (or sat blocked through) is not counted — not even the
      // last one, which is what would otherwise make a short deadline fire straight after a wake.
      final onTime = !sleptSinceTick(timer, lastTick);
      lastTick = timer.tick;
      if (!onTime) return;
      _counted++;
      if (_counted < steps) return;
      timer.cancel();
      callback();
    });
  }

  static const _maxStep = Duration(seconds: 1);

  late final Timer _timer;
  int _counted = 0;

  @override
  void cancel() => _timer.cancel();

  @override
  bool get isActive => _timer.isActive;

  /// Steps counted so far — awake steps, unlike the underlying timer's `tick`.
  @override
  int get tick => _counted;
}

/// Whether a periodic timer's callback arrived after the process slept through at least one of its
/// periods: the VM skipped them, so [tick] moved by more than one since [previousTick].
bool sleptSinceTick(Timer timer, int previousTick) =>
    timer.tick - previousTick > 1;

/// [Future.timeout], but counting only awake time (see [SleepAwareTimer]).
Future<T> awakeTimeout<T>(
  Future<T> future,
  Duration timeout, {
  required T Function() onTimeout,
}) {
  final result = Completer<T>();
  final timer = SleepAwareTimer(timeout, () {
    if (result.isCompleted) return;
    try {
      result.complete(onTimeout());
    } catch (error, stack) {
      result.completeError(error, stack);
    }
  });
  future.then(
    (value) {
      timer.cancel();
      if (!result.isCompleted) result.complete(value);
    },
    onError: (Object error, StackTrace stack) {
      timer.cancel();
      if (!result.isCompleted) result.completeError(error, stack);
    },
  );
  return result.future;
}
