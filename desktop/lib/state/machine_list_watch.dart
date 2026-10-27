import 'dart:async';
import 'dart:math' as math;

/// The pace of the machine-list reads a browser makes on its own while it hears no push
/// ([AppNotifier]'s deaf watch): soon at first, then less often the longer nothing changes.
///
/// One timer at a time. A tick reads when [wanted] says so and moves one step along [pace]; a tick
/// that does not read (the tab hidden, a computer connected, recovery asking instead) goes back to
/// the first step, so the wait starts over the moment reading is wanted again. [reset] does the
/// same from outside: a push, the tab coming back, the person's Retry.
class MachineListWatch {
  MachineListWatch({
    required this.wanted,
    required this.read,
    required this.pace,
  });

  /// Whether a tick should read now.
  final bool Function() wanted;
  final Future<void> Function() read;

  /// The waits between reads; the last one repeats. Asked once a read has finished, not while it
  /// is open, since the read itself changes what the screen shows (the list loading).
  final List<Duration> Function() pace;

  Timer? _timer;
  int _step = 0;
  bool _running = false;

  /// Bumped by [stop], so a read still open from before cannot arm a timer after it.
  int _generation = 0;

  bool get running => _running;

  void start() {
    if (_running) return;
    _running = true;
    _schedule();
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    _running = false;
    _step = 0;
    _generation++;
  }

  /// The next read comes after the first wait again.
  void reset() {
    _step = 0;
    final timer = _timer;
    // No timer: a read is open, and it schedules from the first wait when it ends.
    if (timer == null) return;
    timer.cancel();
    _schedule();
  }

  void _schedule() {
    final steps = pace();
    _timer = Timer(steps[math.min(_step, steps.length - 1)], _tick);
  }

  Future<void> _tick() async {
    _timer = null;
    final generation = _generation;
    if (wanted()) {
      _step++;
      try {
        await read();
      } catch (_) {
        // A failed read is the reader's to report; the pace goes on.
      }
    } else {
      _step = 0;
    }
    if (generation == _generation) _schedule();
  }
}
