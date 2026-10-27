import 'dart:async';
import 'dart:math' as math;

/// The pace of the machine-list reads a browser makes on its own while it hears no push
/// ([AppNotifier]'s deaf watch): soon at first, then less often the longer nothing changes.
///
/// One timer, always armed while it runs. A tick reads when [wanted] says so and moves one step
/// along [pace]; a tick that does not read (the tab hidden, a computer connected, recovery asking
/// instead) goes back to the first step, so the wait starts over the moment reading is wanted
/// again. [reset] does the same from outside: a push, the tab coming back, the person's Retry.
class MachineListWatch {
  MachineListWatch({
    required this.wanted,
    required this.read,
    required this.pace,
  });

  /// Whether a tick should read now.
  final bool Function() wanted;
  final void Function() read;

  /// The waits between reads; the last one repeats. Asked at every step, so it may change
  /// between them.
  final List<Duration> Function() pace;

  Timer? _timer;
  int _step = 0;

  bool get running => _timer != null;

  void start() => _timer ??= Timer(_wait, _tick);

  void stop() {
    _timer?.cancel();
    _timer = null;
    _step = 0;
  }

  /// The next read comes after the first wait again.
  void reset() {
    _step = 0;
    if (_timer == null) return;
    _timer!.cancel();
    _timer = Timer(_wait, _tick);
  }

  Duration get _wait {
    final steps = pace();
    return steps[math.min(_step, steps.length - 1)];
  }

  void _tick() {
    if (wanted()) {
      read();
      _step++;
    } else {
      _step = 0;
    }
    _timer = Timer(_wait, _tick);
  }
}
