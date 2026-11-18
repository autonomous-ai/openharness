// The demo's time: a clock and one-shot timers on it. The app runs it on real timers; tests drive one by hand, so the
// whole story plays in an instant and the same way every time.
import 'dart:async';

/// A timer set on a [DemoClock].
abstract interface class DemoTimer {
  void cancel();
}

abstract interface class DemoClock {
  /// Milliseconds since the clock began; never goes back.
  int get nowMs;

  /// Runs [fn] once at [ms] on this clock (as soon as it can when that has passed).
  DemoTimer at(int ms, void Function() fn);
}

/// Real time: a stopwatch, and dart:async timers.
class RealDemoClock implements DemoClock {
  final Stopwatch _watch = Stopwatch()..start();

  @override
  int get nowMs => _watch.elapsedMilliseconds;

  @override
  DemoTimer at(int ms, void Function() fn) {
    final wait = ms - nowMs;
    return _RealTimer(Timer(Duration(milliseconds: wait > 0 ? wait : 0), fn));
  }
}

class _RealTimer implements DemoTimer {
  _RealTimer(this._timer);
  final Timer _timer;

  @override
  void cancel() => _timer.cancel();
}
